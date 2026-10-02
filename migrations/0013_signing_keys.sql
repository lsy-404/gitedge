CREATE TABLE auth_signing_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  key_ids_json TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_auth_signing_keys_user ON auth_signing_keys(user_id);
CREATE TABLE auth_signing_key_ids (
  key_id TEXT NOT NULL,
  signing_key_id TEXT NOT NULL REFERENCES auth_signing_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, signing_key_id)
);
CREATE TABLE auth_signing_key_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_signing_challenges_expiry ON auth_signing_key_challenges(expires_at);
