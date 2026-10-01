ALTER TABLE repositories ADD COLUMN artifact_name TEXT;
ALTER TABLE repositories ADD COLUMN remote TEXT;
ALTER TABLE repositories ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main';

ALTER TABLE forge_issues ADD COLUMN actor_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE forge_issues ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE forge_issues ADD COLUMN assignees_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE forge_pull_requests RENAME TO forge_pull_requests_old;
CREATE TABLE forge_pull_requests (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_session_id TEXT,
  draft INTEGER NOT NULL DEFAULT 0 CHECK (draft IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  merged_oid TEXT,
  merge_started_at INTEGER,
  merge_base_oid TEXT,
  merge_head_oid TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository_id, number),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO forge_pull_requests (id, repository_id, number, author_id, actor_json, title, body, base_ref, head_ref, state, created_at, updated_at)
SELECT id, repository_id, number, author_id, '{}', title, body, base_ref, head_ref, state, created_at, updated_at FROM forge_pull_requests_old;
DROP TABLE forge_pull_requests_old;

CREATE TABLE forge_counters (
  repository_id TEXT PRIMARY KEY NOT NULL,
  conversation_number INTEGER NOT NULL DEFAULT 0,
  discussion_number INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
INSERT INTO forge_counters (repository_id, conversation_number)
SELECT repositories.id,
  MAX(
    COALESCE((SELECT MAX(number) FROM forge_issues WHERE repository_id = repositories.id), 0),
    COALESCE((SELECT MAX(number) FROM forge_pull_requests WHERE repository_id = repositories.id), 0)
  )
FROM repositories;

CREATE TABLE forge_comments (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue', 'pull_request', 'discussion')),
  target_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_comments_target ON forge_comments(repository_id, target_kind, target_id, created_at);

CREATE TABLE forge_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  pull_request_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  author_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('commented', 'approved', 'changes_requested')),
  body TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_reviews_head ON forge_reviews(pull_request_id, commit_oid, created_at);
CREATE INDEX idx_forge_reviews_actor ON forge_reviews(pull_request_id, commit_oid, actor_key, created_at);

CREATE TABLE forge_check_runs (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  pull_request_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  name TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed')),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'neutral', 'cancelled')),
  summary TEXT NOT NULL,
  details_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_forge_checks_identity ON forge_check_runs(pull_request_id, commit_oid, name, actor_key);
CREATE INDEX idx_forge_checks_head ON forge_check_runs(pull_request_id, commit_oid, created_at);

CREATE TABLE forge_discussions (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('general', 'ideas', 'q-and-a', 'announcements')),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  answer_comment_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(repository_id, number),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_discussions_repo ON forge_discussions(repository_id, number DESC);

CREATE TABLE forge_wiki_revisions (
  repository_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(repository_id, slug, revision),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);
