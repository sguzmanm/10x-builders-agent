import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Use esta herramienta cuando se quieran ejecutar comandos bash en el sistema operativo. " +
      "Ejecuta comandos en una terminal lógica por sesión (reutiliza el directorio de trabajo por id de terminal). " +
      "El entorno es Unix (p. ej. macOS en desarrollo). Riesgo alto: requiere confirmación.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Identificador de la terminal lógica (p. ej. default, frontend).",
        },
        prompt: { type: "string", description: "Comando o script bash a ejecutar." },
      },
      required: ["terminal", "prompt"],
    },
  },
  {
    id: "read_file",
    name: "read_file",
    description:
      "Reads an existing UTF-8 text file under the workspace root. " +
      "Use this to inspect code or text without changing files. " +
      "Do not use this to write files or list directories. " +
      "Parameters: path (relative), optional offset (1-based start line), optional limit (max lines). " +
      "Returns structured JSON with content and line metadata.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path under the workspace root.",
        },
        offset: {
          type: "number",
          description: "Optional 1-based start line (line 1 is first). Use 0 or omit to read from the beginning.",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of lines to return.",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new UTF-8 file under the workspace root with full content. " +
      "Fails if the file already exists; use edit_file for updates. " +
      "Requires confirmation because it mutates disk. " +
      "Returns structured JSON with bytes written or explicit error.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under the workspace root.",
        },
        content: {
          type: "string",
          description: "Full UTF-8 file content to create.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edits an existing UTF-8 file under the workspace root by replacing exactly one occurrence of old_string with new_string. " +
      "Fails when old_string matches zero or multiple times. " +
      "Requires confirmation because it mutates disk. " +
      "Returns structured JSON with replacement count or explicit error.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under the workspace root.",
        },
        old_string: {
          type: "string",
          description: "Exact substring to replace (must match once).",
        },
        new_string: {
          type: "string",
          description: "New substring content.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repo is private" },
      },
      required: ["name"],
    },
  },
  /*{
    id: "places_search",
    name: "places_search",
    description: "Searches for places matching a text query and returns names, addresses, and ratings.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        language: { type: "string", description: "Language code (default: es)" },
        max_results: { type: "number", description: "Max results 1-20 (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    id: "places_detail",
    name: "places_detail",
    description: "Returns detailed information about a place by its ID, including description and a Google Maps link.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        place_id: { type: "string", description: "Google Place ID from places_search" },
        language: { type: "string", description: "Language code (default: es)" },
      },
      required: ["place_id"],
    },
  },*/
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
