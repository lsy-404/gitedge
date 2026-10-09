ALTER TABLE repositories ADD COLUMN ai_summaries_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN ai_summaries_private_consent INTEGER NOT NULL DEFAULT 0;

CREATE TABLE forge_ai_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  pull_request_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  force INTEGER NOT NULL DEFAULT 0 CHECK (force IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  head_oid TEXT,
  model TEXT,
  summary_json TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_forge_ai_summaries_cache ON forge_ai_summaries(pull_request_id, head_oid) WHERE status = 'succeeded';
CREATE UNIQUE INDEX idx_forge_ai_summaries_queue ON forge_ai_summaries(pull_request_id) WHERE status = 'queued';
CREATE INDEX idx_forge_ai_summaries_pull ON forge_ai_summaries(pull_request_id, updated_at DESC);
CREATE INDEX idx_forge_ai_summaries_pending ON forge_ai_summaries(status, created_at);

CREATE TABLE forge_ai_usage (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX idx_forge_ai_usage_window ON forge_ai_usage(repository_id, created_at);
