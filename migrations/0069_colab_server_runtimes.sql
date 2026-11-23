CREATE TABLE actions_colab_accounts (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_iv TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  balance REAL,
  rate_hourly REAL,
  checked_at INTEGER,
  error TEXT
);

CREATE TABLE actions_colab_authorizations (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verifier_ciphertext TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE actions_colab_dispatches_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('gitedge', 'github')),
  job_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  session_ms INTEGER NOT NULL,
  bootstrap_token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'starting', 'running', 'finished', 'failed', 'cancelled')),
  runner_id TEXT REFERENCES actions_runners(id),
  colab_endpoint TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  error TEXT,
  UNIQUE(job_kind, job_id)
);
INSERT INTO actions_colab_dispatches_next (id,owner_id,job_kind,job_id,repository_id,session_ms,bootstrap_token_hash,state,runner_id,created_at,claimed_at,expires_at,released_at,error)
SELECT id,owner_id,job_kind,job_id,repository_id,session_ms,
  CASE WHEN state = 'claimed' THEN NULL ELSE bootstrap_token_hash END,
  CASE WHEN state = 'claimed' THEN 'failed' ELSE state END,
  runner_id,created_at,claimed_at,expires_at,
  CASE WHEN claimed_at IS NOT NULL THEN created_at END,
  CASE WHEN state = 'claimed' THEN COALESCE(error, 'colab_session_failed') ELSE error END
FROM actions_colab_dispatches;
DROP TABLE actions_colab_dispatches;
ALTER TABLE actions_colab_dispatches_next RENAME TO actions_colab_dispatches;
CREATE INDEX actions_colab_dispatches_owner ON actions_colab_dispatches(owner_id, state, created_at);
CREATE INDEX actions_colab_dispatches_release ON actions_colab_dispatches(released_at, state);

ALTER TABLE actions_runners DROP COLUMN colab_waker_seen_at;
