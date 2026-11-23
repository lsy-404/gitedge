ALTER TABLE actions_runner_settings RENAME COLUMN type_priority_json TO slot_priority_json;
ALTER TABLE actions_runner_settings ADD COLUMN on_demand_priority_json TEXT NOT NULL DEFAULT '["github-hosted","colab"]';
UPDATE actions_runner_settings SET on_demand_priority_json = '["colab","github-hosted"]'
  WHERE json_valid(slot_priority_json)
    AND (SELECT key FROM json_each(slot_priority_json) WHERE value = 'colab')
      < (SELECT key FROM json_each(slot_priority_json) WHERE value = 'github-hosted');
UPDATE actions_runner_settings SET slot_priority_json = '["rented","owned"]';

ALTER TABLE actions_signing_source_token ADD COLUMN github_login TEXT;
