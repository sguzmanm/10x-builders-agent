-- Per-session JSON for tool-owned state (e.g. bash logical terminals / cwd)
alter table public.agent_sessions
  add column if not exists tool_state jsonb not null default '{}'::jsonb;
