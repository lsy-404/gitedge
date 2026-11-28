CREATE TABLE auth_sso_requests_next (
  state_hash TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('login', 'link', 'logout', 'reauth')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT,
  return_to TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
INSERT INTO auth_sso_requests_next (state_hash,provider_id,issuer,browser_hash,intent,user_id,session_hash,return_to,callback_url,payload,created_at,expires_at)
SELECT state_hash,provider_id,issuer,browser_hash,intent,user_id,session_hash,return_to,callback_url,payload,created_at,expires_at
FROM auth_sso_requests;
DROP TABLE auth_sso_requests;
ALTER TABLE auth_sso_requests_next RENAME TO auth_sso_requests;
CREATE INDEX idx_sso_requests_expiry ON auth_sso_requests(expires_at);
