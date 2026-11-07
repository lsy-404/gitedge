ALTER TABLE actions_runners ADD COLUMN hosted_job_kind TEXT CHECK (hosted_job_kind IN ('gitedge', 'github'));
ALTER TABLE actions_runners ADD COLUMN hosted_job_id TEXT;
ALTER TABLE actions_runners ADD COLUMN expires_at INTEGER;

CREATE TABLE actions_hosted_runner_dispatches (
  id TEXT PRIMARY KEY,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('gitedge', 'github')),
  job_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  connection_id TEXT NOT NULL REFERENCES forge_github_connections(id),
  bootstrap_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'dispatched', 'consumed', 'failed', 'cancel_pending', 'cancelled')),
  github_run_id TEXT,
  github_repository_id TEXT,
  github_repository TEXT,
  github_workflow_ref TEXT,
  github_workflow_sha TEXT,
  runner_id TEXT REFERENCES actions_runners(id),
  error_code TEXT,
  UNIQUE(job_kind, job_id)
);
