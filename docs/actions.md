# GitEdge Actions

GitEdge provides the container executor and an optional local runner broker. The original `actions run` command remains available for one explicitly selected workflow; the broker connects enabled `.github/workflows/` jobs to local GitHub or GitEdge runner profiles.

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

Use `--job <id>` to select a job, `--event` to select the event name, `--event-file` for an optional JSON object payload up to 1 MiB, and `--secret-file` for a YAML mapping of string secrets. GitHub environment approval integration is not implemented. `GITEDGE_TOKEN` becomes `secrets.GITHUB_TOKEN`; the command also supplies `GH_HOST`, `GH_ENTERPRISE_TOKEN` and `GITHUB_API_URL`. Inherited GitHub authentication variables are removed before starting the execution processes. The operator supplies a token with the needed repository permissions; workflow `permissions` does not mint a narrower GitEdge job token. Workflows execute with the local user's access, so run only code and secrets trusted for that machine.

Unmodified `actions/upload-artifact` and `actions/download-artifact` packages are refused for custom origins: their toolkit checks the server host before accessing the artifact service. Reusable or composite actions can contain further unsupported dependencies; those failures remain visible in the runner output. Ordinary job files and the compatibility backend's local outputs are separate from the deployed container Actions artifacts.

The direct `actions run` command does not register a persistent GitEdge runner, dispatch automatically on pushes, publish trusted system CI checks, or implement GitHub environment approvals. The container service remains the default queue and check path; administrators can explicitly enable the local broker for `.github/workflows/` execution.

## Local runner broker

The production broker uses one GitEdge registration profile and one execution slot. The server can lease a GitEdge workflow, signing job or GitHub Actions job through that generic profile. Signing profiles remain protected by account approval; eligible runners are matched using their reported OS, architecture and tools. Signing secrets are granted only for the authorized task and active lease. A typical setup uses one Mac broker and two Windows brokers, all registered as generic runners. GitHub management credentials stay on the server; the Mac receives only the GitEdge runner credential and a one-job JIT configuration in the Runner.Listener environment. The installed official runner is copied to a private temporary directory and removed after the job. GitEdge profiles automatically include the current host's `self-hosted`, OS, and architecture labels; `--label` adds a custom label. State and GitEdge runner credentials live under `work/runner-broker` with private directory and file permissions. Use `--state-dir` to relocate that data. A process lock prevents concurrent profile changes or brokers, and the shared `work/actions` lock serializes broker jobs with the original `actions run` command. The explicit `register-github` command remains available for standalone GitHub polling mode.

Initialize state and register the GitEdge runner profile used by the production broker:

```sh
pnpm run runner-broker -- init
GITEDGE_TOKEN='<admin-scoped GitEdge token>' pnpm run runner-broker -- register-gitedge \
  --origin https://git.example.com --owner acme \
  --label ci --runner-path /path/to/official-runner \
  --max-job-minutes 60 --daily-minutes 240 --cost 10
pnpm run runner-broker -- list
pnpm run runner-broker -- serve
```

The optional budget values are persisted in the local profile: `--max-job-minutes` accepts 1–360, `--daily-minutes` accepts 1–1440 rolling minutes, and `--cost` accepts a relative 0–100 score (lower is preferred). At each GitEdge claim the broker reports OS, architecture, logical CPUs, one-minute load, available and total memory, free space in both broker and Actions work directories, and allowlisted tools detected on the host. Tool probes are bounded and cached for ten minutes; Docker is advertised only when `docker info` reaches a working daemon. One slot is reported. The server applies the persisted budget and capacity report when choosing work.

Workflow `runs-on` may include resource labels such as `need-mem-2g`, `need-cpu-2`, `need-disk-10g`, `need-tool-docker`, and `need-time-45m`. The broker and server reject unknown `need-*` labels. The broker checks claims against current local capacity before launching the workflow and uses `need-time` as a deadline, clamped to the GitEdge workflow maximum. GitHub jobs default to a 360-minute local deadline. Keep a custom label such as `ci` in every intended workflow: registration still includes standard `self-hosted` and host labels, so labels alone cannot prevent a generic `self-hosted` GitHub workflow from matching. GitHub provides no server-enforced custom-label-only policy in this broker.

For the independent GitHub polling mode, `register-github` remains available and uses local `gh` authentication:

```sh
pnpm run runner-broker -- register-github --host github.com --owner acme \
  --scope repo --repository app --label ci --runner-path /path/to/official-runner
```

To install a macOS LaunchAgent from an existing checkout or installation, provide its fixed directory explicitly. Install writes the plist but does not start it; start, stop, and status operate on `com.gitedge.runner-broker`:

```sh
pnpm run runner-broker -- service install --install-dir /path/to/gitedge
pnpm run runner-broker -- service start --install-dir /path/to/gitedge
pnpm run runner-broker -- service status --install-dir /path/to/gitedge
pnpm run runner-broker -- service stop --install-dir /path/to/gitedge
```

The LaunchAgent invokes the Node executable and broker script in that installation, uses the current user's home directory, and writes logs under the selected state directory. Keep the installation directory in place while the service is installed.

On Ubuntu 24.04, install a systemd unit as root but execute it as a dedicated unprivileged account. Initialize and register the profile as that account first so its credentials remain owned by that account, then install the service with `--run-as-user`. The unit stops the broker with SIGTERM so active work is cancelled and its state lock is released. It leaves CPU, memory and task sizing to the host's systemd policy; capacity reporting honors any cgroup v2 memory limit already applied to the service:

```sh
sudo install -d -o gitedge -g gitedge -m 0700 /var/lib/gitedge/runner-broker
sudo -u gitedge pnpm run runner-broker -- init --state-dir /var/lib/gitedge/runner-broker
sudo -u gitedge env GITEDGE_TOKEN='<admin-scoped GitEdge token>' pnpm run runner-broker -- register-gitedge \
  --state-dir /var/lib/gitedge/runner-broker \
  --origin https://git.example.com --owner acme \
  --label ubuntu24-1gb-light --runner-path /opt/actions-runner \
  --max-job-minutes 60 --daily-minutes 240 --cost 0
sudo pnpm run runner-broker -- service install \
  --install-dir /opt/gitedge --state-dir /var/lib/gitedge/runner-broker --run-as-user gitedge
sudo pnpm run runner-broker -- service start --install-dir /opt/gitedge
sudo pnpm run runner-broker -- service status --install-dir /opt/gitedge
```

Use `ubuntu24-1gb-light` (or another custom label) in workflows that should target this small host. The broker does not provide server-enforced light-only routing; any workflow with matching standard labels can still be assigned by GitHub's native label rules.

An owner-wide registration serves enabled repositories in that GitEdge namespace; add `--repository` only to restrict it to one repository. To accept GitHub jobs, connect each source in the repository's GitHub sync settings and enable **Route GitHub self-hosted jobs to GitEdge runners**. Apply all migrations, including `0046_github_runner_bridge.sql`. The connection needs repository runner administration, Actions read, and the existing synchronization permissions. A fine-grained token can limit access to selected repositories. GitHub owners can differ from the GitEdge namespace.

GitHub sends signed `workflow_job` requests to the connection's public webhook. Only jobs explicitly requesting `self-hosted` and matching the registered labels are claimed. GitEdge rechecks the source job before issuing a repository-scoped, ephemeral JIT identity. GitHub retains native action downloads, environment approvals, secrets, job credentials and logs. Temporary identities are removed after execution; cleanup is retried after connection failures. The queue accepts at most 100 pending demands per connection, expires unclaimed demands after 24 hours, and does not replay a completed or failed demand. Rerun the GitHub workflow after resolving an execution-start failure. GitHub chooses the eligible job for a temporary runner; it is not pinned to a webhook job ID.

Failed GitHub runner starts retain at most 16 KiB of listener diagnostics in `profiles/<profile>/logs` with private file permissions. The JIT configuration and job lease are redacted, and the temporary execution directory is removed.

GitEdge registration creates one runner through the admin API and stores its returned runner credential locally. `GITEDGE_TOKEN` is not saved. Remove a profile with `pnpm run runner-broker -- remove <profile>`. For GitEdge removal, supply `GITEDGE_TOKEN` again with administrator scope so the broker can revoke the server registration before deleting local state. Standalone GitHub profiles use the existing stored `gh` CLI authentication for their explicit `--host` and do not copy that credential into broker state. Inherited token environment variables are ignored. The account must administer the target repository; organization runner groups and JIT registration require the corresponding organization runner permissions (`admin:org` for a classic OAuth token). GitHub jobs dispatched through the GitEdge profile do not use local `gh` authentication.

Manage custom routing labels in Account settings → Runners. Add comma-separated labels such as `server`, `device`, `ip-residential`, or `gpu`, then request them as literal `runs-on` labels with `self-hosted`. Combine a base label such as `server` or `device` with IP-type or other tags when needed. Every requested label must match; otherwise the job remains queued. These labels are administrator-declared routing tags and do not change the runner's reported OS, architecture, or resource capacity. The standard platform and `need-*` resource labels are not editable there.

In standalone GitHub polling mode, an organization profile must include one or more `--allow-repository owner/name` options. It uses the configured `--group-id` or `--group-name`, or resolves the organization's default runner group. The selected group must use selected-repository visibility and its complete repository set must match the profile allowlist. GitHub continues to enforce that group's public-repository and workflow access settings. An unrestricted group is rejected. Repository profiles use the repository's default runner group ID 1. The broker polls a bounded set of queued runs and jobs, then starts an ephemeral JIT runner only when a queued job requests `self-hosted` and every requested label matches the actual host and that profile's labels. A GitHub-hosted label such as `ubuntu-latest` never maps to a local macOS or Windows machine. A JIT runner is not pinned to the polled job; it may take any eligible job visible to its repository and runner group. The broker waits until the new runner is busy, then stops observing that job; if it remains idle for 120 seconds, it removes the ephemeral runner and returns to polling. `--poll-seconds` is bounded to 15–120 seconds; organization profiles poll no faster than every 30 seconds and require an explicit allowlist of at most 50 repositories. Normal organization polling inspects three allowlisted repositories and three runs per status per cycle, rotating repository and run pages. Inspection is capped at 30 runs per status per repository and 100 jobs per run; larger results produce a warning. A temporary GitHub runner has a six-hour local execution deadline. `serve --once` scans the full allowlist once from each saved page cursor and may make more REST calls. It exits after processing at most one eligible job, or after one bounded polling pass without a match.

GitEdge repository administrators must enable Actions and the **Use registered local runners** repository setting (`actionsRunnerEnabled`). Apply migration `0045_runner_broker.sql` and deploy the updated services, including the Actions → Auth binding, before registering a broker. Registration does not enable repository execution automatically. `.gitedge/workflows/` keeps its container precedence; opted-in `.github/workflows/` files use the persistent runner queue.

Registered runners discover only workflow definitions, then clone the selected commit through Git. The container snapshot limit does not restrict other repository assets for runner execution.

GitEdge runner workflows currently support:

- Human `push` and `workflow_dispatch` triggers. Push supports `branches` and `branches-ignore`; path and tag filters, PRs, merge groups and other trigger types are refused. Event payloads contain the repository, ref, source SHA and triggering identity; full GitHub commit metadata and history are not synthesized.
- `string`, `number`, `boolean` and `choice` dispatch inputs, including defaults and required values, through the Actions page or native API.
- Literal `runs-on` labels including `self-hosted`. All jobs in the workflow execute on one host matching the union of their labels. The local runner receives the complete union, including `need-*` labels, so Runner.Server can match the same job requirements. Expressions, `uses` packages and matrices are interpreted by Runner.Server; unsupported dependencies fail visibly in the runner output.
- Top-level `permissions: {contents: read}` or `write`; read is the default. Other permissions, job-level permissions, environments and concurrency groups are refused. The short-lived job token permits only the current repository's contents and Releases; it cannot manage runners, change repository settings, access Issues, or publish CI checks.
- At most 64 KiB of YAML, 16 job definitions, 128 steps per job and 40 required labels. Each job declares a 1–360 minute timeout, defaulting to 60; the workflow deadline is their sum capped at 360 minutes. Self-hosted runner admission does not use the built-in container runner allowance configured in [deployment settings](configuration.md#deployment-settings).

The broker renews its 120-second lease every 30 seconds and stops execution on cancellation, revocation or renewal failure. Cancellation and completion invalidate the job token immediately. A lost lease fails the run without replaying possible side effects; an unclaimed run expires after 24 hours. GitEdge stores a token-redacted log tail capped at 16 KiB and publishes its own system CI check against the queued commit SHA. The first implementation reports the whole workflow and its output together, without inventing per-job or per-step progress.

Workflows inherit the local user's filesystem and network access. Separate profile files and process environments do not isolate mutually untrusted code running as the same OS user. Existing runner services and production deployment are separate operator choices.

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

Release targets accept branch names, or commit SHAs reachable from the default branch. For other branch tips, use the branch name as `target_commitish` (`gh release create --target <branch>`); a SHA outside the default branch returns the native HTTP 400 rejection.

`gh release create` with explicit title/notes/target, `edit`, `upload` and `delete-asset` use these REST operations. Changing a release tag or target, automatic release notes, discussions, latest overrides, asset labels, workflow-run APIs and GraphQL are unsupported. Commands or flags that require GraphQL, including the current CLI's `release view`, `release list`, `release download`, `release delete` and `--verify-tag`, fail explicitly. Use `gh api` for release reads, asset downloads and release deletion instead:

```sh
gh api 'repos/owner/repository/releases?per_page=30' --paginate
gh api repos/owner/repository/releases/tags/v1.0.0
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

Each run receives only regular files from the selected commit. Symbolic links, gitlinks, invalid paths, and duplicate paths are refused. The snapshot is limited to 2,048 files and 24 MiB; workflows are limited to 64 KiB, three jobs, and ten steps per job. A run has ten minutes; the repository creator's user group sets the rolling-hour run allowance, defaulting to 60 for `free`. Logs are capped at 16 KiB per run.

The top-level `cache` declares lockfiles and workspace paths. Cache identity includes repository, trigger partition, exact source ref, workflow path, and SHA-256 hashes of the declared lockfiles. Pull-request and merge-group cache partitions do not share entries with branch runs. Entries are tar archives capped at 24 MiB; paths with symlinks are rejected on save and restore. Five cache entries are retained per repository, evicting the least recently used. Missing lockfiles skip cache use.

Job `artifacts` are tar.gz downloads. Each declaration has a unique name and one or more relative workspace paths. Symlinks and non-regular files are rejected; combined archived output is capped at 24 MiB and 2,048 files. The Actions Worker streams archives through bounded Durable Object chunks to the existing `gitedge-release-assets` bucket under `actions/` prefixes. Downloads require repository read access. Repository purge removes those cache and artifact objects.

GitEdge Pages publishes static files directly from a public repository branch and folder. It does not provision Cloudflare Pages projects or require Cloudflare Pages credentials. The Pages settings show whether the selected branch is available, the current source commit, the last recorded push, and the site link. Use a static-site template to validate a folder, then configure Pages to serve that committed folder.
