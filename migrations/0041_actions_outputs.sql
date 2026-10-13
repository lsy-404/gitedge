ALTER TABLE actions_runs ADD COLUMN cache_key TEXT;
ALTER TABLE actions_runs ADD COLUMN lockfile_hash TEXT;
ALTER TABLE actions_runs ADD COLUMN cache_event_type TEXT;
ALTER TABLE actions_runs ADD COLUMN cache_status TEXT NOT NULL DEFAULT 'disabled'
  CHECK (cache_status IN ('disabled', 'miss', 'hit', 'saved', 'failed'));

CREATE TABLE actions_cache_entries (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  lockfile_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, cache_key)
);

CREATE TABLE actions_run_artifacts (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES actions_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);

CREATE INDEX actions_run_artifacts_repository_run
  ON actions_run_artifacts (repository_id, run_id);
