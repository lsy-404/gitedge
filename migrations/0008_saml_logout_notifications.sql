ALTER TABLE auth_sso_sessions ADD COLUMN session_index TEXT;
CREATE TABLE auth_sso_logout_notifications (
  request_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sso_logout_notifications_expiry ON auth_sso_logout_notifications(expires_at);
