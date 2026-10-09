ALTER TABLE users ADD COLUMN disabled_at INTEGER;
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE users ADD COLUMN is_site_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_site_admin IN (0, 1));
CREATE INDEX idx_users_created ON users(created_at DESC, id DESC);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('organization', 'repository')),
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  repository_id TEXT REFERENCES repositories(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  invitee_email TEXT,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (kind = 'organization' AND repository_id IS NULL AND role IN ('owner', 'member'))
    OR (kind = 'repository' AND repository_id IS NOT NULL AND role IN ('read', 'write', 'admin'))
  ),
  CHECK ((invitee_user_id IS NOT NULL) <> (token_hash IS NOT NULL))
);
CREATE INDEX idx_invitations_invitee ON invitations(invitee_user_id, status, expires_at);
CREATE INDEX idx_invitations_namespace ON invitations(namespace_id, kind, status);
CREATE INDEX idx_invitations_repository ON invitations(repository_id, status);
CREATE UNIQUE INDEX idx_invitations_pending_organization_user
  ON invitations(namespace_id, invitee_user_id)
  WHERE status = 'pending' AND kind = 'organization' AND invitee_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_invitations_pending_repository_user
  ON invitations(repository_id, invitee_user_id)
  WHERE status = 'pending' AND kind = 'repository' AND invitee_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_invitations_pending_organization_email
  ON invitations(namespace_id, invitee_email)
  WHERE status = 'pending' AND kind = 'organization' AND invitee_email IS NOT NULL;
CREATE UNIQUE INDEX idx_invitations_pending_repository_email
  ON invitations(repository_id, invitee_email)
  WHERE status = 'pending' AND kind = 'repository' AND invitee_email IS NOT NULL;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'token', 'system')),
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  actor_ref TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_label TEXT,
  repository_id TEXT,
  namespace_id TEXT,
  subject_user_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_events_repository ON audit_events(repository_id, created_at DESC, id DESC)
  WHERE repository_id IS NOT NULL;
CREATE INDEX idx_audit_events_namespace ON audit_events(namespace_id, created_at DESC, id DESC)
  WHERE namespace_id IS NOT NULL;
CREATE INDEX idx_audit_events_subject ON audit_events(subject_user_id, created_at DESC, id DESC)
  WHERE subject_user_id IS NOT NULL;
CREATE TRIGGER audit_events_reject_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
CREATE TRIGGER audit_events_reject_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
