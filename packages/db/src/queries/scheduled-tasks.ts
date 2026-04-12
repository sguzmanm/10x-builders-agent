import type { DbClient } from "../client";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduleType,
} from "@agents/types";

export interface CreateScheduledTaskInput {
  userId: string;
  prompt: string;
  scheduleType: ScheduleType;
  runAt?: string;
  cronExpr?: string;
  timezone?: string;
  nextRunAt: string;
}

export async function createScheduledTask(
  db: DbClient,
  input: CreateScheduledTaskInput
): Promise<ScheduledTask> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id: input.userId,
      prompt: input.prompt,
      schedule_type: input.scheduleType,
      run_at: input.runAt ?? null,
      cron_expr: input.cronExpr ?? null,
      timezone: input.timezone ?? "UTC",
      status: "active",
      next_run_at: input.nextRunAt,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTask;
}

/** Returns tasks whose next_run_at has passed and are still active. */
export async function getPendingScheduledTasks(
  db: DbClient
): Promise<ScheduledTask[]> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

/**
 * Atomically marks a task as running.
 * Returns the updated task, or null if the task was already taken (another runner got it).
 */
export async function markTaskRunning(
  db: DbClient,
  taskId: string
): Promise<ScheduledTask | null> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("status", "active")
    .select()
    .single();
  if (error) return null;
  return data as ScheduledTask;
}

export async function createTaskRun(
  db: DbClient,
  taskId: string
): Promise<ScheduledTaskRun> {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({ task_id: taskId, status: "running" })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTaskRun;
}

export async function completeTaskRun(
  db: DbClient,
  runId: string,
  agentSessionId: string | null,
  notified: boolean,
  notifySkippedReason?: string
): Promise<void> {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      agent_session_id: agentSessionId,
      notified,
      notify_skipped_reason: notifySkippedReason ?? null,
    })
    .eq("id", runId);
  if (error) throw error;
}

export async function failTaskRun(
  db: DbClient,
  runId: string,
  errorMessage: string
): Promise<void> {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      status: "failed",
      finished_at: new Date().toISOString(),
      error: errorMessage,
    })
    .eq("id", runId);
  if (error) throw error;
}

/** Marks a one-time task as completed after it runs. */
export async function completeOneTimeTask(
  db: DbClient,
  taskId: string,
  lastRunAt: string
): Promise<void> {
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "completed",
      last_run_at: lastRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
}

/** Re-activates a recurring task with the next scheduled run time. */
export async function rescheduleRecurringTask(
  db: DbClient,
  taskId: string,
  nextRunAt: string,
  lastRunAt: string
): Promise<void> {
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "active",
      last_run_at: lastRunAt,
      next_run_at: nextRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
}

export async function markTaskFailed(
  db: DbClient,
  taskId: string,
  lastRunAt: string
): Promise<void> {
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "failed",
      last_run_at: lastRunAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
}

export async function getUserScheduledTasks(
  db: DbClient,
  userId: string
): Promise<ScheduledTask[]> {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}
