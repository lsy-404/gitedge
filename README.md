# GitEdge / 码锋

GitEdge is an MIT-licensed Git forge on Cloudflare Workers and Artifacts. The Vue interface supports repositories, Git file browsing and commit graphs, Issues, Pull Requests, Discussions, Wiki revisions, and repository deployment.

Each account can create multiple agents. An agent session receives an isolated Artifacts fork, a repository-scoped API credential, and a short-lived Git credential. Pull requests can propose changes from a session fork. Reviews and CI results carry the authenticated actor and the exact reviewed commit.

## Run locally

Requires Node.js 24+, Git, and a Cloudflare Workers Paid account with Artifacts access for remote verification.

```sh
npm ci
npm --prefix apps/web ci
npm run db:migrate:local
npm run dev
```

The local application opens at `http://localhost:8877`. D1 and the internal Workers run locally; Artifacts binds to the configured remote namespace. Check account and namespace access before starting. The isolated remote smoke project lives under `test/artifacts-smoke/`. Its namespace is `gitedge`; the local server must remain on loopback.

Configure a random `DEPLOY_SESSION_KEY` of at least 32 characters in `workers/deploy/.dev.vars` for the local deployment wizard. For production, set it with Wrangler's secret command as described in [deployment configuration](docs/deploy.md). This secret encrypts short-lived Cloudflare credential cookies; it is never committed.

## Verify

```sh
npm run typecheck
npm test
npm run test:workers
npm run build
```

`build` builds the Vue interface and bundles every Worker with Wrangler's dry-run mode. Production deployment is a separate `npm run deploy` operation that applies D1 migrations and deploys internal services before the Gateway.

## Git and agents

Repository pages issue scoped, expiring Artifacts Git tokens. Keep credentials in process environment or a credential helper, and keep the remote URL free of credentials. Standard Git clone, fetch and push use the Artifacts remote, or the GitEdge Smart HTTP route with a repository-scoped GitEdge credential.

Account agent sessions return their API and Git tokens once. Use the API token as `Authorization: Bearer <session-token>` and the Git token for the returned workspace remote. Tokens cannot manage account credentials or grant Cloudflare deployment access. Revoking a session disables its API identity and revokes its issued Git token.

The commit graph includes all commit parents and session fork refs. Pull request merging verifies both expected OIDs and uses Git's atomic non-force ref update. Text conflicts require resolution in the session repository before retrying. Reviews and checks for previous head commits remain in history and do not satisfy the current head.

CI runners submit check results through the authenticated Pull Request checks API. Agent reviews are explicitly marked separately from human reviews; the marker identifies the authenticated author, while the result and summary describe the runner's work.

## Architecture

The public Gateway serves Vue assets and authenticates requests before forwarding to internal Auth, Forge, Git and Deploy Workers. Auth owns credentials and agent sessions. Forge owns collaboration records in D1. Git owns Artifacts operations and forwards Smart HTTP streams. Deploy interprets a reviewed deployment manifest and relays a fixed set of Cloudflare operations.

Artifacts owns repository contents, refs and Git protocol behavior. Older repositories without an Artifacts mapping must be imported before use. Preserve the prior deployment and its storage until their data has been transferred and verified; deploying the new application does not transfer existing Git data.

Browser previews support text files up to 2 MiB. Diffs show up to 200 changed files and report truncation. In-Worker comparisons inspect up to 250 commits per side; in-Worker merge transfer is limited to 24 MiB per remote. Larger histories and merges can be handled with a regular Git client, while transport streams remain unbuffered.

Repository deployment accepts prebuilt JavaScript modules plus declared D1, R2 and KV resources. The wizard shows permissions, license, terms, source digest, resource names and progress, and reuses completed provisioning work on retry. See the [manifest format](docs/deploy.md).

[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) supplies the Git foundation. Overture informed the permission-first deployment interaction; GitEdge's deployment implementation is independently written under MIT.

## License

[MIT](LICENSE). The retained upstream logger attribution is in [LICENSES/MIT-git-on-cloudflare.txt](LICENSES/MIT-git-on-cloudflare.txt).
