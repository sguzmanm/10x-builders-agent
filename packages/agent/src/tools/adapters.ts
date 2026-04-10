import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(
  toolId: string,
  ctx: ToolContext
): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_repos", input, false
          );
          if (!ctx.githubToken) {
            const err = { error: "GitHub not connected. Please connect GitHub from Settings." };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const res = await githubApi(ctx.githubToken, `/user/repos?per_page=${input.per_page}&sort=updated`);
          if (!res.ok) {
            const err = { error: `GitHub API error: ${res.status}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const repos = (await res.json()).map((r: Record<string, unknown>) => ({
            full_name: r.full_name,
            description: r.description,
            html_url: r.html_url,
            private: r.private,
            language: r.language,
            updated_at: r.updated_at,
          }));
          const result = { repos };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_issues", input, false
          );
          if (!ctx.githubToken) {
            const err = { error: "GitHub not connected. Please connect GitHub from Settings." };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const res = await githubApi(ctx.githubToken, `/repos/${input.owner}/${input.repo}/issues?state=${input.state}`);
          if (!res.ok) {
            const err = { error: `GitHub API error: ${res.status}` };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
          const issues = (await res.json()).map((i: Record<string, unknown>) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            created_at: i.created_at,
          }));
          const result = { issues };
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub not connected." });
          }
          const result = await executeGitHubCreateIssue(ctx.githubToken, input);
          return JSON.stringify(result);
        },
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubToken) {
            return JSON.stringify({ error: "GitHub not connected." });
          }
          const result = await executeGitHubCreateRepo(ctx.githubToken, input);
          return JSON.stringify(result);
        },
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            private: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  console.log("Places API is available", isToolAvailable("places_search", ctx));

  if (isToolAvailable("places_search", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "places_search", input, false
          );
          try {
            const res = await placesApi("/places:searchText", {
              method: "POST",
              fieldMask: "places.id,places.displayName,places.formattedAddress,places.rating,places.googleMapsUri",
              body: JSON.stringify({
                textQuery: input.query,
                languageCode: input.language,
                pageSize: input.max_results,
              }),
            });

            if (!res.ok) {
              const err = { error: `Places API error: ${res.status}` };
              await updateToolCallStatus(ctx.db, record.id, "failed", err);
              return JSON.stringify(err);
            }

            const data = await res.json();
            const places = (data.places ?? []).map((p: Record<string, unknown>) => ({
              id: p.id,
              name: (p.displayName as Record<string, unknown>)?.text,
              address: p.formattedAddress,
              rating: p.rating,
              maps_url: p.googleMapsUri,
            }));
            const result = { places };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            console.log("Places API result", result);
            return JSON.stringify(result);
          } catch (e) {
            const err = { error: e instanceof Error ? e.message : "Unknown error" };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
        },
        {
          name: "places_search",
          description: "Searches for places matching a text query and returns names, addresses, and ratings.",
          schema: z.object({
            query: z.string(),
            language: z.string().nullable().optional().default("es"),
            max_results: z.number().min(1).max(20).nullable().optional().default(5),
          }),
        }
      )
    );
  }

  if (isToolAvailable("places_detail", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "places_detail", input, false
          );
          try {
            const res = await placesApi(`/places/${input.place_id}`, {
              fieldMask: "id,displayName,formattedAddress,rating,userRatingCount,types,nationalPhoneNumber,websiteUri,googleMapsUri,regularOpeningHours,editorialSummary",
              body: undefined,
            });
            if (!res.ok) {
              const err = { error: `Places API error: ${res.status}` };
              await updateToolCallStatus(ctx.db, record.id, "failed", err);
              return JSON.stringify(err);
            }
            const p = await res.json();
            const result = {
              id: p.id,
              name: p.displayName?.text,
              address: p.formattedAddress,
              rating: p.rating,
              total_ratings: p.userRatingCount,
              phone: p.nationalPhoneNumber,
              website: p.websiteUri,
              maps_url: p.googleMapsUri,
              types: p.types,
              hours: p.regularOpeningHours?.weekdayDescriptions?.join(", "),
              summary: p.editorialSummary?.text,
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (e) {
            const err = { error: e instanceof Error ? e.message : "Unknown error" };
            await updateToolCallStatus(ctx.db, record.id, "failed", err);
            return JSON.stringify(err);
          }
        },
        {
          name: "places_detail",
          description: "Returns detailed information about a place by its ID, including description and a Google Maps link.",
          schema: z.object({
            place_id: z.string(),
            language: z.string().nullable().optional().default("es"),
          }),
        }
      )
    );
  }

  return tools;
}

const PLACES_API = "https://places.googleapis.com/v1";

function placesApi(path: string, opts: { method?: string; body?: string; fieldMask: string }) {
  console.log("Calling Places API");
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY not set");
  return fetch(`${PLACES_API}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": opts.fieldMask,
      "Content-Type": "application/json",
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
}

const GITHUB_API = "https://api.github.com";

function githubApi(token: string, path: string, init?: RequestInit) {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
}

export async function executeGitHubCreateIssue(
  token: string,
  input: { owner: string; repo: string; title: string; body?: string }
) {
  const res = await githubApi(token, `/repos/${input.owner}/${input.repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: input.title, body: input.body ?? "" }),
  });
  if (!res.ok) {
    return { error: `GitHub API error: ${res.status}` };
  }
  const issue = await res.json();
  return { message: "Issue created", issue_url: issue.html_url, number: issue.number };
}

export async function executeGitHubCreateRepo(
  token: string,
  input: { name: string; description?: string; private?: boolean }
) {
  const res = await githubApi(token, "/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      description: input.description ?? "",
      private: input.private ?? false,
    }),
  });
  if (!res.ok) {
    return { error: `GitHub API error: ${res.status}` };
  }
  const repo = await res.json();
  return { message: "Repository created", html_url: repo.html_url, full_name: repo.full_name };
}
