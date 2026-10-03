ALTER TABLE auth_agents ADD COLUMN handle TEXT;
ALTER TABLE auth_agents ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0 CHECK(profile_public IN (0, 1));
ALTER TABLE auth_agents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
WITH RECURSIVE normalized(id, user_id, name, position, slug) AS (
  SELECT id, user_id, name, 0, '' FROM auth_agents
  UNION ALL
  SELECT id, user_id, name, position + 1,
    slug || CASE
      WHEN lower(substr(name, position + 1, 1)) GLOB '[a-z0-9]'
        THEN lower(substr(name, position + 1, 1))
      WHEN slug = '' OR substr(slug, -1, 1) = '-'
        THEN ''
      ELSE '-'
    END
  FROM normalized
  WHERE position < length(name)
), handles AS (
  SELECT normalized.id,
    substr(CASE WHEN trim(normalized.slug, '-') = '' THEN 'agent' ELSE trim(normalized.slug, '-') END, 1, 34)
      || '-' || row_number() OVER (PARTITION BY normalized.user_id ORDER BY auth_agents.created_at, auth_agents.id) AS handle
  FROM normalized
  JOIN auth_agents ON auth_agents.id = normalized.id
  WHERE normalized.position = length(normalized.name)
)
UPDATE auth_agents
SET handle = (SELECT handles.handle FROM handles WHERE handles.id = auth_agents.id),
    updated_at = created_at;
CREATE UNIQUE INDEX idx_auth_agents_owner_handle ON auth_agents(user_id, handle);

CREATE TABLE auth_agent_webhooks (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  secret_ciphertext TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE auth_agent_webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'success', 'failed')),
  response_status INTEGER,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_agent_webhook_deliveries_agent ON auth_agent_webhook_deliveries(agent_id, created_at DESC);

CREATE TABLE auth_agent_events (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL REFERENCES auth_agents(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK(event IN ('agent.assigned', 'agent.mentioned', 'pull_request.updated')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivery_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'delivered', 'dropped', 'dead')),
  lease_until INTEGER,
  error_code TEXT
);
CREATE INDEX idx_agent_events_ready ON auth_agent_events(status, next_attempt_at, created_at);
CREATE INDEX idx_agent_events_agent ON auth_agent_events(agent_id, created_at DESC);
