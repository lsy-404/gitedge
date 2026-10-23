CREATE INDEX idx_forge_issues_author_activity
  ON forge_issues(author_id, created_at DESC, id);

CREATE INDEX idx_forge_pull_requests_author_activity
  ON forge_pull_requests(author_id, created_at DESC, id);

CREATE INDEX idx_forge_comments_author_activity
  ON forge_comments(author_id, created_at DESC, id);
