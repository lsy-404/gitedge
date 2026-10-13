# Operations

Runbook for backup, restore, migration and incident response. Run commands from the repository root; production commands need `CLOUDFLARE_ACCOUNT_ID` for the account in the Worker configs and a Wrangler login with access to it.

## What holds state

| Data                                                                      | Where                              | Recovery                             |
| ------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------ |
| Accounts, sessions, credential hashes, Issues, PRs, reviews, checks, wiki | D1 database `gitedge`              | D1 Time Travel, SQL export           |
| Git objects and refs                                                      | Cloudflare Artifacts               | Git mirrors you keep (see below)     |
| Release assets and Actions output                                         | R2 bucket `gitedge-release-assets` | Not versioned; re-upload from builds |
| Rate-limit windows                                                        | `gitedge-limits` Durable Objects   | Disposable; resets after one minute  |
| Action run state                                                          | `gitedge-actions` Durable Objects  | Disposable; rerun the workflow       |
| Worker secrets                                                            | Cloudflare secrets                 | Re-enter from your secret store      |

D1 and Artifacts are separate systems. A D1 restore does not touch Git data, and the two can drift apart: a repository row can point at an Artifacts repository that was created after the restore point. Record the restore timestamp and compare the `repositories` table with Artifacts afterwards.

## D1 Time Travel

Time Travel keeps point-in-time history of the database automatically (30 days on the Workers Paid plan, 7 days on Free). No setup is required.

```sh
# Inspect the current bookmark and the oldest restorable point
pnpm exec wrangler d1 time-travel info gitedge --config workers/auth/wrangler.jsonc

# Find the bookmark for a moment before the incident
pnpm exec wrangler d1 time-travel info gitedge --config workers/auth/wrangler.jsonc --timestamp=2026-10-09T08:00:00Z

# Restore in place (irreversible except by restoring again from the printed previous bookmark)
pnpm exec wrangler d1 time-travel restore gitedge --config workers/auth/wrangler.jsonc --timestamp=2026-10-09T08:00:00Z
```

Restoring replaces the whole database, including accounts and sessions created after the timestamp. Write down the bookmark that `restore` prints as the previous state so the restore itself can be undone. Pause traffic first when possible: deploy nothing, and expect users to be signed out if their session rows are older or newer than the restore point.

## Scheduled exports

Time Travel is not an offsite copy. Export the database on a schedule and keep the files outside Cloudflare.

```sh
pnpm exec wrangler d1 export gitedge --remote --config workers/auth/wrangler.jsonc \
  --output "backups/gitedge-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

An export blocks other queries on the database while it runs, so schedule it in a quiet window (for example daily at 03:00 UTC from a CI schedule or a cron host). Use `--no-data` for a schema-only export and `--table <name>` for a single table. Exported files contain credential hashes and personal data: encrypt them at rest, restrict access and expire old copies.

To restore from a file into a new database, create the database, then run `pnpm exec wrangler d1 execute <name> --remote --file backups/<file>.sql`, update `database_id` in the Worker configs, and redeploy.

## Verified backup and isolated rehearsal

Use the repository CLI to capture D1 SQL and its Time Travel bookmark, mirror every D1-mapped Artifacts repository and agent session fork, and copy every tracked release asset, Actions artifact and dependency cache. It records SHA-256 hashes, mirror refs, repository mappings, start/end timestamps, and a before/after inventory fingerprint. D1, Artifacts, and R2 do not share an atomic snapshot; if inventory changes or any component fails, the command exits with status 2 and marks the manifest incomplete. Treat the SQL and release files as sensitive data. Keep the backup directory encrypted and access-controlled.

Set `CLOUDFLARE_ACCOUNT_ID` for the source account, `CLOUDFLARE_API_TOKEN` with Artifacts token creation/read access, and authenticate Wrangler for the same account. The CLI creates a 10-minute read token for each Artifacts repository and session fork, passes it only in the Git child process environment, then revokes it. It does not depend on agent-session plaintext credentials. A token revocation failure is surfaced as a backup failure. Prepare a brand-new empty destination D1 database, a destination Wrangler config whose account and D1 IDs point to it, an empty Artifacts namespace, and a distinct empty R2 bucket before a rehearsal.

```sh
pnpm run recovery -- backup --output /secure/backups/gitedge-20261012 --base-url https://gitedge.example
pnpm run recovery -- verify --backup /secure/backups/gitedge-20261012
pnpm run recovery -- rehearse --backup /secure/backups/gitedge-20261012 \
  --destination-db gitedge-rehearsal \
  --destination-config workers/auth/wrangler-rehearsal.jsonc \
  --destination-base-url https://gitedge-rehearsal.example \
  --destination-release-bucket gitedge-rehearsal-release-assets \
  --destination-account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --destination-artifacts-namespace gitedge-rehearsal
```

The rehearsal refuses the source D1 ID/name, source GitEdge host, source R2 bucket, and source Artifacts namespace. It restores only to the named resources, creates repository and session-fork mirrors in the empty destination namespace, and revokes temporary Git tokens. Do not point destination config at production. After the command succeeds, verify the D1 `repositories` IDs and `artifact_name` values against destination mirrors, inspect refs, check release asset counts and hashes, deploy the rehearsal workers against destination bindings, then exercise sign-in, repository listing, clone/push, session fork access, release downloads, and a representative collaboration flow. Destroy the rehearsal resources only after recording those results.

`verify` checks every file size/hash and runs `git fsck --full` plus ref comparison for every mirror. A successful verification proves the local backup bytes are intact; it does not prove a real Cloudflare restore or application recovery. No account-backed backup or recovery rehearsal is run as part of build or CI.

## Artifacts repositories

The Artifacts binding exposes repositories only through Git: there is no bulk export or snapshot API. Protect Git data with mirrors that you control.

1. List repositories from the D1 export (`repositories.slug`, `namespaces.slug`) or from the product.
2. For each repository, create a read-only Git credential in Account settings, then mirror it:

   ```sh
   git clone --mirror https://<host>/<owner>/<repository>.git
   git -C <repository>.git remote update --prune
   ```

3. Run the update on a schedule, and optionally push the mirror to a second Git host with `git push --mirror`.
4. Keep credentials in a credential helper or environment variable, never in the remote URL, and revoke them when the mirror is retired.

To recover a lost repository, create it again in GitEdge and `git push --mirror` the saved copy. Pull request heads that existed only as unpublished agent session forks are not part of a mirror of the main repository.

## Export before migrating

Before any remote migration:

1. Export the database as above and confirm the file is non-empty and contains the expected tables.
2. Note the Time Travel bookmark (`d1 time-travel info`).
3. Run `pnpm run check:migrations`; it fails on duplicate numbers, malformed names and new gaps (the historical 0017 gap is allowlisted).
4. Review the SQL of every pending migration. Migrations are forward-only, so a bad one is undone by a Time Travel restore, not by a down script.

CI runs `check:migrations` on every push.

## Deploy order

`pnpm run deploy` (`scripts/deploy-stack.mjs`) is the supported path. It builds the web app, applies D1 migrations, and deploys the Workers in dependency order:

1. `limits`
2. `auth`
3. `forge`
4. `git`
5. `actions`
6. `deploy`
7. `mcp`
8. `gateway`

The Gateway goes last because it is the only public entrypoint and binds every other Worker. On an empty account the script first creates placeholder Workers for `git`, `forge` and `actions`, which bind each other, and for `gateway`, which `mcp` binds back. Run `pnpm run build` (dry run) before deploying. To roll back a single Worker, redeploy the previous commit for that Worker in the same order; schema changes are rolled back only through Time Travel.

## Health check

`GET /api/health` on the Gateway probes `auth`, `forge`, `git`, `deploy`, `actions`, the rate limiter (`limits`) and D1 one after another, each with a two-second timeout. It returns 200 with `status: "ok"` when every probe passes and 503 with `status: "degraded"` otherwise, along with `ok` and `latencyMs` per probe. The Gateway has no D1 binding, so the `d1` probe runs `SELECT 1` through Forge and also fails when Forge is down. The `deploy` probe fails while `DEPLOY_SESSION_KEY` is missing or shorter than 32 bytes. Probes check reachability and configuration, not deep service state. The endpoint is anonymous and counts against the normal per-IP rate limit, so poll it no more than once a minute from a monitor.

## Incident checklist

1. Check `GET /api/health` and note which probes fail.
2. Check Cloudflare status and recent deployments (`pnpm exec wrangler deployments list --config workers/<service>/wrangler.jsonc`).
3. Read Worker logs for the failing service; events are scoped kebab-case names such as `gateway:health-probe-unhealthy`.
4. If a deploy caused it, redeploy the last good commit in the order above.
5. If data is damaged, stop writes if possible, take an export of the current state for forensics, then restore with Time Travel and record the timestamp.
6. After a D1 restore, verify sign-in, repository listing and a push/clone against a test repository, and compare `repositories` with Artifacts.
7. If credentials may be exposed, revoke sessions and Git credentials, rotate secrets listed in [configuration](configuration.md), and redeploy.
8. Write down the timeline, root cause and follow-ups once service is stable.
