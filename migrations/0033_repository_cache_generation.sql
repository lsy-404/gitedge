ALTER TABLE repositories ADD COLUMN cache_generation INTEGER NOT NULL DEFAULT 0;

-- Every writer that changes who may read a repository, or where it lives, moves the edge cache keyspace.
CREATE TRIGGER repositories_cache_generation
AFTER UPDATE OF visibility, namespace_id, slug, deleted_at, artifact_name ON repositories
WHEN OLD.visibility IS NOT NEW.visibility
  OR OLD.namespace_id IS NOT NEW.namespace_id
  OR OLD.slug IS NOT NEW.slug
  OR OLD.deleted_at IS NOT NEW.deleted_at
  OR OLD.artifact_name IS NOT NEW.artifact_name
BEGIN
  UPDATE repositories SET cache_generation = cache_generation + 1 WHERE id = NEW.id;
END;
