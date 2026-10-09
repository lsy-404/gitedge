-- Delivery channel per agent: signed webhooks, the pull feed, or both.
ALTER TABLE auth_agents ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'webhook' CHECK (delivery_mode IN ('webhook', 'pull', 'both'));

-- Session renewal bookkeeping; the lifetime ceiling derives from created_at.
ALTER TABLE auth_agent_sessions ADD COLUMN renewal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_agent_sessions ADD COLUMN renewed_at INTEGER;

-- Task claim lease. All three columns are NULL when the task is not claimed.
ALTER TABLE forge_tasks ADD COLUMN lease_agent_id TEXT;
ALTER TABLE forge_tasks ADD COLUMN lease_claimed_at INTEGER;
ALTER TABLE forge_tasks ADD COLUMN lease_expires_at INTEGER;
CREATE INDEX idx_forge_tasks_lease ON forge_tasks(lease_expires_at) WHERE lease_expires_at IS NOT NULL;

-- The webhook outbox now carries every agent event name, so the event CHECK is dropped.
CREATE TABLE auth_agent_events_rebuilt (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivery_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'delivered', 'dropped', 'dead')),
  lease_until INTEGER,
  error_code TEXT
);
INSERT INTO auth_agent_events_rebuilt (id, agent_id, repository_id, actor_user_id, event, payload, created_at, next_attempt_at, attempts, delivery_id, status, lease_until, error_code)
SELECT id, agent_id, repository_id, actor_user_id, event, payload, created_at, next_attempt_at, attempts, delivery_id, status, lease_until, error_code FROM auth_agent_events;
DROP TABLE auth_agent_events;
ALTER TABLE auth_agent_events_rebuilt RENAME TO auth_agent_events;
CREATE INDEX idx_agent_events_ready ON auth_agent_events(status, next_attempt_at, created_at);
CREATE INDEX idx_agent_events_agent ON auth_agent_events(agent_id, created_at DESC);

-- Pull feed. AUTOINCREMENT keeps ids monotonic across pruning, so an id doubles as the cursor.
CREATE TABLE forge_agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_forge_agent_events_feed ON forge_agent_events(agent_id, repository_id, id);
CREATE INDEX idx_forge_agent_events_age ON forge_agent_events(created_at);

-- pruned_through is the highest event id removed from the feed; older cursors are expired.
CREATE TABLE forge_agent_feed_state (
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pruned_through INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, repository_id)
);
