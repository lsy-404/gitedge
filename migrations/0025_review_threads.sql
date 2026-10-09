CREATE TABLE forge_review_comments (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  pull_request_id TEXT NOT NULL,
  review_id TEXT,
  in_reply_to TEXT,
  actor_json TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  author_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
  line INTEGER NOT NULL CHECK (line >= 1),
  start_line INTEGER CHECK (start_line IS NULL OR (start_line >= 1 AND start_line <= line)),
  diff_hunk TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  resolved_at INTEGER,
  resolved_by_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (review_id) REFERENCES forge_reviews(id) ON DELETE SET NULL,
  FOREIGN KEY (in_reply_to) REFERENCES forge_review_comments(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_forge_review_comments_pull ON forge_review_comments(pull_request_id, created_at);
CREATE INDEX idx_forge_review_comments_thread ON forge_review_comments(in_reply_to);

ALTER TABLE repository_branch_rules ADD COLUMN require_conversation_resolution INTEGER NOT NULL DEFAULT 0;

CREATE TABLE forge_pull_request_links (
  pull_request_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  closes INTEGER NOT NULL DEFAULT 0 CHECK (closes IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pull_request_id, issue_id),
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES forge_issues(id) ON DELETE CASCADE
);
CREATE INDEX idx_forge_pull_request_links_issue ON forge_pull_request_links(issue_id);

CREATE TABLE forge_issue_events (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('closed_by_pull_request')),
  pull_request_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES forge_issues(id) ON DELETE CASCADE,
  FOREIGN KEY (pull_request_id) REFERENCES forge_pull_requests(id) ON DELETE CASCADE
);
CREATE INDEX idx_forge_issue_events_issue ON forge_issue_events(issue_id, created_at);
