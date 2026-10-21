ALTER TABLE repositories ADD COLUMN system_kind TEXT
  CHECK (system_kind IS NULL OR system_kind = 'account_runner');

CREATE UNIQUE INDEX idx_repositories_account_runner_namespace
  ON repositories(namespace_id)
  WHERE system_kind = 'account_runner';

CREATE TRIGGER repositories_account_runner_insert
BEFORE INSERT ON repositories
WHEN NEW.system_kind = 'account_runner'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM namespaces n
    WHERE n.id = NEW.namespace_id
      AND n.kind = 'personal'
      AND n.created_by = NEW.created_by
  ) THEN RAISE(ABORT, 'account runner requires its personal namespace owner') END;
  SELECT CASE WHEN NEW.slug != 'runner' OR NEW.visibility != 'private'
    THEN RAISE(ABORT, 'account runner must be private at runner') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM repository_imports i
    WHERE i.namespace_id = NEW.namespace_id
      AND i.slug = NEW.slug
      AND i.status IN ('queued', 'running')
  ) THEN RAISE(ABORT, 'account runner path is reserved by an import') END;
END;

CREATE TRIGGER repositories_account_runner_update
BEFORE UPDATE OF system_kind, namespace_id, created_by, slug, visibility ON repositories
WHEN OLD.system_kind = 'account_runner' OR NEW.system_kind = 'account_runner'
BEGIN
  SELECT CASE WHEN NEW.system_kind IS NOT 'account_runner'
    THEN RAISE(ABORT, 'account runner kind is immutable') END;
  SELECT CASE WHEN NEW.namespace_id IS NOT OLD.namespace_id OR NEW.created_by IS NOT OLD.created_by
    THEN RAISE(ABORT, 'account runner ownership is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM namespaces n
    WHERE n.id = NEW.namespace_id
      AND n.kind = 'personal'
      AND n.created_by = NEW.created_by
  ) THEN RAISE(ABORT, 'account runner requires its personal namespace owner') END;
  SELECT CASE WHEN NEW.slug != 'runner' OR NEW.visibility != 'private'
    THEN RAISE(ABORT, 'account runner must be private at runner') END;
END;

CREATE TRIGGER namespaces_preserve_account_runner_owner
BEFORE UPDATE OF kind, created_by ON namespaces
WHEN EXISTS (
  SELECT 1 FROM repositories r
  WHERE r.namespace_id = OLD.id AND r.system_kind = 'account_runner'
)
AND (NEW.kind != 'personal' OR NEW.created_by != OLD.created_by)
BEGIN
  SELECT RAISE(ABORT, 'personal namespace owns an account runner');
END;

CREATE TRIGGER repository_imports_respect_account_runner
BEFORE INSERT ON repository_imports
WHEN NEW.slug = 'runner'
  AND NEW.status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM repositories r
    WHERE r.namespace_id = NEW.namespace_id AND r.system_kind = 'account_runner'
  )
BEGIN
  SELECT RAISE(ABORT, 'runner path belongs to the account runner repository');
END;

CREATE TRIGGER repository_imports_updates_respect_account_runner
BEFORE UPDATE OF namespace_id, slug, status ON repository_imports
WHEN NEW.slug = 'runner'
  AND NEW.status IN ('queued', 'running')
  AND EXISTS (
    SELECT 1 FROM repositories r
    WHERE r.namespace_id = NEW.namespace_id AND r.system_kind = 'account_runner'
  )
BEGIN
  SELECT RAISE(ABORT, 'runner path belongs to the account runner repository');
END;
