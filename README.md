# GitEdge

GitEdge is an MIT-licensed Git forge on Cloudflare Workers and Artifacts. The Vue interface supports repositories, Git file browsing and commit graphs, Issues, Pull Requests, Discussions, Wiki revisions, and repository deployment.

Existing public repositories can be imported from an https Git URL with full history from the dashboard or an organization page; the import runs through Artifacts, shows progress and can be retried after a failure. Private source repositories are not supported.

Each account can create multiple agents. An agent session receives an isolated Artifacts fork, a repository-scoped API credential, and a short-lived Git credential. Pull requests can propose changes from a session fork. Reviews and CI results carry the authenticated actor and the exact reviewed commit.

## Run locally

Requires Node.js 24+, Git, and a Cloudflare Workers Paid account with Artifacts access for remote verification.

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
pnpm run db:migrate:local
pnpm run dev
```

The local application opens at `http://localhost:8877`. D1 and the internal Workers run locally; Artifacts binds to the configured remote namespace. Check account and namespace access before starting. The isolated remote smoke project lives under `test/artifacts-smoke/`. Its namespace is `gitedge`; the local server must remain on loopback.

Configure a random `DEPLOY_SESSION_KEY` of at least 32 characters in `workers/deploy/.dev.vars` for the local deployment wizard. For production, set it with Wrangler's secret command as described in [deployment configuration](docs/deploy.md). This secret encrypts short-lived Cloudflare credential cookies; it is never committed. All worker variables and secrets are listed in [configuration](docs/configuration.md).

## Verify

```sh
pnpm run typecheck
pnpm run test
pnpm run test:workers
pnpm run test:web
pnpm run build
pnpm run format:check
```

`pnpm run check:migrations` checks migration numbering and runs in CI. `pnpm run test:auth` runs only the Auth worker tests (agents, accounts, SSO and signatures).

With the local stack running, `node test/e2e/api-git.mjs` verifies account creation, native Git push/clone, two isolated agent forks, reviews/checks/merges, collaboration edits, deployment plan parsing and session revocation. It creates remote Artifacts verification repositories and stores temporary credentials only under ignored `work/` with private file permissions.

Run `node test/e2e/git-boundaries.mjs <fixture-directory>` after that Git check to verify private repositories, Basic authentication, binary files, tags, read-only credentials and access isolation. `GITEDGE_API=http://localhost:8877 node test/e2e/deploy.mjs` exercises actual Cloudflare provisioning, migration, upload and live binding readback using the current Wrangler account; it creates uniquely named test resources. See [SSO configuration](docs/sso.md#live-acceptance-with-keycloak) for the real Keycloak acceptance fixture.

The remaining e2e scripts need these inputs. `test/e2e/browser-accounts.mjs` runs against the local stack (`GITEDGE_API`, loopback only) and creates two accounts to check browser identity switching. `test/e2e/seed-ui.mjs` and `test/e2e/settings-signatures.mjs` run against the local stack and require `GITEDGE_FIXTURE` pointing at an `api-git.mjs` fixture directory and `GITEDGE_API=http://localhost:8877`. `test/e2e/production-smoke.mjs` runs against the production Gateway (`GITEDGE_PRODUCTION_URL`, defaulting to the configured custom domain; optional `GITEDGE_REPOSITORY_VISIBILITY`). `test/e2e/production-actions.mjs` runs against production and requires `GITEDGE_WEBHOOK_RECEIVER` and `GITEDGE_WEBHOOK_RECEIVER_NAME` for an owned verification receiver.

`build` builds the Vue interface and bundles every Worker with Wrangler's dry-run mode. Dry-run builds do not check that service binding targets exist. Production deployment is a separate `pnpm run deploy` operation that applies D1 migrations and deploys internal services before the Gateway. The first deploy into an empty account creates placeholder Workers for the cyclic bindings (Git, Forge and Actions) and then replaces them with the real deploys.

## Forks, stars and Explore

Any reader can fork a repository into their account or an organization they own from the repository's Forks tab. A fork is an independent Artifacts repository that copies the default branch, inherits the parent's visibility and shows a "Forked from" label. Fork owners sync a branch with a bounded fast-forward from the header, and open a pull request against the upstream whose head is a branch of the fork; the merge verifies the expected base and head OIDs exactly as for in-repository pull requests. Forks of private repositories stay private, live only in the forking user's account or the parent's own organization, admit only collaborators who can read the parent, and are detached from the upstream when one of their readers loses access or the parent is deleted. Pull requests from forks never run the base repository's Actions and never see its secrets.

Signed-in users star repositories (`/stars` lists them) and choose a watch level per repository: participating, all activity (new issues, pull requests and discussions notify) or ignore. Repository administrators set up to 20 topics under Settings. `/explore` lists public repositories by recent updates or stars with name, description and topic search and a topic filter, and works for anonymous visitors. See [API endpoints](docs/api-endpoints.md).

## Tags, releases and downloads

Writers manage tags from the Code tab (Manage tags: lightweight or annotated, created from a branch or a commit in its history) and publish releases from the Releases tab: notes in Markdown, draft and pre-release flags, optional tag creation from a branch or commit, and binary assets of up to 100 MiB (50 per release) uploaded as a stream to the `RELEASE_ASSETS` R2 bucket. The repository home shows the latest release, and the Code menu offers Download ZIP and tar.gz for the selected ref. Every ref also has a shareable source archive URL, `/<owner>/<repo>/archive/<ref>.zip` or `.tar.gz`, which is streamed and refuses oversized repositories instead of producing a partial file, and files have a shareable raw URL, `/<owner>/<repo>/raw/<ref>/<path>`, that renders text and images inline, forces other types to download and always sends `nosniff` and a sandbox CSP. Private repositories answer 404 to readers without access on every one of these routes. See [API endpoints](docs/api-endpoints.md) for details. `pnpm run deploy` creates the `gitedge-release-assets` bucket when it is missing.

## Operations

See [operations](docs/operations.md) for D1 Time Travel restore, scheduled exports, Git mirrors, the pre-migration checklist, deploy order and the incident checklist. `GET /api/health` reports the status of every internal service and D1; Account settings shows repository usage against the group quota.

## Git and agents

Personal access tokens are the primary credential for Git and the API. Create one under Settings, Access tokens (or press Generate token on a repository page): choose scopes (`repo:read`, `repo:write`, `issues:write`, `pulls:write`, `org:read`, `admin`), an expiry of 7, 30, 90 or 365 days, and optionally restrict it to specific repositories. The plaintext `gep_...` value is shown once; only its hash is stored. Standard Git clone, fetch and push use `https://<host>/<owner>/<repository>.git`: Git prompts for a username (any value) and the token as the password, which a credential helper (`osxkeychain`, `manager` or `libsecret`) then remembers. API clients send `Authorization: Bearer gep_...`. Read-only tokens cannot push or write through the API, and tokens can neither mint other tokens nor use deployment credentials. Public repositories allow anonymous clone. Per-repository Git credentials remain available under Settings, HTTPS credentials. Agent session credentials use the isolated Artifacts workspace remote returned when the session is created.

Agents behind NAT can pull events instead of receiving webhooks: choose Pull or Both under Settings, Agents, Event delivery, then poll the repository `agent-events` feed (long poll or SSE) with a cursor. Agents claim tasks with a lease, extend it with heartbeats, and a merged pull request that mentions `task #n` completes the task. Sessions can be renewed up to seven days after creation, which also rotates the Git credential. Account agent sessions return their API and Git tokens once. Use the API token as `Authorization: Bearer <session-token>` and the Git token for the returned workspace remote. Tokens cannot manage account credentials or grant Cloudflare deployment access. Revoking a session disables its API identity and revokes its issued Git token.

The commit graph includes all commit parents and session fork refs. Pull request merging verifies both expected OIDs and uses Git's atomic non-force ref update. Text conflicts require resolution in the session repository before retrying. Reviews and checks for previous head commits remain in history and do not satisfy the current head.

Pull request diffs support line and range comments with replies, resolvable threads, pending reviews published together with the Approve, Request changes or Comment verdict, and `suggestion` blocks rendered as a preview. A comment on a commit that is no longer the head is marked outdated and keeps its original context. `closes`, `fixes` and `resolves` followed by `#n` in a pull request title, body or commit messages close those issues when it merges into the default branch, and `#n` references render as links. The branch rule "Require conversation resolution" blocks merging while threads are unresolved.

Members with merge permission can enable auto-merge on a pull request (merge, squash or rebase, as the repository allows). It is stored with the enabling user and the reviewed head commit, merges under that user's identity once reviews, checks and conversation rules pass, and turns off if anyone other than the enabler pushes the head or the enabler loses write access. The branch rule "Require merge queue" sends merges through a FIFO queue per target branch: each entry is re-validated against the latest base and head, merged one at a time with an atomic non-force update, and ejected with a notification on conflict or a changed head. Evaluation runs after check, review and push events and in a bounded every-minute sweep.

CI runners submit check results through the authenticated Pull Request checks API. Agent reviews are explicitly marked separately from human reviews; the marker identifies the authenticated author, while the result and summary describe the runner's work.

## Account recovery and two-step verification

Accounts can add an authenticator app (TOTP), passkeys and ten single-use recovery codes under Settings, Security. Once a second factor exists, password sign-in asks for it (authenticator code, passkey or recovery code); a passkey can also sign in without a password. "Forgot password" resets the password with a username and recovery code, or with an emailed link when an optional Cloudflare Email Service binding is configured. A reset signs out every session. Sensitive changes (password, email, two-step verification, recovery codes) require a recent confirmation that lasts 10 minutes. See [account security](docs/account-security.md) and [configuration](docs/configuration.md#auth).

## Single sign-on

Sign in with identity-only GitHub OAuth or configure multiple OIDC or SAML 2.0 providers (including `https://id.voidcarve.com`), link identities to existing accounts, and use provider-aware single sign-out from Account settings. Standard code-flow and SAML signature validation use maintained MIT libraries. See [SSO configuration](docs/sso.md) for provider settings, callback URLs, secrets and supported flows.

## Architecture

The public Gateway serves Vue assets and authenticates requests before forwarding to internal Auth, Forge, Git, Actions and Deploy Workers. Auth owns credentials, agent subaccounts, webhook delivery and sessions. Forge owns collaboration records, in-app notifications and repository webhook delivery in D1. Git owns Artifacts operations and forwards Smart HTTP streams. Actions runs bounded source snapshots in isolated Containers. Deploy interprets a reviewed deployment manifest and relays a fixed set of Cloudflare operations.

Artifacts owns repository contents, refs and Git protocol behavior. Older repositories without an Artifacts mapping must be imported before use. Preserve the prior deployment and its storage until their data has been transferred and verified; deploying the new application does not transfer existing Git data.

Code view shortcuts: `t` opens a fuzzy file finder (20,000 paths per commit, truncation is reported) and `y` rewrites the address to a permalink pinned to the full commit id. Blob URLs accept `#L10` and `#L10-L20` anchors; click or shift-click a line number to set them, and use "Copy permalink" to share a stable link. Files and directories have a History view (first-parent commits that changed the path, loaded in bounded pages) and files have a Blame view that reports partial results when the walk budget ends. Every commit has a page at `/:owner/:repo/commit/:oid` with its message, parents and diff.

Browser previews support text files up to 2 MiB. Diffs show up to 200 changed files and report truncation. In-Worker comparisons inspect up to 250 commits per side; in-Worker merge transfer is limited to 24 MiB per remote. Larger histories and merges can be handled with a regular Git client, while transport streams remain unbuffered.

Repository deployment accepts prebuilt JavaScript modules plus declared D1, R2 and KV resources. The wizard shows permissions, license, terms, source digest, resource names and progress, and reuses completed provisioning work on retry. See the [manifest format](docs/deploy.md).

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) supplies the Git foundation. Overture informed the permission-first deployment interaction; GitEdge's deployment implementation is independently written under MIT.

## Signed commits and tags

Register OpenPGP or SSH signing keys under Account settings, Signing keys. Registration proves possession of the private key by signing a ten-minute challenge (`gpg --armor --detach-sign` or `ssh-keygen -Y sign -n gitedge`). To sign with an SSH key:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Commit pages and release cards verify signatures on request and show, for example, "Verified (SSH)" with the key fingerprint and its owner. Supported SSH keys are `ssh-ed25519`, `ecdsa-sha2-nistp256` and `ssh-rsa` (2048-8192 bits, `rsa-sha2-256`/`rsa-sha2-512` signatures). A signature counts as verified when it was made by a registered, unrevoked key, regardless of the free-form author text, unless the committer or tagger email is verified by a different account. The "verified signatures" branch rule accepts only such commits; since direct pushes to rule-matched branches are refused, signed commits reach them through fast-forward pull request merges.

## Repository controls and Actions

Repository settings independently enable collaboration areas, agents, deployments, commit graphs, Actions and online editing. Renaming preserves historical repository URLs. Branch patterns can require PRs, human approvals, named checks, linear history and verified signatures. Repository collaborators have read, write or admin access. Collaborators and organization members join by accepting an invitation (7-day expiry, username or one-time link); repository settings and organizations show an append-only audit log, and the account security log lists your own sensitive events. Site administrators (`SITE_ADMINS`) manage users, groups and see site statistics at `/admin`; users can export their data and delete their account from account settings.

The web Code view can upload files and folders (drag and drop or pickers), create, rename and move files by editing their path (a rename keeps the file mode, even with edits), and rename or delete folders. Every flow produces one commit through `POST /api/git/repositories/:id/commit`: at most 100 changes, 5 MiB per file and 10 MiB per commit, committed against the loaded branch head. Protected branches require a new branch, and choosing a new branch can open the pull request form prefilled after the commit.

`node test/e2e/repository-controls.mjs` creates a nonempty verification repository and checks online edits, stale SHA rejection, protected native pushes, squash/rebase, signed-commit requirements, redirects and community defaults.

Container Actions are optional. Workflows under `.github/workflows/*.yml` support literal `name` and triggers written as `on: push`, `on: [push, workflow_dispatch]` or the `on.push` / `on.workflow_dispatch` mapping form, up to three jobs and ten script steps per job. A step accepts `name`, `run`, `shell` (`sh` or `bash`), `working-directory` and literal `env`. `uses`, expressions, matrices, custom images and trigger filters are rejected with a reason. Each run has a 120-second limit, 16 KiB log budget, and an input limit of 128 regular files / 4 MiB. The default network policy is off; repositories are limited to six runs per hour. Local development disables container startup; actual container execution is verified separately on Cloudflare.

```yaml
name: Verify
on:
  workflow_dispatch:
  push:
jobs:
  verify:
    steps:
      - name: Check source
        run: node --check src/index.js
```

Workflow check names are their file paths, for example `.github/workflows/verify.yml`. Only the Actions service may publish these system CI checks. Agent webhooks use an encrypted signing secret configured through `WEBHOOK_ENCRYPTION_KEY`; see [configuration](docs/configuration.md#auth). Events are signed with HMAC-SHA256 and retried up to five times.

## AI pull request summaries

Optional and off by default. When the Forge Worker has a Workers AI binding and a repository administrator turns on Settings, Features, AI pull request summaries, GitEdge summarizes a pull request when it opens, when its head branch moves and when a writer presses Regenerate: an overview, notable changes, risk areas and reviewer focus, shown on the Conversation tab as a system note labeled "AI summary — not a review, does not count as approval". The note is stored separately from reviews and comments, so it can never count toward required approvals. The code diff is sent to Workers AI inside your Cloudflare account and billed as account usage; a private repository needs a second, explicit consent. Summaries are cached per head commit and each repository is limited to 20 model calls per hour. See [configuration](docs/configuration.md#ai-pull-request-summaries) for the binding, the kill switch and the model.

## Notifications and repository webhooks

Forge creates in-app notifications in the same D1 batch as the write that causes them: assignments, review requests, `@mentions` (users as `@login`, agents as `owner/@handle`, never inside code), comments on threads you take part in, failed checks, merges and collaborator invitations, and (for repositories you watch with all activity) every new issue, pull request and discussion. Recipients must be able to read the repository both when the notification is created and every time it is listed, so removed members never see private titles. The header bell shows the unread count, refreshed once a minute while the tab is visible and when it regains focus; `/notifications` groups items by repository with unread and reason filters. Account settings, Notifications mutes reasons you do not want.

Repository administrators configure webhooks under Settings, Webhooks: an HTTPS URL, JSON content type, an optional secret (generated and shown once if omitted), the events `push`, `issues`, `issue_comment`, `pull_request`, `pull_request_review` and `check_run`, and an active flag. Each request carries `X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body>`, `X-GitEdge-Event` and `X-GitEdge-Delivery`. Failed deliveries retry up to five times with exponential backoff (1, 2, 4 and 8 minutes), the last 100 deliveries per webhook are kept (the latest 50 are listed) with their status and can be redelivered, and a test request can be sent at any time. Targets must resolve to public addresses; internal hosts and non-HTTPS URLs are refused. Secrets are encrypted at rest with `WEBHOOK_ENCRYPTION_KEY`, which Forge needs in addition to Auth; see [configuration](docs/configuration.md#forge). Release events are not offered because releases do not exist yet.

## Repository and organization lifecycle

Repository settings include a danger zone. Deleting a repository requires typing its full name and revokes its agent sessions; it then behaves as missing everywhere and is listed under Recently deleted on the dashboard for 7 days, where it can be restored (unless its name was taken in the meantime) or purged immediately. Deleted repositories count toward the repository limit until they are purged. A scheduled job in the Forge worker (every 15 minutes) permanently removes expired repositories: it revokes agent sessions, deletes the Artifacts repository and session forks, then deletes the database rows, resuming safely after any interruption.

Transferring a repository moves it to your own account or an organization you own. Old web URLs and Git remotes keep redirecting, explicit collaborators keep their roles, inherited access follows the new owner and active agent sessions are revoked, so agents must start new sessions. Deleting an organization requires its slug and an empty organization: transfer or delete every repository first, and wait for deleted ones to be purged (or purge them immediately). Redirect aliases that pointed into a deleted organization are removed with it.

## Private repository access responses

Configure `PRIVATE_REPOSITORY_RESPONSE` in `workers/gateway/wrangler.jsonc` and redeploy the Gateway:

- `not_found` (default): unauthorized private repositories return the same 404 response as missing repositories.
- `forbidden`: unauthorized private repositories return 403 with an explicit access-denied message. This discloses repository existence, but never its contents.

Unset or invalid values use `not_found`. The policy covers browser repository routes and the Forge and Git APIs. Anonymous Git HTTPS requests that cannot be served, whether the repository is private or missing, receive the same Basic authentication challenge so Git prompts for a token; authenticated callers without access follow the policy. A valid token outside its scopes or repository allowlist receives 403, and a read-only credential that pushes receives 403, so Git keeps working credentials in its helper. Missing repositories remain 404 in both modes elsewhere. Repository listings continue to omit inaccessible repositories. Invalid Git credentials still receive an authentication challenge.

## Edge caching

Public repository reads are cached close to readers and never shared for private data. Commit-addressed responses are immutable; branch and tag reads are resolved to their commit on each request, so a push is visible immediately and conditional requests answer 304. Visibility changes, transfers, renames and deletion take effect at once: access is checked before any cache lookup, and each of those changes moves the repository to a new cache generation. Inspect the `X-GitEdge-Cache` response header (`hit`, `miss`, `revalidated`, `bypass`) to verify behavior; the classes and limits are described in [docs/architecture.md](docs/architecture.md#edge-caching).

## License

[MIT](LICENSE). The retained upstream logger attribution is in [LICENSES/MIT-git-on-cloudflare.txt](LICENSES/MIT-git-on-cloudflare.txt).
