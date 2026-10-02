PRAGMA foreign_keys = ON;

CREATE TABLE external_identities_next (
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider_login TEXT NOT NULL,
  avatar_url TEXT,
  profile_url TEXT,
  created_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO external_identities_next (provider, provider_user_id, user_id, provider_login, avatar_url, profile_url, created_at, last_verified_at)
  SELECT provider, provider_user_id, user_id, provider_login, avatar_url, profile_url, created_at, last_verified_at FROM external_identities;
DROP TABLE external_identities;
ALTER TABLE external_identities_next RENAME TO external_identities;
CREATE INDEX IF NOT EXISTS idx_external_identities_user ON external_identities(user_id);

-- In-flight authorizations are short-lived, so pending states are discarded.
DROP TABLE github_oauth_states;
CREATE TABLE github_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  browser_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_github_oauth_states_expiry ON github_oauth_states(expires_at);
