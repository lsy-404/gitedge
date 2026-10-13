CREATE TABLE access_bans (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'ip')),
  subject_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (kind, subject_value)
);
CREATE INDEX access_bans_active ON access_bans (kind, expires_at);

CREATE TABLE admin_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO admin_settings (key, value, updated_at) VALUES ('ip_rpm_limit', '300', unixepoch() * 1000);
