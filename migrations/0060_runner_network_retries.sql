CREATE TABLE actions_runner_network_retries (
  retry_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('gitedge', 'github')),
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  github_run_id INTEGER,
  source_job_id TEXT NOT NULL,
  source_runner_id TEXT REFERENCES actions_runners(id) ON DELETE SET NULL,
  source_lease_hash TEXT,
  failure_log TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'requested', 'failed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  requested_at INTEGER
);
CREATE UNIQUE INDEX actions_runner_network_retries_github
  ON actions_runner_network_retries(connection_id, github_run_id) WHERE kind='github';
CREATE INDEX actions_runner_network_retries_runner
  ON actions_runner_network_retries(source_runner_id, completed_at);
