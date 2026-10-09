ALTER TABLE repositories ADD COLUMN fork_of TEXT REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE repositories ADD COLUMN star_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_repositories_fork_of ON repositories(fork_of, updated_at DESC) WHERE fork_of IS NOT NULL;
CREATE INDEX idx_repositories_explore_updated ON repositories(updated_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX idx_repositories_explore_stars ON repositories(star_count DESC, updated_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

-- Cross-repository pull requests carry the fork's id; no foreign key so a purged fork never turns the head into a base branch.
ALTER TABLE forge_pull_requests ADD COLUMN head_repository_id TEXT;
CREATE INDEX idx_forge_pull_requests_head_repository ON forge_pull_requests(head_repository_id) WHERE head_repository_id IS NOT NULL;

CREATE TABLE repository_stars (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, user_id)
);
CREATE INDEX idx_repository_stars_user ON repository_stars(user_id, created_at DESC, repository_id);

-- Participating is the default and has no row.
CREATE TABLE repository_watches (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('all', 'ignore')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, user_id)
);
CREATE INDEX idx_repository_watches_level ON repository_watches(repository_id, level);

CREATE TABLE repository_topics (
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 35 AND topic NOT GLOB '*[^a-z0-9-]*' AND topic NOT GLOB '-*'),
  PRIMARY KEY (repository_id, topic)
);
CREATE INDEX idx_repository_topics_topic ON repository_topics(topic, repository_id);

CREATE TABLE forge_notifications_next (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('issue', 'pull_request', 'discussion', 'repository')),
  subject_id TEXT NOT NULL,
  subject_number INTEGER,
  reason TEXT NOT NULL CHECK (reason IN ('assigned', 'review_requested', 'mentioned', 'comment', 'check_failed', 'merged', 'invited', 'watching')),
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
INSERT INTO forge_notifications_next (id, recipient_id, repository_id, subject_kind, subject_id, subject_number, reason, actor_id, created_at, read_at)
SELECT id, recipient_id, repository_id, subject_kind, subject_id, subject_number, reason, actor_id, created_at, read_at FROM forge_notifications;
DROP TABLE forge_notifications;
ALTER TABLE forge_notifications_next RENAME TO forge_notifications;
CREATE UNIQUE INDEX idx_forge_notifications_thread ON forge_notifications(recipient_id, subject_kind, subject_id);
CREATE INDEX idx_forge_notifications_recipient ON forge_notifications(recipient_id, created_at DESC, id DESC);
CREATE INDEX idx_forge_notifications_unread ON forge_notifications(recipient_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_forge_notifications_repository ON forge_notifications(repository_id);
CREATE INDEX idx_forge_notifications_retention ON forge_notifications(read_at) WHERE read_at IS NOT NULL;
