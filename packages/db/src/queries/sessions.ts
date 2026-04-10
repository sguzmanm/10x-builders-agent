import type { DbClient } from "../client";
import type { AgentSession, Channel } from "@agents/types";

export async function createSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data, error } = await db
    .from("agent_sessions")
    .insert({
      user_id: userId,
      channel,
      status: "active",
      budget_tokens_used: 0,
      budget_tokens_limit: 100000,
    })
    .select()
    .single();
  if (error) throw error;
  return data as AgentSession;
}

export async function getActiveSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const { data } = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as AgentSession | null;
}

export async function getOrCreateSession(
  db: DbClient,
  userId: string,
  channel: Channel
) {
  const existing = await getActiveSession(db, userId, channel);
  if (existing) return existing;
  return createSession(db, userId, channel);
}

export async function updateSessionTokens(
  db: DbClient,
  sessionId: string,
  tokensUsed: number
) {
  const { error } = await db
    .from("agent_sessions")
    .update({
      budget_tokens_used: tokensUsed,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}

export async function getSessionToolState(
  db: DbClient,
  sessionId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("agent_sessions")
    .select("tool_state")
    .eq("id", sessionId)
    .single();
  if (error) throw error;
  const raw = (data as { tool_state?: unknown } | null)?.tool_state;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export function getBashCwdFromToolState(
  toolState: Record<string, unknown>,
  terminalId: string
): string | undefined {
  const bash = toolState.bash as Record<string, unknown> | undefined;
  const terminals = bash?.terminals as Record<string, { cwd?: string }> | undefined;
  const cwd = terminals?.[terminalId]?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

export async function getBashTerminalCwd(
  db: DbClient,
  sessionId: string,
  terminalId: string
): Promise<string | undefined> {
  const toolState = await getSessionToolState(db, sessionId);
  return getBashCwdFromToolState(toolState, terminalId);
}

export async function setBashTerminalCwd(
  db: DbClient,
  sessionId: string,
  terminalId: string,
  cwd: string
): Promise<void> {
  const prev = await getSessionToolState(db, sessionId);
  const bash = (prev.bash as Record<string, unknown>) ?? {};
  const terminals = (bash.terminals as Record<string, { cwd: string }>) ?? {};
  const next: Record<string, unknown> = {
    ...prev,
    bash: {
      ...bash,
      terminals: {
        ...terminals,
        [terminalId]: { cwd },
      },
    },
  };
  const { error } = await db
    .from("agent_sessions")
    .update({
      tool_state: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId);
  if (error) throw error;
}
