CREATE TABLE actions_signing_remote_operations (
  run_id TEXT NOT NULL REFERENCES actions_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, kind)
);
