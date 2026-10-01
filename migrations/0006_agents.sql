CREATE TABLE auth_agents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  UNIQUE(user_id, name)
);

CREATE TABLE auth_agent_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  git_token_id TEXT NOT NULL,
  workspace_name TEXT NOT NULL UNIQUE,
  remote TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_oid TEXT,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'write')),
  status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'revoked')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_sessions_user ON auth_agent_sessions(user_id, created_at DESC);
CREATE INDEX idx_agent_sessions_repo ON auth_agent_sessions(repository_id, created_at DESC);

CREATE TABLE auth_git_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'write')),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_git_tokens_user ON auth_git_tokens(user_id, created_at DESC);
