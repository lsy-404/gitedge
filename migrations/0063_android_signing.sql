CREATE TABLE actions_signing_runs_next (
  run_id TEXT PRIMARY KEY REFERENCES actions_runner_runs(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('sign','finalize','dmg_sign','dmg_finalize','windows_sign','ios_sign','android_sign')),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71 AND input_digest GLOB 'sha256:[a-f0-9]*'),
  profile_revision TEXT NOT NULL CHECK (length(profile_revision) = 40),
  workflow_oid TEXT NOT NULL CHECK (length(workflow_oid) = 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows','macos','ios','android')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  nonce TEXT NOT NULL CHECK (length(nonce) = 43),
  created_at INTEGER NOT NULL,
  reconcile_state TEXT NOT NULL DEFAULT 'pending' CHECK (reconcile_state IN ('pending','failed')),
  last_reconciled_at INTEGER,
  UNIQUE(request_id, owner_id, stage, generation)
);
INSERT INTO actions_signing_runs_next (run_id,request_id,owner_id,repository_id,stage,input_digest,profile_revision,workflow_oid,platform,generation,nonce,created_at,reconcile_state,last_reconciled_at)
SELECT run_id,request_id,owner_id,repository_id,stage,input_digest,profile_revision,workflow_oid,platform,generation,nonce,created_at,reconcile_state,last_reconciled_at FROM actions_signing_runs;
DROP TABLE actions_signing_runs;
ALTER TABLE actions_signing_runs_next RENAME TO actions_signing_runs;
CREATE INDEX actions_signing_runs_request ON actions_signing_runs(owner_id, repository_id, request_id);
CREATE INDEX actions_signing_reconcile_fairness
  ON actions_signing_runs(reconcile_state, last_reconciled_at, created_at);

CREATE TABLE actions_signing_credentials_next (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  profile_revision TEXT NOT NULL CHECK (length(profile_revision) = 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows','macos','ios','android')),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, repository_id, profile_revision, platform)
);
INSERT INTO actions_signing_credentials_next (owner_id,repository_id,profile_revision,platform,ciphertext,updated_at)
SELECT owner_id,repository_id,profile_revision,platform,ciphertext,updated_at FROM actions_signing_credentials;
DROP TABLE actions_signing_credentials;
ALTER TABLE actions_signing_credentials_next RENAME TO actions_signing_credentials;
