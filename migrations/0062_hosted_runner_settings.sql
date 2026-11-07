CREATE TABLE forge_hosted_runner_settings (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  github_owner_id INTEGER NOT NULL,
  github_repository_id INTEGER NOT NULL,
  github_repository TEXT NOT NULL,
  enabled_at INTEGER NOT NULL
);
