ALTER TABLE repository_branch_rules ADD COLUMN require_merge_queue INTEGER NOT NULL DEFAULT 0 CHECK (require_merge_queue IN (0, 1));

CREATE TABLE forge_auto_merges (
  pull_request_id TEXT PRIMARY KEY NOT NULL REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  enabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('merge', 'squash', 'rebase')),
  expected_head_oid TEXT NOT NULL,
  enabled_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_forge_auto_merges_repository ON forge_auto_merges(repository_id);
CREATE INDEX idx_forge_auto_merges_sweep ON forge_auto_merges(checked_at);

CREATE TABLE forge_merge_queues (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  base_ref TEXT NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repository_id, base_ref)
);
CREATE INDEX idx_forge_merge_queues_sweep ON forge_merge_queues(checked_at);

CREATE TABLE forge_notifications_next (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'pull_request', 'discussion', 'repository')),
  subject_id TEXT NOT NULL,
  subject_number INTEGER,
  reason TEXT NOT NULL CHECK (reason IN ('assigned', 'review_requested', 'mentioned', 'comment', 'check_failed', 'merged', 'invited', 'watching', 'auto_merge_disabled', 'queue_ejected')),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
INSERT INTO forge_notifications_next SELECT id, recipient_id, repository_id, subject_kind, subject_id, subject_number, reason, actor_id, created_at, read_at FROM forge_notifications;
DROP TABLE forge_notifications;
ALTER TABLE forge_notifications_next RENAME TO forge_notifications;
CREATE UNIQUE INDEX idx_forge_notifications_thread ON forge_notifications(recipient_id, subject_kind, subject_id);
CREATE INDEX idx_forge_notifications_recipient ON forge_notifications(recipient_id, created_at DESC, id DESC);
CREATE INDEX idx_forge_notifications_unread ON forge_notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_forge_notifications_repository ON forge_notifications(repository_id);
CREATE INDEX idx_forge_notifications_retention ON forge_notifications(read_at) WHERE read_at IS NOT NULL;
