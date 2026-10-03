CREATE TABLE bench_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_bench_sessions_actor
  ON bench_sessions (user_id, repository_id, status, expires_at);

CREATE TABLE bench_collaborators (
  repository_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
  PRIMARY KEY (repository_id, user_id)
);

CREATE INDEX idx_bench_collaborators_user
  ON bench_collaborators (user_id, repository_id);

CREATE TABLE bench_audit (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES bench_sessions(session_id) ON DELETE CASCADE,
  write_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_bench_audit_session
  ON bench_audit (session_id);
