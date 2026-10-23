ALTER TABLE actions_runners ADD COLUMN connected INTEGER NOT NULL DEFAULT 0;
UPDATE actions_runners SET connected = 0;
