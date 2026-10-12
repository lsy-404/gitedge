CREATE TABLE repository_branch_rules_new (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  target TEXT NOT NULL DEFAULT 'branch' CHECK (target IN ('branch', 'tag')),
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 0,
  require_passing_checks INTEGER NOT NULL DEFAULT 0,
  required_status_checks TEXT NOT NULL DEFAULT '[]',
  require_linear_history INTEGER NOT NULL DEFAULT 0,
  require_signed_commits INTEGER NOT NULL DEFAULT 0,
  require_conversation_resolution INTEGER NOT NULL DEFAULT 0,
  require_merge_queue INTEGER NOT NULL DEFAULT 0 CHECK (require_merge_queue IN (0, 1)),
  forbid_tag_update INTEGER NOT NULL DEFAULT 0 CHECK (forbid_tag_update IN (0, 1)),
  forbid_tag_deletion INTEGER NOT NULL DEFAULT 0 CHECK (forbid_tag_deletion IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository_id, target, pattern),
  CHECK (target != 'tag' OR forbid_tag_update = 1 OR forbid_tag_deletion = 1)
);
INSERT INTO repository_branch_rules_new (id,repository_id,pattern,enabled,locked,required_approvals,require_passing_checks,required_status_checks,require_linear_history,require_signed_commits,require_conversation_resolution,require_merge_queue,created_at,updated_at)
SELECT id,repository_id,pattern,enabled,locked,required_approvals,require_passing_checks,required_status_checks,require_linear_history,require_signed_commits,require_conversation_resolution,require_merge_queue,created_at,updated_at FROM repository_branch_rules;
DROP TABLE repository_branch_rules;
ALTER TABLE repository_branch_rules_new RENAME TO repository_branch_rules;
