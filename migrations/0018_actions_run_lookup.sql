CREATE INDEX actions_runs_latest_for_check
  ON actions_runs (repository_id, path, commit_oid, source_ref, created_at DESC, id DESC);

CREATE INDEX actions_runs_head_history
  ON actions_runs (repository_id, source_ref, created_at DESC, id DESC);
