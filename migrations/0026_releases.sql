CREATE TABLE forge_releases (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  target TEXT,
  target_source TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  prerelease INTEGER NOT NULL DEFAULT 0 CHECK (prerelease IN (0, 1)),
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  CHECK ((draft = 1) = (published_at IS NULL)),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_forge_releases_tag ON forge_releases(repository_id, tag_name);
CREATE INDEX idx_forge_releases_listing ON forge_releases(repository_id, created_at DESC);

CREATE TABLE forge_release_assets (
  id TEXT PRIMARY KEY NOT NULL,
  release_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES forge_releases(id) ON DELETE CASCADE,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (uploader_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_forge_release_assets_name ON forge_release_assets(release_id, name);
CREATE INDEX idx_forge_release_assets_repository ON forge_release_assets(repository_id);
