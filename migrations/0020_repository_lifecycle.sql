ALTER TABLE repositories ADD COLUMN deleted_at INTEGER;
ALTER TABLE repositories ADD COLUMN deleted_by TEXT;
ALTER TABLE repositories ADD COLUMN deleted_slug TEXT;
ALTER TABLE repositories ADD COLUMN purge_after INTEGER;
ALTER TABLE repositories ADD COLUMN purge_state TEXT
  CHECK (purge_state IS NULL OR purge_state IN ('revoked', 'artifacts_deleted'));
ALTER TABLE repositories ADD COLUMN purge_cursor TEXT;
ALTER TABLE repositories ADD COLUMN purge_retry_at INTEGER;
CREATE INDEX idx_repositories_purge ON repositories(purge_after) WHERE deleted_at IS NOT NULL;
