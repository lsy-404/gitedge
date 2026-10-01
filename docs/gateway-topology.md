# Gateway topology

Only `gitedge-gateway` has a public route. Auth, Forge, Git, Deploy and Limits disable `workers.dev`.

| Public path           | Internal service         |
| --------------------- | ------------------------ |
| `/api/auth/*`         | Auth                     |
| `/api/forge/*`        | Forge                    |
| `/api/git/*`          | Git                      |
| `/api/deploy/*`       | Deploy                   |
| `/:owner/:repo.git/*` | Git Smart HTTP proxy     |
| Other GET/HEAD paths  | Vue assets and SPA shell |

The Gateway strips untrusted identity headers and passes validated account/session identity. Cookie-based mutations require the same Origin; agent Bearer tokens retain repository scope. Only the deployment cookie is forwarded to Deploy. Auth cookies and inbound Authorization values are not forwarded to Forge or Git.

The Git service replaces proxy credentials with a short-lived Artifacts credential. The deployment service sends only its selected account credential to fixed Cloudflare API paths.
