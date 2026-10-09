ALTER TABLE auth_signing_keys ADD COLUMN format TEXT NOT NULL DEFAULT 'openpgp' CHECK (format IN ('openpgp', 'ssh'));
