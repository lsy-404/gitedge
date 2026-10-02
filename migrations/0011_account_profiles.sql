PRAGMA foreign_keys = ON;

ALTER TABLE auth_sessions ADD COLUMN id TEXT NOT NULL DEFAULT '';
UPDATE auth_sessions SET id = lower(hex(randomblob(16))) WHERE id = '';
CREATE UNIQUE INDEX idx_auth_sessions_id ON auth_sessions(id);

ALTER TABLE auth_sso_identities ADD COLUMN preferred_username TEXT;

CREATE TABLE auth_account_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  preferences_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
