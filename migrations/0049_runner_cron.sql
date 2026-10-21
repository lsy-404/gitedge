CREATE TABLE actions_runner_schedules (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  workflow_oid TEXT NOT NULL,
  workflow_source TEXT NOT NULL,
  crons_json TEXT NOT NULL,
  next_run_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, path)
);
CREATE INDEX actions_runner_schedules_due ON actions_runner_schedules(next_run_at);
ALTER TABLE actions_runs ADD COLUMN scheduled_at INTEGER;
CREATE UNIQUE INDEX actions_runs_schedule_occurrence
  ON actions_runs(repository_id, path, scheduled_at) WHERE scheduled_at IS NOT NULL;
