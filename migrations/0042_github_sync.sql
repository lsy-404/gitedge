CREATE TABLE forge_github_connections (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repositories(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  github_repository_id INTEGER NOT NULL,
  github_private INTEGER NOT NULL CHECK (github_private IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  hook_id INTEGER,
  callback_url TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  lease TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(github_repository_id, callback_url)
);
CREATE TABLE forge_github_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'conflict', 'failed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX idx_github_jobs_due ON forge_github_jobs(status, next_attempt_at);
CREATE INDEX idx_github_jobs_connection ON forge_github_jobs(connection_id, created_at DESC);
CREATE TABLE forge_github_ref_transfers (
  job_id TEXT NOT NULL REFERENCES forge_github_jobs(id) ON DELETE CASCADE,
  artifact_name TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  session_id TEXT,
  ref TEXT NOT NULL,
  before_oid TEXT NOT NULL,
  after_oid TEXT NOT NULL,
  reported_at INTEGER,
  PRIMARY KEY (job_id, artifact_name, ref, after_oid)
);
CREATE TABLE forge_github_mappings (
  connection_id TEXT NOT NULL REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request', 'comment', 'review', 'review_comment')),
  local_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_number INTEGER,
  remote_fingerprint TEXT,
  local_fingerprint TEXT,
  remote_updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, kind, local_id),
  UNIQUE(connection_id, kind, remote_id)
);
CREATE TABLE forge_github_inbound (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES forge_github_connections(id) ON DELETE CASCADE,
  guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT github_sync_guard CHECK (guard=1)
);

CREATE TRIGGER github_push_accepted AFTER UPDATE OF accepted ON forge_push_event_refs
WHEN NEW.accepted=1 AND OLD.accepted=0 AND NEW.session_id='' AND (NEW.ref LIKE 'refs/heads/%' OR NEW.ref LIKE 'refs/tags/%')
BEGIN
  INSERT OR IGNORE INTO forge_github_jobs (id,connection_id,direction,event,payload,status,next_attempt_at,created_at)
  SELECT 'push:'||NEW.event_id||':'||NEW.ref,c.id,'outbound','push',json_object('ref',NEW.ref,'before',NEW.before_oid,'after',NEW.after_oid),'pending',NEW.created_at,NEW.created_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id AND c.enabled=1;
END;
CREATE TRIGGER github_published_head AFTER INSERT ON forge_pull_head_updates
BEGIN
  INSERT INTO forge_github_jobs (id,connection_id,direction,event,payload,status,next_attempt_at,created_at)
  SELECT lower(hex(randomblob(16))),c.id,'outbound','pull_request',json_object('kind','pull_request','action','upsert','id',NEW.pull_request_id),'pending',NEW.created_at,NEW.created_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id AND c.enabled=1;
END;

CREATE TRIGGER github_issue_insert AFTER INSERT ON forge_issues
WHEN EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'issue', json_object('kind','issue','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_issue_update AFTER UPDATE OF title, body, state, labels_json ON forge_issues
WHEN EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'issue', json_object('kind','issue','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_pull_insert AFTER INSERT ON forge_pull_requests
WHEN EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'pull_request', json_object('kind','pull_request','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_pull_update AFTER UPDATE OF title, body, state, draft, head_ref, base_ref ON forge_pull_requests
WHEN EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'pull_request', json_object('kind','pull_request','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_comment_insert AFTER INSERT ON forge_comments
WHEN NEW.target_kind IN ('issue','pull_request') AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'comment', json_object('kind','comment','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_comment_update AFTER UPDATE OF body ON forge_comments
WHEN NEW.target_kind IN ('issue','pull_request') AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'comment', json_object('kind','comment','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_comment_delete AFTER DELETE ON forge_comments
WHEN OLD.target_kind IN ('issue','pull_request') AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = OLD.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'comment', json_object('kind','comment','action','delete','id',OLD.id), 'pending', CAST(unixepoch('subsec')*1000 AS INTEGER), CAST(unixepoch('subsec')*1000 AS INTEGER) FROM forge_github_connections c WHERE c.repository_id=OLD.repository_id;
END;
CREATE TRIGGER github_review_insert AFTER INSERT ON forge_reviews
WHEN EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'review', json_object('kind','review','action','upsert','id',NEW.id), 'pending', NEW.created_at, NEW.created_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_review_comment_insert AFTER INSERT ON forge_review_comments
WHEN NEW.pending=0 AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'review_comment', json_object('kind','review_comment','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_review_comment_update AFTER UPDATE OF body, pending ON forge_review_comments
WHEN NEW.pending=0 AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = NEW.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'review_comment', json_object('kind','review_comment','action','upsert','id',NEW.id), 'pending', NEW.updated_at, NEW.updated_at FROM forge_github_connections c WHERE c.repository_id=NEW.repository_id;
END;
CREATE TRIGGER github_review_comment_delete AFTER DELETE ON forge_review_comments
WHEN OLD.pending=0 AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.repository_id = OLD.repository_id AND c.enabled = 1 AND NOT EXISTS (SELECT 1 FROM forge_github_inbound i WHERE i.connection_id=c.id))
BEGIN
  INSERT INTO forge_github_jobs (id, connection_id, direction, event, payload, status, next_attempt_at, created_at)
  SELECT lower(hex(randomblob(16))), c.id, 'outbound', 'review_comment', json_object('kind','review_comment','action','delete','id',OLD.id), 'pending', CAST(unixepoch('subsec')*1000 AS INTEGER), CAST(unixepoch('subsec')*1000 AS INTEGER) FROM forge_github_connections c WHERE c.repository_id=OLD.repository_id;
END;
