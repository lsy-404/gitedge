DROP TRIGGER actions_runners_signing_scope_insert;
DROP TRIGGER actions_runners_signing_scope_update;

ALTER TABLE actions_runners DROP COLUMN execution_class;
ALTER TABLE actions_runners DROP COLUMN signing_platform;
ALTER TABLE actions_runners DROP COLUMN dedicated_host_confirmed;
ALTER TABLE actions_runners DROP COLUMN operator_approved_at;
ALTER TABLE actions_runners DROP COLUMN operator_approved_by;
ALTER TABLE actions_signing_runs DROP COLUMN operator_approved_at;
ALTER TABLE actions_signing_runs DROP COLUMN operator_approved_by;

UPDATE actions_runner_runs
SET labels_json=json_array('self-hosted','Windows','need-tool-node','need-tool-python')
WHERE status='queued' AND run_id IN (SELECT run_id FROM actions_signing_runs WHERE platform='windows');
UPDATE actions_runner_runs
SET labels_json=json_array('self-hosted','macOS','need-tool-node','need-tool-python')
WHERE status='queued' AND run_id IN (SELECT run_id FROM actions_signing_runs WHERE platform='macos');
UPDATE actions_runner_runs
SET labels_json=json_array('self-hosted','macOS','ARM64','need-tool-node','need-tool-python')
WHERE status='queued' AND run_id IN (SELECT run_id FROM actions_signing_runs WHERE platform='ios');
