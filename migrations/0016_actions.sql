CREATE TABLE actions_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  commit_oid TEXT NOT NULL,
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  check_last_attempt_at INTEGER,
  check_status TEXT CHECK (check_status IS NULL OR check_status IN ('queued', 'in_progress', 'completed')),
  check_conclusion TEXT CHECK (check_conclusion IS NULL OR check_conclusion IN ('success', 'failure', 'cancelled')),
  check_published_at INTEGER
);

CREATE INDEX actions_runs_repository_created
  ON actions_runs (repository_id, created_at DESC);

CREATE INDEX actions_runs_check_pending
  ON actions_runs (check_last_attempt_at, created_at)
  WHERE check_published_at IS NULL;
