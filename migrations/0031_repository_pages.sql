ALTER TABLE repositories ADD COLUMN pages_enabled INTEGER NOT NULL DEFAULT 0 CHECK (pages_enabled IN (0, 1));

CREATE TABLE repository_pages (
  repository_id TEXT PRIMARY KEY NOT NULL,
  source_branch TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '/',
  not_found_path TEXT,
  spa_fallback INTEGER NOT NULL DEFAULT 0 CHECK (spa_fallback IN (0, 1)),
  last_published_oid TEXT,
  last_published_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE INDEX idx_forge_checks_pages ON forge_check_runs(repository_id, commit_oid, name);
