import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getIntegrationWithTokens,
} from "@agents/db";
import { runAgent } from "@agents/agent";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { toolCallId, action } = await request.json();
    if (!toolCallId || !["approve", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: toolCall } = await db
      .from("tool_calls")
      .select("*, agent_sessions!inner(user_id)")
      .eq("id", toolCallId)
      .eq("status", "pending_confirmation")
      .single();

    if (!toolCall) {
      return NextResponse.json({ error: "Tool call not found or already resolved" }, { status: 404 });
    }

    const sessionOwner = (toolCall as Record<string, unknown> & { agent_sessions: { user_id: string } })
      .agent_sessions.user_id;
    if (sessionOwner !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: profile } = await db
      .from("profiles")
      .select("agent_system_prompt")
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await db
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await db
      .from("user_integrations")
      .select("*")
      .eq("user_id", user.id)
      .eq("status", "active");

    let githubToken: string | undefined;
    const ghIntegration = await getIntegrationWithTokens(db, user.id, "github");
    if (ghIntegration) {
      try {
        githubToken = decryptToken(ghIntegration.encrypted_tokens);
      } catch {
        // token decryption failed — treat as disconnected
      }
    }

    const result = await runAgent({
      resumeDecision: action === "approve" ? "approve" : "reject",
      userId: user.id,
      sessionId: toolCall.session_id as string,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubToken,
    });

    return NextResponse.json({ ok: true, response: result.response });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
