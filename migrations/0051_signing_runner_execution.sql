ALTER TABLE actions_runners ADD COLUMN execution_class TEXT NOT NULL DEFAULT 'ordinary'
  CHECK (execution_class IN ('ordinary', 'signing'));
ALTER TABLE actions_runners ADD COLUMN signing_platform TEXT
  CHECK (signing_platform IS NULL OR signing_platform IN ('macos', 'windows', 'ios'));
ALTER TABLE actions_runners ADD COLUMN dedicated_host_confirmed INTEGER NOT NULL DEFAULT 0
  CHECK (dedicated_host_confirmed IN (0, 1));
ALTER TABLE actions_runners ADD COLUMN operator_approved_at INTEGER;
ALTER TABLE actions_runners ADD COLUMN operator_approved_by TEXT REFERENCES users(id);

CREATE TRIGGER actions_runners_signing_scope_insert
BEFORE INSERT ON actions_runners
WHEN NEW.execution_class = 'signing'
BEGIN
  SELECT RAISE(ABORT, 'signing runners must be explicitly approved after registration');
END;
CREATE TRIGGER actions_runners_signing_scope_update
BEFORE UPDATE OF execution_class,signing_platform,dedicated_host_confirmed,operator_approved_at,operator_approved_by
ON actions_runners
WHEN NEW.execution_class = 'signing'
BEGIN
  SELECT CASE WHEN NEW.repository_id IS NULL OR NEW.signing_platform IS NULL
    OR NEW.dedicated_host_confirmed != 1 OR NEW.operator_approved_at IS NULL
    OR NEW.operator_approved_by IS NOT NEW.created_by
    THEN RAISE(ABORT, 'signing runner approval is incomplete') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM repositories p JOIN namespaces n ON n.id=p.namespace_id
    WHERE p.id=NEW.repository_id AND p.namespace_id=NEW.namespace_id
      AND p.system_kind='account_runner' AND p.visibility='private' AND p.deleted_at IS NULL
      AND n.kind='personal' AND n.created_by=NEW.created_by
  ) THEN RAISE(ABORT, 'signing runner requires its owners private Runner repository') END;
END;
