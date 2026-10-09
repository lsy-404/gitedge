CREATE TABLE repository_imports (
  id TEXT PRIMARY KEY NOT NULL,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  description TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  progress TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  repository_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE UNIQUE INDEX idx_repository_imports_active_path
  ON repository_imports(namespace_id, slug)
  WHERE status IN ('queued', 'running');
CREATE INDEX idx_repository_imports_user ON repository_imports(created_by, created_at DESC);
