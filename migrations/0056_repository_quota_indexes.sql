CREATE INDEX idx_repositories_creator_visibility
  ON repositories(created_by, visibility)
  WHERE system_kind IS NULL;

CREATE INDEX idx_repository_imports_pending_creator_visibility
  ON repository_imports(created_by, visibility)
  WHERE status IN ('queued', 'running');
