import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptToken,
  getIntegrationWithTokens,
} from "@agents/db";
import {
  executeGitHubCreateIssue,
  executeGitHubCreateRepo,
} from "@agents/agent";

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

    if (action === "reject") {
      await db
        .from("tool_calls")
        .update({ status: "rejected", finished_at: new Date().toISOString() })
        .eq("id", toolCallId);
      return NextResponse.json({ ok: true, status: "rejected" });
    }

    await db
      .from("tool_calls")
      .update({ status: "approved" })
      .eq("id", toolCallId);

    const toolName = toolCall.tool_name as string;
    const args = toolCall.arguments_json as Record<string, string>;

    const ghIntegration = await getIntegrationWithTokens(db, user.id, "github");
    if (!ghIntegration) {
      await db
        .from("tool_calls")
        .update({ status: "failed", result_json: { error: "GitHub not connected" }, finished_at: new Date().toISOString() })
        .eq("id", toolCallId);
      return NextResponse.json({ ok: false, error: "GitHub not connected" });
    }

    let githubToken: string;
    try {
      githubToken = decryptToken(ghIntegration.encrypted_tokens);
    } catch {
      await db
        .from("tool_calls")
        .update({ status: "failed", result_json: { error: "Token decryption failed" }, finished_at: new Date().toISOString() })
        .eq("id", toolCallId);
      return NextResponse.json({ ok: false, error: "Token decryption failed" });
    }

    let result: Record<string, unknown>;

    if (toolName === "github_create_issue") {
      result = await executeGitHubCreateIssue(githubToken, {
        owner: args.owner,
        repo: args.repo,
        title: args.title,
        body: args.body,
      });
    } else if (toolName === "github_create_repo") {
      result = await executeGitHubCreateRepo(githubToken, {
        name: args.name,
        description: args.description,
        private: args.private === "true",
      });
    } else {
      result = { error: `Unknown tool: ${toolName}` };
    }

    const hasError = "error" in result;
    await db
      .from("tool_calls")
      .update({
        status: hasError ? "failed" : "executed",
        result_json: result,
        finished_at: new Date().toISOString(),
      })
      .eq("id", toolCallId);

    return NextResponse.json({ ok: !hasError, result });
  } catch (error) {
    console.error("Confirm API error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
