ALTER TABLE repositories ADD COLUMN actions_runner_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actions_runs ADD COLUMN executor TEXT NOT NULL DEFAULT 'container'
  CHECK (executor IN ('container', 'runner'));

CREATE TABLE actions_runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  labels_json TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX actions_runners_owner ON actions_runners(created_by, created_at DESC);
CREATE INDEX actions_runners_scope ON actions_runners(namespace_id, repository_id, revoked_at);

CREATE TABLE actions_runner_runs (
  run_id TEXT PRIMARY KEY REFERENCES actions_runs(id) ON DELETE CASCADE,
  workflow_source TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write')),
  timeout_minutes INTEGER NOT NULL CHECK (timeout_minutes BETWEEN 1 AND 360),
  event_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed')),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'cancelled')),
  runner_id TEXT REFERENCES actions_runners(id) ON DELETE SET NULL,
  lease_hash TEXT,
  lease_expires_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '',
  log_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX actions_runner_queue ON actions_runner_runs(status, run_id);
CREATE INDEX actions_runner_lease ON actions_runner_runs(runner_id, status, lease_expires_at);

CREATE TABLE actions_job_tokens (
  run_id TEXT PRIMARY KEY REFERENCES actions_runner_runs(run_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
