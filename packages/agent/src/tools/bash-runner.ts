import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface BashRunInput {
  cwd: string;
  prompt: string;
}

export interface BashRunResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  cwd_after?: string;
  truncated?: boolean;
  error?: string;
}

function parseDefaultInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripPwdMarker(stdout: string, marker: string): { out: string; cwd?: string } {
  const lines = stdout.split(/\r?\n/);
  const i = lines.lastIndexOf(marker);
  if (i < 0) {
    return { out: stdout };
  }
  const cwd = lines[i + 1]?.trim();
  const before = lines.slice(0, i).join("\n").replace(/\s*$/, "");
  return { out: before, cwd: cwd && cwd.length > 0 ? cwd : undefined };
}

export async function runBashCommand(input: BashRunInput): Promise<BashRunResult> {
  if (process.env.AGENT_BASH_DISABLED === "true") {
    return {
      stdout: "",
      stderr: "",
      exit_code: null,
      error: "bash tool is disabled (AGENT_BASH_DISABLED=true).",
    };
  }

  const timeoutMs = parseDefaultInt(process.env.AGENT_BASH_TIMEOUT_MS, 30_000);
  const maxOutputBytes = parseDefaultInt(process.env.AGENT_BASH_MAX_OUTPUT_BYTES, 512_000);

  const marker = `__BASH_TOOL_PWD__${randomUUID()}__`;
  let delim = `BASH_TOOL_HEREDOC_${randomUUID().replace(/-/g, "_")}`;
  while (input.prompt.includes(delim)) {
    delim = `BASH_TOOL_HEREDOC_${randomUUID().replace(/-/g, "_")}`;
  }

  const script = `set +e
eval "$(cat <<'${delim}'
${input.prompt}
${delim}
)"
_st=$?
echo ""
printf '%s\\n' "$BASH_TOOL_MARKER"
printf '%s\\n' "$(pwd)"
exit $_st
`;

  return new Promise((resolve) => {
    let settled = false;
    function finish(result: BashRunResult) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    const child = spawn("bash", ["-lc", script], {
      cwd: input.cwd,
      env: { ...process.env, BASH_TOOL_MARKER: marker },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let totalBytes = 0;

    function addChunk(kind: "stdout" | "stderr", chunk: Buffer) {
      if (truncated) return;
      const s = chunk.toString("utf8");
      totalBytes += Buffer.byteLength(s, "utf8");
      if (totalBytes > maxOutputBytes) {
        truncated = true;
        const msg = `\n[output truncated at ${maxOutputBytes} bytes]\n`;
        if (kind === "stdout") stdout += msg;
        else stderr += msg;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        return;
      }
      if (kind === "stdout") stdout += s;
      else stderr += s;
    }

    child.stdout?.on("data", (chunk: Buffer) => addChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => addChunk("stderr", chunk));

    child.on("error", (err) => {
      finish({
        stdout,
        stderr,
        exit_code: null,
        truncated,
        error: err.message,
      });
    });

    child.on("close", (code, signal) => {
      const { out, cwd } = stripPwdMarker(stdout, marker);
      const exitCode = signal ? null : code;
      finish({
        stdout: out,
        stderr,
        exit_code: exitCode,
        cwd_after: cwd,
        truncated,
      });
    });
  });
}
