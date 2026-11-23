ALTER TABLE actions_runners ADD COLUMN hosted_type TEXT CHECK (hosted_type IN ('github-hosted', 'colab'));
UPDATE actions_runners SET hosted_type = 'github-hosted' WHERE hosted_job_id IS NOT NULL;
ALTER TABLE actions_runners ADD COLUMN colab_waker_seen_at INTEGER;

ALTER TABLE actions_runner_settings ADD COLUMN colab_enabled INTEGER NOT NULL DEFAULT 0;
UPDATE actions_runner_settings SET type_priority_json = json_insert(type_priority_json, '$[#]', 'colab')
  WHERE json_valid(type_priority_json) AND NOT EXISTS (SELECT 1 FROM json_each(type_priority_json) WHERE value = 'colab');

CREATE TABLE actions_colab_dispatches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('gitedge', 'github')),
  job_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  session_ms INTEGER NOT NULL,
  bootstrap_token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'starting', 'running', 'finished', 'failed', 'cancelled')),
  waker_runner_id TEXT REFERENCES actions_runners(id),
  runner_id TEXT REFERENCES actions_runners(id),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  expires_at INTEGER NOT NULL,
  error TEXT,
  UNIQUE(job_kind, job_id)
);
CREATE INDEX actions_colab_dispatches_owner ON actions_colab_dispatches(owner_id, state, created_at);
