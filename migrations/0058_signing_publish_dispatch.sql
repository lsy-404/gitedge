CREATE TABLE actions_signing_publish_dispatches (
  request_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);
CREATE INDEX idx_signing_publish_dispatches_due
  ON actions_signing_publish_dispatches(state, next_attempt_at);
