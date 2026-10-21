ALTER TABLE actions_signing_runs ADD COLUMN last_reconciled_at INTEGER;

CREATE INDEX actions_signing_reconcile_fairness
  ON actions_signing_runs(reconcile_state, last_reconciled_at, created_at);
