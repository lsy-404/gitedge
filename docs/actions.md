# GitEdge Actions

GitEdge provides two execution paths: the container service below, and an operator-run compatibility command using unmodified GitHub action packages and an official runner. The compatibility command is independent of the web Actions queue.

## Original GitHub action packages

Install Node 24, pnpm and the official [GitHub Actions runner](https://github.com/actions/runner) for the current machine. The command downloads [Runner.Server](https://github.com/ChristopherHX/runner.server) v3.14.0 and verifies its pinned SHA-256. Both upstream projects use the MIT license.

```sh
pnpm run actions setup
export GITEDGE_TOKEN='<repository-scoped GitEdge access token>'
pnpm run actions run \
  --origin https://git.example.com \
  --repository owner/repository \
  --workflow .github/workflows/verify.yml \
  --runner-path /path/to/official-runner \
  --sha <full-commit-oid> \
  --ref refs/heads/main
```

The workflow is an explicit local file; the source commit and ref select the remote checkout. The backend listens only on loopback. The command copies the official runner binaries into an isolated directory, registers that copy with its own execution backend, and removes temporary registration and credential files on exit. Existing runner services remain untouched. Logs, artifacts and backend state remain under `work/actions`; use `--state-dir` to choose another directory. A state directory permits one invocation at a time. The default deadline is 60 minutes; `--timeout-minutes` accepts 1–360.

Action packages are downloaded from GitHub without rewriting. `actions/checkout` uses the actual GitEdge Git transport, including addresses without the `.git` suffix. Runner.Server interprets the workflow and supplies the runner protocol; this is not a guarantee that every GitHub workflow feature works. `runs-on` must match the current machine's real OS, architecture and labels. `--label` adds a label; it does not provision another operating system. Docker actions and container jobs require a working local container runtime.

Use `--job <id>` to select a job, `--event` to select the event name, and `--secret-file` for a YAML mapping of string secrets. Event payload and GitHub environment approval integration are not implemented. `GITEDGE_TOKEN` becomes `secrets.GITHUB_TOKEN`; the command also supplies `GH_HOST`, `GH_ENTERPRISE_TOKEN` and `GITHUB_API_URL`. Inherited GitHub authentication variables are removed before starting the execution processes. The operator supplies a token with the needed repository permissions; workflow `permissions` does not mint a narrower GitEdge job token. Workflows execute with the local user's access, so run only code and secrets trusted for that machine.

Unmodified `actions/upload-artifact` and `actions/download-artifact` packages are refused for custom origins: their toolkit checks the server host before accessing the artifact service. Reusable or composite actions can contain further unsupported dependencies; those failures remain visible in the runner output. Ordinary job files and the compatibility backend's local outputs are separate from the deployed container Actions artifacts.

This path does not register an organization-wide GitEdge runner, dispatch automatically on pushes, publish trusted system CI checks, or implement GitHub environment approvals. The current container service continues to own those existing queue and check integrations.

## GitHub REST compatibility

After applying migrations and deploying the Gateway, use a repository-scoped GitEdge personal access token with the original GitHub CLI:

```sh
export GH_HOST=git.example.com
export GH_ENTERPRISE_TOKEN='<GitEdge access token>'
gh api repos/owner/repository
gh release create v1.0.0 dist/app.zip \
  --repo owner/repository --target <full-commit-oid> \
  --title 'Version 1.0.0' --notes 'Release notes'
```

REST lives under `/api/v3`. `GET /api/v3/gitedge/capabilities` lists supported operations. Repository metadata, the authenticated user, release list/latest/tag/ID reads, release create/edit/delete, and asset upload/read/delete use the native Auth, Forge and Git permissions. IDs are stable integers mapped to native IDs. Anonymous reads work for public repositories; unauthorized private reads follow the site's 404/403 policy. Cookies and inbound trusted identity headers do not authenticate this API.

`gh release create` with explicit title/notes/target, `view --json tagName,assets,isDraft`, `edit`, `upload` and `delete-asset` use these REST operations. Changing a release tag or target, automatic release notes, discussions, latest overrides, asset labels, workflow-run APIs and GraphQL are unsupported. Commands or flags that require GraphQL, including the current CLI's `release list`, `release download`, `release delete` and `--verify-tag`, fail explicitly. Use `gh api` for release lists, asset downloads and release deletion instead:

```sh
gh api 'repos/owner/repository/releases?per_page=30' --paginate
gh api repos/owner/repository/releases/assets/<asset-id> \
  -H 'Accept: application/octet-stream' > app.zip
gh api --method DELETE repos/owner/repository/releases/<release-id>
```

Unknown operations and unsupported fields return HTTP 501 with `code: unsupported`; malformed values return 422. Lists are bounded by the native release limit (100), a 2.1 MB response budget and at most 200 mapped IDs per response. A truncated native list or excessive ID count returns `bounded_result`; it is never presented as complete pagination. `per_page` accepts 1–100. Asset uploads retain the native 100 MiB limit and require Content-Length. There is no fallback to github.com for repository API requests.

## Container workflows

GitEdge runs a deliberately small workflow language in a per-run Cloudflare Container. Workflows can use `.gitedge/workflows/*.yml` for GitEdge-native files or `.github/workflows/*.yml` for the supported GitHub syntax subset. If a commit contains any native files, GitEdge selects that directory and ignores `.github/workflows` for the same commit.

The parser accepts `name`, `on`, `jobs`, a top-level `cache`, job `name`, `steps`, job `artifacts`, and step `name`, `run`, `shell`, `working-directory`, and literal `env`. Supported triggers are `push`, `workflow_dispatch`, `pull_request`, and `merge_group`. `push` and `pull_request` accept `branches` and `branches-ignore` filters. It does not implement arbitrary GitHub Actions, `uses`, `${{ }}` expressions, conditions, matrices, dependent jobs, composite actions, secrets contexts, or the wider GitHub workflow schema. Unsupported syntax appears with an explanation and the run is refused.

```yaml
name: Verify
on:
  push:
    branches: [main]
  workflow_dispatch:
cache:
  keyFiles: [pnpm-lock.yaml]
  paths: [.pnpm-store]
jobs:
  test:
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
        env:
          npm_config_store_dir: .pnpm-store
      - name: Test
        run: pnpm run test
    artifacts:
      - name: web-dist
        paths: [dist]
```

Copyable starter templates are in the Actions page: GitEdge self-check, Node and pnpm, Python, and static site validation. Copy a template into `.gitedge/workflows/<name>.yml` and commit it. The self-check checks the container runtimes, migration numbering, and the Actions image definition without installing the full monorepo's dependencies.

The deployed image is built from [`workers/actions/Dockerfile`](../workers/actions/Dockerfile). Cloudflare documents its managed `cloudflare/debian-trixie` image as Node.js 24.20 on Debian Trixie; this project builds a named image from the Node 24.20 Trixie image and installs pnpm 10.34.6, Python 3, Git, Bash, and tar explicitly. Jobs run as an unprivileged user. Network access stays disabled unless a repository administrator enables it. Package installation templates need that repository setting enabled.

Each run receives only regular files from the selected commit. Symbolic links, gitlinks, invalid paths, and duplicate paths are refused. The snapshot is limited to 2,048 files and 24 MiB; workflows are limited to 64 KiB, three jobs, and ten steps per job. A run has ten minutes and six-run-per-repository-per-hour limits. Logs are capped at 16 KiB per run.

The top-level `cache` declares lockfiles and workspace paths. Cache identity includes repository, trigger partition, exact source ref, workflow path, and SHA-256 hashes of the declared lockfiles. Pull-request and merge-group cache partitions do not share entries with branch runs. Entries are tar archives capped at 24 MiB; paths with symlinks are rejected on save and restore. Five cache entries are retained per repository, evicting the least recently used. Missing lockfiles skip cache use.

Job `artifacts` are tar.gz downloads. Each declaration has a unique name and one or more relative workspace paths. Symlinks and non-regular files are rejected; combined archived output is capped at 24 MiB and 2,048 files. The Actions Worker streams archives through bounded Durable Object chunks to the existing `gitedge-release-assets` bucket under `actions/` prefixes. Downloads require repository read access. Repository purge removes those cache and artifact objects.

GitEdge Pages publishes static files directly from a public repository branch and folder. It does not provision Cloudflare Pages projects or require Cloudflare Pages credentials. The Pages settings show whether the selected branch is available, the current source commit, the last recorded push, and the site link. Use a static-site template to validate a folder, then configure Pages to serve that committed folder.
