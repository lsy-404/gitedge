CREATE TABLE repository_paths (
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  PRIMARY KEY (namespace_id, slug)
);
INSERT INTO repository_paths(namespace_id,slug,repository_id) SELECT namespace_id,slug,id FROM repositories;
CREATE INDEX idx_repository_paths_repo ON repository_paths(repository_id);
ALTER TABLE repositories ADD COLUMN tasks_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN agents_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN deployments_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN graph_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN actions_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN actions_network_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repositories ADD COLUMN online_editing_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN allow_merge_commit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN allow_squash_merge INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN allow_rebase_merge INTEGER NOT NULL DEFAULT 1;
ALTER TABLE repositories ADD COLUMN delete_branch_on_merge INTEGER NOT NULL DEFAULT 0;
CREATE TABLE repository_branch_rules (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 0,
  require_passing_checks INTEGER NOT NULL DEFAULT 0,
  required_status_checks TEXT NOT NULL DEFAULT '[]',
  require_linear_history INTEGER NOT NULL DEFAULT 0,
  require_signed_commits INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository_id,pattern)
);
CREATE TABLE repository_collaborators (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('read','write','admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(repository_id,user_id)
);
CREATE TRIGGER repository_paths_preserve_owner
BEFORE UPDATE OF repository_id ON repository_paths
WHEN old.repository_id != new.repository_id
BEGIN
  SELECT RAISE(ABORT, 'repository path belongs to another repository');
END;
CREATE TRIGGER repositories_register_path
AFTER INSERT ON repositories
BEGIN
  INSERT INTO repository_paths(namespace_id,slug,repository_id) VALUES(new.namespace_id,new.slug,new.id);
END;
CREATE TRIGGER repositories_keep_renamed_paths
AFTER UPDATE OF namespace_id,slug ON repositories
WHEN old.namespace_id != new.namespace_id OR old.slug != new.slug
BEGIN
  INSERT INTO repository_paths(namespace_id,slug,repository_id) VALUES(new.namespace_id,new.slug,new.id)
  ON CONFLICT(namespace_id,slug) DO UPDATE SET repository_id=excluded.repository_id;
END;
CREATE TABLE git_merge_receipts (
  operation_key TEXT NOT NULL,
  oid TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_key,oid)
);
