# Repository deployment manifest

GitEdge can deploy a repository ref to a Cloudflare account through the repository page's deployment wizard. The Deploy Worker reads `gitedge.deploy.json` from that ref and interprets only the fixed schema below. It never executes repository supplied JavaScript.

```json
{
  "schema": 1,
  "name": "Example service",
  "license": { "id": "MIT", "text": "MIT License\n..." },
  "terms": { "required": true, "text": "Deploying this service accepts these terms." },
  "worker": {
    "name": "example-service",
    "entrypoint": "worker/index.js",
    "modules": ["worker/index.js", "worker/router.js"],
    "compatibilityDate": "2026-10-01",
    "compatibilityFlags": ["nodejs_compat"],
    "vars": { "PUBLIC_MODE": "true" }
  },
  "resources": {
    "d1": [
      {
        "id": "db",
        "binding": "DB",
        "name": "example-db",
        "migrations": ["migrations/0001_init.sql"]
      }
    ],
    "r2": [{ "id": "files", "binding": "FILES", "name": "example-files" }],
    "kv": [{ "id": "cache", "binding": "CACHE", "name": "example-cache" }]
  }
}
```

All top-level and nested fields are schema checked. A manifest may declare up to eight resources and sixteen combined module/migration files. Resource names are lowercase Cloudflare names; binding names are JavaScript identifiers. Migration paths must be simple repository-relative `.sql` paths. The worker entrypoint is uploaded as a JavaScript module. Deployment succeeds only after workers.dev activation and readback of the actual enabled URL. If activation fails after upload, the encrypted session remains available for retry. Resource provisioning is idempotent by exact name, and successful resource IDs are retained in the encrypted short-lived browser session so users can retry after a partial failure.

The manifest permission list is derived from its declared resources and displayed before token entry. Cloudflare token scopes must include Account Settings Read plus Workers Scripts Write/Read, and the relevant D1, Workers R2 Storage, or Workers KV Storage Write/Read scopes. A token that cannot list accounts is rejected. Tokens are encrypted in an HttpOnly, Secure, SameSite=Strict cookie, never returned to the browser JavaScript, logged, or persisted in D1. Set a random `DEPLOY_SESSION_KEY` secret of at least 32 characters with `pnpm exec wrangler secret put DEPLOY_SESSION_KEY --config workers/deploy/wrangler.jsonc`. Agent sessions cannot establish deployment sessions.

Deploy API requests are only accepted through the trusted Gateway service binding, require same-origin requests and a per-session nonce on each mutation, re-check the user's repository ownership and a digest of the manifest plus every declared module/migration file on each operation, and bind the encrypted session to one user, repository, ref, and Cloudflare account. The Cloudflare token remains valid at Cloudflare until the user revokes it; clearing the GitEdge session cookie ends GitEdge's use of it. Migrations are identified by their declared path and should be immutable after they have been applied.

## Supported operations

- Read and validate the manifest for a repository ref.
- Establish a short-lived encrypted deployment session and choose an account available to the token.
- Reuse or create declared D1 databases, R2 buckets, and KV namespaces.
- Apply declared D1 migrations with a database ledger to make retries idempotent.
- Upload the JavaScript entrypoint and declared modules, then bind declared resources and plain-text vars.
- Snapshot declared module and migration file digests into the reviewed plan so a moved branch ref cannot silently change the deployment source.

Static asset trees, Durable Objects, secret bindings, custom domains, arbitrary build commands, and package installation are not part of schema 1.
