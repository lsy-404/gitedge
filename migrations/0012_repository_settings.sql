ALTER TABLE repositories ADD COLUMN issues_enabled INTEGER NOT NULL DEFAULT 1 CHECK (issues_enabled IN (0, 1));
ALTER TABLE repositories ADD COLUMN pulls_enabled INTEGER NOT NULL DEFAULT 1 CHECK (pulls_enabled IN (0, 1));
ALTER TABLE repositories ADD COLUMN discussions_enabled INTEGER NOT NULL DEFAULT 1 CHECK (discussions_enabled IN (0, 1));
ALTER TABLE repositories ADD COLUMN wiki_enabled INTEGER NOT NULL DEFAULT 1 CHECK (wiki_enabled IN (0, 1));
ALTER TABLE repositories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
ALTER TABLE repositories ADD COLUMN required_approvals INTEGER NOT NULL DEFAULT 0 CHECK (required_approvals BETWEEN 0 AND 5);
ALTER TABLE repositories ADD COLUMN require_passing_checks INTEGER NOT NULL DEFAULT 0 CHECK (require_passing_checks IN (0, 1));
