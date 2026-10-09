CREATE TABLE forge_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'pull_request', 'discussion', 'repository')),
  subject_id TEXT NOT NULL,
  subject_number INTEGER,
  reason TEXT NOT NULL CHECK (reason IN ('assigned', 'review_requested', 'mentioned', 'comment', 'check_failed', 'merged', 'invited')),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE UNIQUE INDEX idx_forge_notifications_thread ON forge_notifications(recipient_id, subject_kind, subject_id);
CREATE INDEX idx_forge_notifications_recipient ON forge_notifications(recipient_id, created_at DESC, id DESC);
CREATE INDEX idx_forge_notifications_unread ON forge_notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_forge_notifications_repository ON forge_notifications(repository_id);
CREATE INDEX idx_forge_notifications_retention ON forge_notifications(read_at) WHERE read_at IS NOT NULL;

CREATE TABLE forge_notification_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_reasons_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE forge_webhooks (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'json' CHECK (content_type IN ('json')),
  events_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_forge_webhooks_repository ON forge_webhooks(repository_id, created_at);

CREATE TABLE forge_webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  webhook_id TEXT NOT NULL REFERENCES forge_webhooks(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  action TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'success', 'failed')),
  response_status INTEGER,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_until INTEGER,
  redelivery_of TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_forge_webhook_deliveries_hook ON forge_webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_forge_webhook_deliveries_due ON forge_webhook_deliveries(status, next_attempt_at);
