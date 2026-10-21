ALTER TABLE actions_runners ADD COLUMN capacity_json TEXT;
ALTER TABLE actions_runners ADD COLUMN budget_json TEXT;
ALTER TABLE actions_runners ADD COLUMN capacity_reported_at INTEGER;
ALTER TABLE actions_runners ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actions_runners ADD COLUMN held_until INTEGER;

CREATE TABLE actions_runner_samples (
  runner_id TEXT NOT NULL REFERENCES actions_runners(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  load1 REAL,
  mem_free_mb INTEGER,
  busy INTEGER NOT NULL CHECK (busy IN (0, 1)),
  PRIMARY KEY (runner_id, minute)
);

CREATE TABLE actions_runner_deferrals (
  job_kind TEXT NOT NULL CHECK (job_kind IN ('gitedge', 'github')),
  job_id TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_kind, job_id)
);
