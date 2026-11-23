ALTER TABLE actions_runners ADD COLUMN runner_type TEXT NOT NULL DEFAULT 'owned' CHECK (runner_type IN ('owned', 'rented'));

CREATE TABLE actions_runner_settings (
  namespace_id TEXT PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  type_priority_json TEXT NOT NULL,
  github_included_usd REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE actions_github_quota (
  namespace_id TEXT PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  included_used_usd REAL NOT NULL DEFAULT 0,
  paid_usd REAL NOT NULL DEFAULT 0,
  minutes_json TEXT NOT NULL DEFAULT '[]',
  message TEXT,
  checked_at INTEGER
);
