CREATE TABLE auth_git_oauth_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE auth_git_oauth_refresh (
  token_hash TEXT PRIMARY KEY NOT NULL,
  access_id TEXT NOT NULL REFERENCES auth_access_tokens(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_git_oauth_codes_expiry ON auth_git_oauth_codes(expires_at);
CREATE INDEX idx_git_oauth_refresh_expiry ON auth_git_oauth_refresh(expires_at);
CREATE INDEX idx_git_oauth_refresh_access ON auth_git_oauth_refresh(access_id, expires_at);
