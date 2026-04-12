import { NextResponse } from "next/server";
import { CronExpressionParser } from "cron-parser";
import {
  createServerClient,
  decryptToken,
  getIntegrationWithTokens,
  getPendingScheduledTasks,
  markTaskRunning,
  createTaskRun,
  completeTaskRun,
  failTaskRun,
  completeOneTimeTask,
  rescheduleRecurringTask,
  markTaskFailed,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { sendTelegramMessage } from "@/lib/telegram/send";
import type { ScheduledTask } from "@agents/types";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function computeNextRunAt(task: ScheduledTask): string {
  const interval = CronExpressionParser.parse(task.cron_expr!, {
    tz: task.timezone ?? "UTC",
  });
  return interval.next().toDate().toISOString();
}

async function runTask(db: ReturnType<typeof createServerClient>, task: ScheduledTask): Promise<void> {
  const now = new Date().toISOString();
  const run = await createTaskRun(db, task.id);

  let agentSessionId: string | null = null;
  let errorMessage: string | null = null;

  try {
    // Create a dedicated background session for this cron run
    const { data: session, error: sessionError } = await db
      .from("agent_sessions")
      .insert({
        user_id: task.user_id,
        channel: "web",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();

    if (sessionError || !session) {
      throw new Error(`Failed to create agent session: ${sessionError?.message}`);
    }

    agentSessionId = session.id;

    // Load user context
    const { data: profile } = await db
      .from("profiles")
      .select("agent_system_prompt")
      .eq("id", task.user_id)
      .single();

    const { data: toolSettings } = await db
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", task.user_id);

    const { data: integrations } = await db
      .from("user_integrations")
      .select("*")
      .eq("user_id", task.user_id)
      .eq("status", "active");

    const ghIntegration = await getIntegrationWithTokens(db, task.user_id, "github");
    let githubToken: string | undefined;
    if (ghIntegration) {
      try {
        githubToken = decryptToken(ghIntegration.encrypted_tokens);
      } catch {
        // token decryption failed — treat as disconnected
      }
    }

    await runAgent({
      message: task.prompt,
      userId: task.user_id,
      sessionId: session.id,
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
  } catch (e) {
    errorMessage = (e as Error).message;
    console.error(`[cron] task ${task.id} failed:`, e);
  }

  // Reschedule or complete the task
  if (errorMessage) {
    await failTaskRun(db, run.id, errorMessage);
    await markTaskFailed(db, task.id, now);
    return;
  }

  if (task.schedule_type === "one_time") {
    await completeOneTimeTask(db, task.id, now);
  } else {
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRunAt(task);
    } catch {
      nextRunAt = new Date(Date.now() + 60_000).toISOString();
    }
    await rescheduleRecurringTask(db, task.id, nextRunAt, now);
  }

  // Telegram notification — non-blocking, never fails the run
  let notified = false;
  let notifySkippedReason: string | undefined;

  try {
    const { data: telegramAccount } = await db
      .from("telegram_accounts")
      .select("chat_id")
      .eq("user_id", task.user_id)
      .single();

    if (telegramAccount?.chat_id) {
      const label =
        task.schedule_type === "one_time"
          ? "Tarea programada ejecutada"
          : "Tarea recurrente ejecutada";
      const promptPreview =
        task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt;
      await sendTelegramMessage(
        telegramAccount.chat_id as number,
        `✅ ${label}:\n"${promptPreview}"`
      );
      notified = true;
    } else {
      notifySkippedReason = "no_telegram_link";
    }
  } catch (e) {
    console.error(`[cron] telegram notify failed for task ${task.id}:`, e);
    notifySkippedReason = "telegram_error";
  }

  await completeTaskRun(db, run.id, agentSessionId, notified, notifySkippedReason);
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!CRON_SECRET || token !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const tasks = await getPendingScheduledTasks(db);

  if (tasks.length === 0) {
    return NextResponse.json({ ran: 0 });
  }

  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      // Atomically claim the task — skip if another runner already picked it up
      const claimed = await markTaskRunning(db, task.id);
      if (!claimed) return { taskId: task.id, skipped: true };
      await runTask(db, task);
      return { taskId: task.id, skipped: false };
    })
  );

  const ran = results.filter(
    (r) => r.status === "fulfilled" && !(r.value as { skipped: boolean }).skipped
  ).length;

  return NextResponse.json({ ran, total: tasks.length });
}
