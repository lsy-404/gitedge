# API endpoints

Responses use `{ "data": ... }`; failures use `{ "error": { "code": ..., "message": ... } }`. Private repository existence is hidden from unauthorized readers.

Auth: register, login, logout, session and identity-only GitHub OAuth under `/api/auth`. Account agent CRUD lives at `/api/auth/agents`; each agent's session collection lives at `/api/auth/agents/:id/sessions`. Sessions return API/Git credentials once. Account Git credentials live at `/api/auth/tokens`. SSO provider discovery, login, metadata, identity linking and single sign-out live under `/api/auth/sso`; see [SSO configuration](sso.md). Signing keys are listed, added and revoked at `/api/auth/signing-keys` (with `/signing-keys/challenges`); `/api/auth/profile` and `/api/auth/agent-profiles/:owner/:handle` expose profiles.

Account security (Auth, browser sessions only): `POST /api/auth/login` returns either the user or `{ secondFactorRequired, mfaToken, methods }`; finish with `POST /login/second-factor` (`/login/second-factor/options` prepares a passkey prompt). Passkey sign-in is `POST /login/passkey/options` then `/login/passkey`. Recovery: `GET /recovery/options`, `POST /recovery/password` (username and recovery code), `POST /recovery/email` (always 202) and `POST /recovery/email/confirm`; `POST /email/verify` spends a verification link. Signed-in management lives under `GET /security` (summary), `POST /reauth` and `/reauth/passkey/options` (confirm identity for 10 minutes), `POST /security/password`, `PUT|DELETE /security/email`, `POST /security/totp`, `/security/totp/confirm`, `/security/totp/disable`, `POST /security/recovery-codes` and `/security/passkeys[/options]` with `PATCH|DELETE /security/passkeys/:id`. Sensitive routes answer 403 `reauth_required` outside the confirmation window. See [account security](account-security.md).

Forge: `/api/forge/repositories`, `/repositories/by-name/:owner/:repo`, and organization/member management. Repository resources are `/repositories/:id/issues`, `/pull-requests`, `/discussions`, `/wiki`, `/settings`, `/tasks`, `/memory` (404 `feature_disabled` when tasks are off), `/assignee-candidates`, `/branch-rules` and `/collaborators`. Numbered items expose details, PATCH and comments. PRs expose `diff`, `reviews`, `checks` and `merge`; merge requires expected base/head OIDs. Wiki pages expose history and revision-aware PUT/restore.

Git: `/api/git/repositories/:id/refs`, `tree`, `file`, `raw`, `commits`, `graph` and `compare`. Reads accept appropriate `ref`, `path`, `offset` or `limit` queries. Comparisons accept `base`, `head` and a validated `headSessionId`. Agent sessions operate on their own workspace by default.

Actions: `/api/actions/repositories/:id[/...]`, `/api/actions/runs/:id` and `/api/actions/runs/:id/cancel`.

Deploy: `/api/deploy/plan`, `session`, `account`, `resources`, `provision`, `migrate` and `deploy`. See [the deployment manifest](deploy.md) for source and permission requirements.
