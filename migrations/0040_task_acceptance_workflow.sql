PRAGMA foreign_keys = ON;

ALTER TABLE forge_task_documents RENAME TO forge_task_documents_old;
ALTER TABLE forge_task_document_revisions RENAME TO forge_task_document_revisions_old;
ALTER TABLE forge_task_links RENAME TO forge_task_links_old;
ALTER TABLE forge_task_commits RENAME TO forge_task_commits_old;
ALTER TABLE forge_tasks RENAME TO forge_tasks_old;

CREATE TABLE forge_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  motivation TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned')),
  assignee_kind TEXT CHECK (assignee_kind IN ('user', 'agent')),
  assignee_id TEXT,
  created_by TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_agent_id TEXT,
  lease_claimed_at INTEGER,
  lease_expires_at INTEGER,
  lease_assigned INTEGER NOT NULL DEFAULT 0 CHECK (lease_assigned IN (0, 1)),
  UNIQUE (repository_id, number),
  CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL)),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO forge_tasks (
  id, repository_id, number, type, title, motivation, description, status,
  assignee_kind, assignee_id, created_by, actor_json, created_at, updated_at,
  lease_agent_id, lease_claimed_at, lease_expires_at, lease_assigned
)
SELECT
  id, repository_id, number, type, title, motivation, description, status,
  assignee_kind, assignee_id, created_by, actor_json, created_at, updated_at,
  lease_agent_id, lease_claimed_at, lease_expires_at, lease_assigned
FROM forge_tasks_old;

CREATE TABLE forge_task_documents (
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'findings', 'progress')),
  content TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_by TEXT,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind),
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO forge_task_documents SELECT * FROM forge_task_documents_old;

CREATE TABLE forge_task_document_revisions (
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'findings', 'progress')),
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_by TEXT,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, revision),
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);
INSERT INTO forge_task_document_revisions SELECT * FROM forge_task_document_revisions_old;

CREATE TABLE forge_task_links (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue', 'pull_request')),
  target_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (target_kind, target_id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE
);
INSERT INTO forge_task_links SELECT * FROM forge_task_links_old;

CREATE TABLE forge_task_commits (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  author_name TEXT NOT NULL,
  bound_by_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'pull_request_merge')),
  bound_at INTEGER NOT NULL,
  UNIQUE (task_id, oid),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES forge_tasks(id) ON DELETE CASCADE
);
INSERT INTO forge_task_commits SELECT * FROM forge_task_commits_old;

DROP TABLE forge_task_documents_old;
DROP TABLE forge_task_document_revisions_old;
DROP TABLE forge_task_links_old;
DROP TABLE forge_task_commits_old;
DROP TABLE forge_tasks_old;

CREATE INDEX idx_forge_tasks_repo ON forge_tasks(repository_id, number DESC);
CREATE INDEX idx_forge_tasks_lease ON forge_tasks(lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX idx_forge_task_links_task ON forge_task_links(task_id, created_at);
CREATE INDEX idx_forge_task_commits_task ON forge_task_commits(task_id, bound_at);
CREATE INDEX idx_forge_tasks_dashboard ON forge_tasks(status, updated_at, id);
CREATE INDEX idx_forge_pull_requests_attention ON forge_pull_requests(state, updated_at, id);
CREATE INDEX idx_agent_sessions_dashboard ON auth_agent_sessions(user_id, status, expires_at, id);
