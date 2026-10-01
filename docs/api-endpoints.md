# API endpoints

Responses use `{ "data": ... }`; failures use `{ "error": { "code": ..., "message": ... } }`. Private repository existence is hidden from unauthorized readers.

Auth: register, login, logout, session and GitHub OAuth under `/api/auth`. Account agent CRUD lives at `/api/auth/agents`; each agent's session collection lives at `/api/auth/agents/:id/sessions`. Sessions return API/Git credentials once. Account Git credentials live at `/api/auth/tokens`.

Forge: `/api/forge/repositories`, `/repositories/by-name/:owner/:repo`, and organization/member management. Repository resources are `/repositories/:id/issues`, `/pull-requests`, `/discussions` and `/wiki`. Numbered items expose details, PATCH and comments. PRs expose `diff`, `reviews`, `checks` and `merge`; merge requires expected base/head OIDs. Wiki pages expose history and revision-aware PUT/restore.

Git: `/api/git/repositories/:id/refs`, `tree`, `file`, `raw`, `commits`, `graph` and `compare`. Reads accept appropriate `ref`, `path`, `offset` or `limit` queries. Comparisons accept `base`, `head` and a validated `headSessionId`. Agent sessions operate on their own workspace by default.

Deploy: `/api/deploy/plan`, `session`, `account`, `resources`, `provision`, `migrate` and `deploy`. See [the deployment manifest](deploy.md) for source and permission requirements.
