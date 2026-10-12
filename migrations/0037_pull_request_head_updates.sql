CREATE TABLE IF NOT EXISTS forge_pull_head_updates (
  id TEXT PRIMARY KEY NOT NULL,
  pull_request_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('branch', 'fork', 'session')),
  previous_oid TEXT,
  new_oid TEXT NOT NULL,
  pusher_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  agent_session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pusher_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS forge_pull_head_updates_pull_idx ON forge_pull_head_updates (pull_request_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS forge_ref_pushers (
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  pusher_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  last_event_id TEXT NOT NULL DEFAULT '',
  pusher_verified INTEGER NOT NULL DEFAULT 0 CHECK (pusher_verified IN (0, 1)),
  PRIMARY KEY (repository_id, session_id, ref),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pusher_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS forge_push_event_refs (
  event_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL,
  before_oid TEXT NOT NULL,
  after_oid TEXT NOT NULL,
  pusher_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  created_at INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, ref),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pusher_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS forge_push_event_refs_created_idx ON forge_push_event_refs (created_at DESC);
