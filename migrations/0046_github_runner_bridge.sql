ALTER TABLE forge_github_connections ADD COLUMN runner_enabled INTEGER NOT NULL DEFAULT 0 CHECK (runner_enabled IN (0, 1));

CREATE TABLE actions_github_runner_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  github_job_id INTEGER NOT NULL,
  github_run_id INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed')),
  runner_id TEXT REFERENCES actions_runners(id) ON DELETE SET NULL,
  github_runner_id INTEGER,
  lease_hash TEXT,
  lease_expires_at INTEGER,
  assigned INTEGER NOT NULL DEFAULT 0 CHECK (assigned IN (0, 1)),
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1)),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'cancelled')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  UNIQUE (connection_id, github_job_id)
);
CREATE INDEX actions_github_runner_queue ON actions_github_runner_jobs(status, created_at);
CREATE INDEX actions_github_runner_cleanup ON actions_github_runner_jobs(cleanup_pending);
