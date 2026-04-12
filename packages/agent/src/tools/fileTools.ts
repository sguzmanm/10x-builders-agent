import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_MAX_READ_LINES = 4000;
const DEFAULT_MAX_READ_CHARS = 200_000;
const DEFAULT_MAX_EXPLICIT_LIMIT = 10_000;

type ToolName = "read_file" | "write_file" | "edit_file";

interface ToolError {
  code: string;
  message: string;
}

interface ToolFailure {
  ok: false;
  tool: ToolName;
  path?: string;
  error: ToolError;
}

interface ToolSuccessBase {
  ok: true;
  tool: ToolName;
  path: string;
}

interface ResolveResult {
  root: string;
  resolvedPath: string;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildFailure(tool: ToolName, error: ToolError, requestedPath?: string): ToolFailure {
  return {
    ok: false,
    tool,
    path: requestedPath,
    error,
  };
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveRoot(): Promise<{ ok: true; root: string } | { ok: false; error: ToolError }> {
  if (process.env.FILE_TOOLS_ENABLED === "false") {
    return {
      ok: false,
      error: {
        code: "TOOL_DISABLED",
        message: "File tools are disabled by configuration (FILE_TOOLS_ENABLED=false).",
      },
    };
  }

  const configuredRoot = process.env.AGENT_BASH_INITIAL_CWD && process.env.AGENT_BASH_INITIAL_CWD.length > 0
    ? process.env.AGENT_BASH_INITIAL_CWD
    : process.cwd();
  const absoluteRoot = path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(process.cwd(), configuredRoot);

  try {
    const rootReal = await fs.realpath(absoluteRoot);
    return { ok: true, root: rootReal };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INVALID_ROOT",
        message: error instanceof Error
          ? `Cannot access file tools root: ${error.message}`
          : "Cannot access file tools root.",
      },
    };
  }
}

async function resolveSafePath(
  userPath: string
): Promise<{ ok: true; value: ResolveResult } | { ok: false; error: ToolError; requestedPath?: string }> {
  const rootResult = await resolveRoot();
  if (!rootResult.ok) {
    return { ok: false, error: rootResult.error, requestedPath: userPath };
  }

  const trimmed = userPath.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_PATH", message: "Path cannot be empty." },
      requestedPath: userPath,
    };
  }

  if (path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error: { code: "INVALID_PATH", message: "Path must be relative to the workspace root." },
      requestedPath: userPath,
    };
  }

  const resolvedPath = path.resolve(rootResult.root, trimmed);
  if (!isPathInsideRoot(rootResult.root, resolvedPath)) {
    return {
      ok: false,
      error: { code: "PATH_OUTSIDE_ROOT", message: "Path resolves outside of the workspace root." },
      requestedPath: resolvedPath,
    };
  }

  return {
    ok: true,
    value: {
      root: rootResult.root,
      resolvedPath,
    },
  };
}

async function ensureExistingPathInsideRoot(root: string, resolvedPath: string): Promise<ToolError | null> {
  try {
    const actual = await fs.realpath(resolvedPath);
    if (!isPathInsideRoot(root, actual)) {
      return {
        code: "PATH_OUTSIDE_ROOT",
        message: "Resolved file points outside of the workspace root.",
      };
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { code: "FILE_NOT_FOUND", message: "File does not exist." };
    }
    return {
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : "Unable to resolve path.",
    };
  }
}

async function ensureParentInsideRoot(root: string, resolvedPath: string): Promise<ToolError | null> {
  const parentDir = path.dirname(resolvedPath);
  try {
    const parentReal = await fs.realpath(parentDir);
    if (!isPathInsideRoot(root, parentReal)) {
      return {
        code: "PATH_OUTSIDE_ROOT",
        message: "Parent directory points outside of the workspace root.",
      };
    }
    return null;
  } catch (error) {
    return {
      code: "IO_ERROR",
      message: error instanceof Error ? error.message : "Unable to resolve parent directory.",
    };
  }
}

export async function executeReadFile(input: {
  path: string;
  offset?: number;
  limit?: number;
}): Promise<ToolFailure | (ToolSuccessBase & {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
})> {
  const tool: ToolName = "read_file";
  const safe = await resolveSafePath(input.path);
  if (!safe.ok) {
    return buildFailure(tool, safe.error, safe.requestedPath);
  }

  const { root, resolvedPath } = safe.value;
  const outsideError = await ensureExistingPathInsideRoot(root, resolvedPath);
  if (outsideError) {
    return buildFailure(tool, outsideError, resolvedPath);
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return buildFailure(tool, { code: "NOT_A_FILE", message: "Path is not a regular file." }, resolvedPath);
    }

    const raw = await fs.readFile(resolvedPath, "utf8");
    if (raw.includes("\u0000")) {
      return buildFailure(tool, { code: "BINARY_FILE", message: "Binary files are not supported." }, resolvedPath);
    }

    const maxDefaultLines = parsePositiveIntEnv("FILE_TOOLS_MAX_READ_LINES", DEFAULT_MAX_READ_LINES);
    const maxReadChars = parsePositiveIntEnv("FILE_TOOLS_MAX_READ_CHARS", DEFAULT_MAX_READ_CHARS);
    const maxExplicitLimit = parsePositiveIntEnv("FILE_TOOLS_MAX_EXPLICIT_LIMIT", DEFAULT_MAX_EXPLICIT_LIMIT);

    const startLine = input.offset ?? 1;
    if (!Number.isInteger(startLine) || startLine < 1) {
      return buildFailure(
        tool,
        { code: "INVALID_OFFSET", message: "offset must be a positive integer (1-based)." },
        resolvedPath
      );
    }

    let requestedLimit = input.limit;
    if (requestedLimit !== undefined) {
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
        return buildFailure(
          tool,
          { code: "INVALID_LIMIT", message: "limit must be a positive integer." },
          resolvedPath
        );
      }
      if (requestedLimit > maxExplicitLimit) {
        return buildFailure(
          tool,
          {
            code: "LIMIT_TOO_LARGE",
            message: `limit exceeds maximum allowed (${maxExplicitLimit}).`,
          },
          resolvedPath
        );
      }
    } else {
      requestedLimit = maxDefaultLines;
    }

    const lines = raw.split(/\r?\n/);
    const totalLines = lines.length;
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = startIdx + requestedLimit;
    const selected = lines.slice(startIdx, endIdx);

    let content = selected.join("\n");
    let truncated = endIdx < totalLines;

    if (content.length > maxReadChars) {
      content = content.slice(0, maxReadChars);
      truncated = true;
    }

    const endLine = selected.length > 0 ? startLine + selected.length - 1 : startLine - 1;

    return {
      ok: true,
      tool,
      path: resolvedPath,
      content,
      startLine,
      endLine,
      totalLines,
      truncated,
    };
  } catch (error) {
    return buildFailure(
      tool,
      {
        code: "IO_ERROR",
        message: error instanceof Error ? error.message : "Unknown read_file error.",
      },
      safe.value.resolvedPath
    );
  }
}

export async function executeWriteFile(input: {
  path: string;
  content: string;
}): Promise<ToolFailure | (ToolSuccessBase & { bytesWritten: number })> {
  const tool: ToolName = "write_file";
  const safe = await resolveSafePath(input.path);
  if (!safe.ok) {
    return buildFailure(tool, safe.error, safe.requestedPath);
  }

  const { root, resolvedPath } = safe.value;

  try {
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  } catch (error) {
    return buildFailure(
      tool,
      { code: "IO_ERROR", message: error instanceof Error ? error.message : "Failed to create parent directory." },
      resolvedPath
    );
  }

  const parentError = await ensureParentInsideRoot(root, resolvedPath);
  if (parentError) {
    return buildFailure(tool, parentError, resolvedPath);
  }

  try {
    const handle = await fs.open(resolvedPath, "wx");
    try {
      await handle.writeFile(input.content, "utf8");
    } finally {
      await handle.close();
    }
    return {
      ok: true,
      tool,
      path: resolvedPath,
      bytesWritten: Buffer.byteLength(input.content, "utf8"),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return buildFailure(
        tool,
        {
          code: "FILE_EXISTS",
          message: "File already exists. Use edit_file to modify an existing file.",
        },
        resolvedPath
      );
    }
    return buildFailure(
      tool,
      { code: "IO_ERROR", message: error instanceof Error ? error.message : "Unknown write_file error." },
      resolvedPath
    );
  }
}

export async function executeEditFile(input: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<ToolFailure | (ToolSuccessBase & { replacements: number })> {
  const tool: ToolName = "edit_file";
  const safe = await resolveSafePath(input.path);
  if (!safe.ok) {
    return buildFailure(tool, safe.error, safe.requestedPath);
  }

  const { root, resolvedPath } = safe.value;
  const outsideError = await ensureExistingPathInsideRoot(root, resolvedPath);
  if (outsideError) {
    return buildFailure(tool, outsideError, resolvedPath);
  }

  if (input.old_string.length === 0) {
    return buildFailure(
      tool,
      { code: "INVALID_OLD_STRING", message: "old_string cannot be empty." },
      resolvedPath
    );
  }

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return buildFailure(tool, { code: "NOT_A_FILE", message: "Path is not a regular file." }, resolvedPath);
    }

    const original = await fs.readFile(resolvedPath, "utf8");
    if (original.includes("\u0000")) {
      return buildFailure(tool, { code: "BINARY_FILE", message: "Binary files are not supported." }, resolvedPath);
    }

    let count = 0;
    let idx = original.indexOf(input.old_string);
    while (idx !== -1) {
      count += 1;
      idx = original.indexOf(input.old_string, idx + input.old_string.length);
    }

    if (count === 0) {
      return buildFailure(
        tool,
        {
          code: "OLD_STRING_NOT_FOUND",
          message: "old_string was not found in file. Provide a more exact snippet.",
        },
        resolvedPath
      );
    }

    if (count > 1) {
      return buildFailure(
        tool,
        {
          code: "OLD_STRING_NOT_UNIQUE",
          message: `old_string matched ${count} times. Provide a unique snippet.`,
        },
        resolvedPath
      );
    }

    const updated = original.replace(input.old_string, input.new_string);
    const tempPath = `${resolvedPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tempPath, updated, "utf8");
    await fs.rename(tempPath, resolvedPath);

    return {
      ok: true,
      tool,
      path: resolvedPath,
      replacements: 1,
    };
  } catch (error) {
    return buildFailure(
      tool,
      { code: "IO_ERROR", message: error instanceof Error ? error.message : "Unknown edit_file error." },
      resolvedPath
    );
  }
}
