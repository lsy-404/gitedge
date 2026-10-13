ALTER TABLE forge_pull_requests ADD COLUMN locked_at INTEGER;
ALTER TABLE forge_pull_requests ADD COLUMN locked_by TEXT REFERENCES users(id);
ALTER TABLE forge_pull_requests ADD COLUMN locked_head_oid TEXT;
ALTER TABLE auth_agent_sessions ADD COLUMN git_token_hash TEXT;
CREATE UNIQUE INDEX auth_agent_sessions_git_token_hash ON auth_agent_sessions(git_token_hash) WHERE git_token_hash IS NOT NULL;
CREATE INDEX forge_pull_requests_locked_source ON forge_pull_requests(head_repository_id, head_session_id, head_ref) WHERE state = 'open' AND locked_at IS NOT NULL;

CREATE TABLE git_ref_writes (
  artifact_name TEXT NOT NULL,
  ref TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_name, ref)
);
