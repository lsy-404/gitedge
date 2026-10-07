CREATE TABLE namespace_slug_history (
  slug TEXT PRIMARY KEY,
  namespace_id TEXT NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  retired_at INTEGER NOT NULL
);

CREATE INDEX namespace_slug_history_namespace ON namespace_slug_history (namespace_id);

CREATE TRIGGER namespaces_retain_slug
AFTER UPDATE OF slug ON namespaces
WHEN old.slug != new.slug
BEGIN
  INSERT OR REPLACE INTO namespace_slug_history (slug, namespace_id, retired_at)
  VALUES (old.slug, old.id, unixepoch() * 1000);
  DELETE FROM namespace_slug_history WHERE slug = new.slug AND namespace_id = new.id;
END;

CREATE TRIGGER namespaces_reject_retired_slug_insert
BEFORE INSERT ON namespaces
WHEN EXISTS (SELECT 1 FROM namespace_slug_history WHERE slug = new.slug)
BEGIN
  SELECT RAISE(ABORT, 'namespace slug is retired');
END;

CREATE TRIGGER namespaces_reject_retired_slug_update
BEFORE UPDATE OF slug ON namespaces
WHEN old.slug != new.slug
  AND EXISTS (
    SELECT 1 FROM namespace_slug_history WHERE slug = new.slug AND namespace_id != new.id
  )
BEGIN
  SELECT RAISE(ABORT, 'namespace slug is retired');
END;
