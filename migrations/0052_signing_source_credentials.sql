ALTER TABLE actions_signing_runs ADD COLUMN reconcile_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (reconcile_state IN ('pending','failed'));

CREATE TABLE actions_signing_source_credentials (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  profile_revision TEXT NOT NULL CHECK (length(profile_revision) = 40),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, repository_id, profile_revision)
);
