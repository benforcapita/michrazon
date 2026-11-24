-- 0003_pipeline_runs_task.sql — sub-task label for pipeline_runs.
-- Digest build/send/retry (and future multi-step jobs) share run_kind;
-- `task` gives each its own idempotency slot without abusing source_id
-- (which is FK'd to sources).
alter table pipeline_runs add column if not exists task text;
create index if not exists pipeline_runs_task on pipeline_runs(kind, task, finished_at);
