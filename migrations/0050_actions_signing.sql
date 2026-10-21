CREATE TABLE actions_signing_runs (
  run_id TEXT PRIMARY KEY REFERENCES actions_runner_runs(run_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('sign','finalize','dmg_sign','dmg_finalize','windows_sign','ios_sign')),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71 AND input_digest GLOB 'sha256:[a-f0-9]*'),
  profile_revision TEXT NOT NULL CHECK (length(profile_revision) = 40),
  workflow_oid TEXT NOT NULL CHECK (length(workflow_oid) = 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows','macos','ios')),
  operator_approved_by TEXT NOT NULL REFERENCES users(id),
  operator_approved_at INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  nonce TEXT NOT NULL CHECK (length(nonce) = 43),
  created_at INTEGER NOT NULL,
  UNIQUE(request_id, owner_id, stage, generation)
);
CREATE INDEX actions_signing_runs_request ON actions_signing_runs(owner_id, repository_id, request_id);

CREATE TABLE actions_signing_profiles (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revision TEXT NOT NULL CHECK (length(revision) = 40),
  profile_json TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY(owner_id, repository_id, name, revision)
);
CREATE UNIQUE INDEX actions_signing_profiles_active ON actions_signing_profiles(owner_id, repository_id, name) WHERE revoked_at IS NULL;

CREATE TABLE actions_signing_credentials (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  profile_revision TEXT NOT NULL CHECK (length(profile_revision) = 40),
  platform TEXT NOT NULL CHECK (platform IN ('windows','macos','ios')),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, repository_id, profile_revision, platform)
);
