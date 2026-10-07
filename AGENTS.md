# GitEdge

## Project

GitEdge is an MIT Git forge built with Cloudflare Workers, Artifacts, D1 and Vue 3. Read the live source and [PRODUCT.md](PRODUCT.md) before changing behavior or visual design. `CLAUDE.md` links to this file; do not overwrite it separately.

## Engineering rules

- Inspect `git status --short` and existing worktrees first. Preserve unrelated changes.
- Reuse canonical contracts in `packages/contracts/src/` and official Cloudflare types. Do not add `any`, casts, duplicate helpers or `ReturnType` aliases when named types exist.
- Prefer explicit readable code and mature maintained libraries. Keep components focused and remove unused imports.
- Keep technical comments concise and synchronized with behavior. Do not leave milestone language, task identifiers or provenance in source comments.
- Prefer `cloudflare-docs` MCP for current platform documentation, with official web documentation as fallback.
- Use `createLogger` from `src/worker/common/logger.ts` on non-trivial platform operations and failure branches. Use scoped kebab-case events and structured context; never log credentials.
- Keep platform calls bounded and sequential where appropriate. Respect Workers subrequest, connection, memory and CPU limits; report truncation rather than silently returning incomplete results.
- Keep Durable Object mutations transactional within their object. Avoid transitive Worker → DO → storage operations, distributed transactions and `blockConcurrencyWhile` in RPC methods. Use tagged outcomes for expected DO failures.

## Ownership and boundaries

- `workers/gateway/` is the only public entrypoint. It owns trusted identity headers, same-origin checks, rate limiting, service routing and SPA assets.
- `workers/auth/` owns human authentication, Git credentials, agent identities and session lifecycle.
- `workers/forge/` owns organization membership and D1 collaboration records: Issues, PRs, Discussions, Wiki, reviews and checks.
- `workers/git/` owns Artifacts reads, native Git transport, comparisons and merges. Artifacts is the sole authority for Git objects and refs; do not reintroduce custom pack or repository storage.
- `workers/deploy/` interprets a declarative manifest and sends bounded Cloudflare API operations. It must not execute repository-supplied scripts.
- `workers/limits/` owns the request-limiting Durable Objects.
- `workers/actions/` owns bounded workflow execution and per-run Containers; Forge owns CI check records. Its Durable Objects use only their own storage and container.
- `apps/web/` contains Vue components, route-level pages and i18n text. Shared API contracts live in `packages/contracts/`.
- `migrations/` contains D1 schema definitions; `test/` contains all tests. Persistent task decisions and operational evidence belong only in `/agents`.

## Security and correctness

- Strip inbound trust headers at the Gateway. Validate agent repository scope, current membership, expiry and disabled/revoked state in privileged services.
- Public repositories permit anonymous reads. Private repositories default to 404 for unauthorized readers; Gateway may explicitly configure 403 without exposing contents.
- Each agent session has its own Artifacts fork. Publishing a PR permits reading its selected head, not arbitrary unpublished fork branches.
- Revoke initial Artifacts creation/fork tokens before issuing scoped credentials. API/Git plaintext is returned once; store only credential hashes in D1. Do not provide untracked token-minting endpoints.
- Use disposable Artifacts handles and the official binding contract. `get()` returns a capability; use `info()` for metadata.
- Git transport remains streamed. Merge verifies expected base/head OIDs and uses atomic non-force ref updates. Reviews and checks apply to their exact commit OID.
- Cloudflare deployment credentials remain in an encrypted, short-lived HttpOnly cookie scoped to Deploy. Bind source digest, account, repository, user and nonce, and recheck them before mutation.
- Only a confirmed successful API result verifies deployment. Build, dry-run, test fixtures and production behavior are separate validation boundaries.

## Validation

Use the smallest relevant checks while editing, then verify affected integration paths before delivery:

```sh
pnpm run typecheck
pnpm run test
pnpm run test:workers
pnpm run test:web
pnpm run build
pnpm run format:check
```

`build` compiles Vue and dry-runs all Workers. `test:auth` runs the Auth worker tests (agents, accounts, SSO, signatures). `test:web` runs browser-oriented Vue tests. With the local stack running, `node test/e2e/api-git.mjs` exercises real Artifacts push/clone, isolated agents and collaboration. It creates verification repositories in the configured namespace. CI runs the commands above; the `test/e2e`, `test/artifacts-smoke`, `test/performance` and `test/production-receiver` scripts are manual checks against a running stack or a real account.

Local Artifacts bindings connect remotely. Production deployment is separate from local verification; preserve existing storage until repository import and data transfer have been verified.
