# API endpoints

Responses use `{ "data": ... }`; failures use `{ "error": { "code": ..., "message": ... } }`. Private repository existence is hidden from unauthorized readers.

Gateway: `GET /api/health` (anonymous, per-IP rate limited) returns `{ status: "ok" | "degraded", services: { <name>: { ok, latencyMs } } }` for `auth`, `forge`, `git`, `deploy`, `actions`, `limits` and `d1`, with HTTP 503 when any probe fails. Rate-limited requests receive 429 with a `Retry-After` header and `retryAfter` seconds in the body.

Auth: register, login, logout, session and identity-only GitHub OAuth under `/api/auth`. Account agent CRUD lives at `/api/auth/agents`; each agent's session collection lives at `/api/auth/agents/:id/sessions`. Sessions return API/Git credentials once. Account Git credentials live at `/api/auth/tokens`. SSO provider discovery, login, metadata, identity linking and single sign-out live under `/api/auth/sso`; see [SSO configuration](sso.md). Signing keys are listed, added and revoked at `/api/auth/signing-keys` (with `/signing-keys/challenges`); `/api/auth/profile` and `/api/auth/agent-profiles/:owner/:handle` expose profiles.

Forge: `GET /api/forge/usage` returns the caller's repository count, storage use (`usedBytes` is `null` because Artifacts does not report repository size) and the limits of their user group. Creating a repository beyond the group limit returns 403 `quota_exceeded` with `error.quota` `{ resource, used, limit }`. `/api/forge/repositories`, `/repositories/by-name/:owner/:repo`, and organization/member management. Repository resources are `/repositories/:id/issues`, `/pull-requests`, `/discussions`, `/wiki`, `/settings`, `/tasks`, `/memory` (404 `feature_disabled` when tasks are off), `/assignee-candidates`, `/branch-rules` and `/collaborators`. Numbered items expose details, PATCH and comments. PRs expose `diff`, `reviews`, `checks` and `merge`; merge requires expected base/head OIDs. Wiki pages expose history and revision-aware PUT/restore.

Git: `/api/git/repositories/:id/refs`, `tree`, `file`, `raw`, `commits`, `graph` and `compare`. Reads accept appropriate `ref`, `path`, `offset` or `limit` queries. Comparisons accept `base`, `head` and a validated `headSessionId`. Agent sessions operate on their own workspace by default.

Actions: `/api/actions/repositories/:id[/...]`, `/api/actions/runs/:id` and `/api/actions/runs/:id/cancel`. Starting a run beyond six per repository per hour returns 429 `run_limit` with a `Retry-After` header.

Deploy: `/api/deploy/plan`, `session`, `account`, `resources`, `provision`, `migrate` and `deploy`. See [the deployment manifest](deploy.md) for source and permission requirements.
