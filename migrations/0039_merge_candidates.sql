CREATE TABLE forge_merge_candidates (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('merge', 'squash', 'rebase')),
  source_ref TEXT NOT NULL,
  result_oid TEXT,
  expected_workflows TEXT NOT NULL DEFAULT '[]',
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queue_entered_at INTEGER NOT NULL,
  UNIQUE (pull_request_id, base_oid, head_oid, method, queue_entered_at)
);
ALTER TABLE actions_runs ADD COLUMN pull_request_id TEXT REFERENCES forge_pull_requests(id) ON DELETE CASCADE;
ALTER TABLE actions_runs ADD COLUMN candidate_id TEXT REFERENCES forge_merge_candidates(id) ON DELETE CASCADE;
ALTER TABLE actions_runs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'push';
CREATE UNIQUE INDEX actions_runs_candidate_workflow ON actions_runs(candidate_id, path) WHERE candidate_id IS NOT NULL;
