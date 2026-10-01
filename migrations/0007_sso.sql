CREATE TABLE auth_sso_identities (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  session_index TEXT,
  name_id_format TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  UNIQUE(provider_id, issuer, subject)
);
CREATE INDEX idx_sso_identities_user ON auth_sso_identities(user_id);

CREATE TABLE auth_sso_requests (
  state_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link', 'logout')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT,
  return_to TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sso_requests_expiry ON auth_sso_requests(expires_at);

CREATE TABLE auth_sso_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES auth_sso_identities(id) ON DELETE CASCADE
);
ALTER TABLE github_oauth_states ADD COLUMN browser_hash TEXT NOT NULL DEFAULT '';
