ALTER TABLE auth_sessions ADD COLUMN recent_auth_at INTEGER NOT NULL DEFAULT 0;
UPDATE auth_sessions SET recent_auth_at = created_at;

CREATE TABLE auth_emails (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  verified_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_auth_emails_verified ON auth_emails(email) WHERE verified_at IS NOT NULL;
CREATE INDEX idx_auth_emails_lookup ON auth_emails(email);

CREATE TABLE auth_one_time_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_one_time_tokens_user ON auth_one_time_tokens(user_id, purpose);
CREATE INDEX idx_auth_one_time_tokens_expiry ON auth_one_time_tokens(expires_at);

CREATE TABLE auth_recovery_codes (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, code_hash)
);

CREATE TABLE auth_totp (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  confirmed_at INTEGER,
  last_counter INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE auth_passkeys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL DEFAULT '[]',
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_auth_passkeys_user ON auth_passkeys(user_id);

CREATE TABLE auth_challenges (
  handle_hash TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login_second_factor', 'passkey_register', 'passkey_login', 'passkey_reauth')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  webauthn_challenge TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);
