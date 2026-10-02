PRAGMA foreign_keys = ON;

-- Repository-level collaboration settings for tasks, memory and agent assignment.
ALTER TABLE repositories ADD COLUMN memory_visibility TEXT NOT NULL DEFAULT 'members' CHECK (memory_visibility IN ('members', 'public'));
ALTER TABLE repositories ADD COLUMN agent_assignment_policy TEXT NOT NULL DEFAULT 'owner' CHECK (agent_assignment_policy IN ('owner', 'members'));

-- Tasks get their own per-repository number sequence in forge_counters.
ALTER TABLE forge_counters ADD COLUMN task_number INTEGER NOT NULL DEFAULT 0;

-- One Markdown memory index per repository. updated_by is NULL for system revisions.
CREATE TABLE forge_memory_index (
  repository_id TEXT PRIMARY KEY NOT NULL,
  content TEXT NOT NULL,
  guideline_version TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_by TEXT,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE TABLE forge_memory_index_revisions (
  repository_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  guideline_version TEXT NOT NULL,
  updated_by TEXT,
  actor_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository_id, revision),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE forge_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  motivation TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'done', 'abandoned')),
  assignee_kind TEXT CHECK (assignee_kind IN ('user', 'agent')),
  assignee_id TEXT,
  created_by TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repository_id, number),
  CHECK ((assignee_kind IS NULL) = (assignee_id IS NULL)),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_tasks_repo ON forge_tasks(repository_id, number DESC);

-- plan / findings / progress. Rows are created with the task at revision 0.
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

-- An issue or pull request belongs to at most one task.
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
CREATE INDEX idx_forge_task_links_task ON forge_task_links(task_id, created_at);

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
CREATE INDEX idx_forge_task_commits_task ON forge_task_commits(task_id, bound_at);

-- Assignee and reviewer sets for issues and pull requests. assignee_id points at
-- users.id or auth_agents.id depending on assignee_kind, so it has no foreign key.
CREATE TABLE forge_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('issue', 'pull_request')),
  target_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('assignee', 'reviewer')),
  assignee_kind TEXT NOT NULL CHECK (assignee_kind IN ('user', 'agent')),
  assignee_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (target_kind, target_id, role, assignee_kind, assignee_id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_assignments_target ON forge_assignments(target_kind, target_id);
CREATE INDEX idx_forge_assignments_assignee ON forge_assignments(assignee_kind, assignee_id, created_at DESC);

-- Existing string assignees that match a member of the repository's namespace become user assignments; the rest are dropped.
INSERT OR IGNORE INTO forge_assignments (id, repository_id, target_kind, target_id, role, assignee_kind, assignee_id, assigned_by, created_at)
SELECT lower(hex(randomblob(16))), forge_issues.repository_id, 'issue', forge_issues.id, 'assignee', 'user', users.id, forge_issues.author_id, forge_issues.updated_at
FROM forge_issues, json_each(forge_issues.assignees_json)
JOIN users ON users.identifier = json_each.value
JOIN repositories ON repositories.id = forge_issues.repository_id
JOIN namespace_memberships ON namespace_memberships.user_id = users.id AND namespace_memberships.namespace_id = repositories.namespace_id;
ALTER TABLE forge_issues DROP COLUMN assignees_json;
