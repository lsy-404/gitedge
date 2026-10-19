CREATE TABLE github_api_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('repository', 'release', 'asset', 'user')),
  native_id TEXT NOT NULL,
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (kind, native_id)
);

CREATE INDEX github_api_ids_repository_idx ON github_api_ids(repository_id, kind, id);
