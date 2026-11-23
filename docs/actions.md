# GitEdge Actions

GitEdge provides the container executor and an optional local runner broker. The original `actions run` command remains available for one explicitly selected workflow; the broker connects enabled `.github/workflows/` jobs to GitEdge runner profiles.

## Emergency hosted runners

An account owner can enable emergency hosted runners by submitting `{"connectionId":"…","includedOnlyConfirmed":true}` to `POST /api/forge/hosted-runner-settings`, confirming the GitHub account's paid Actions budget is zero. The connection must belong to that account. GitEdge creates or uses a private `gitedge-emergency-runners` repository in the connected GitHub user's account and verifies its identity on each dispatch. `DELETE` disables the setting. A queued job can use a temporary GitHub-hosted machine immediately if no private runner matches, or when all matching private runners have been offline for over five minutes. If a matching private runner is online but busy, fallback starts after 15 minutes in the queue. The normal queue remains available if provisioning fails.

Emergency hosted runners stop being dispatched once the account's GitHub included Actions quota is used up: GitEdge reads the month's usage with the account's shared GitHub token (the signing source token in the account Runner repository), and a state of `exhausted` (any paid usage, or included usage reaching the optional `githubIncludedUsd` ceiling) keeps queued jobs on the normal runners. The token needs the fine-grained "Plan: read" permission or the classic `user` scope; see [runner scheduling](runner-scheduling.md). Hosted runners rank as type `github-hosted` after owned and rented runners by default. GitHub enforces the account's Actions spending budget when the hosted job starts. Set the paid Actions budget to zero to prevent charges beyond included usage; Quota readings can lag by up to 15 minutes, so the zero budget remains the hard limit. With a zero budget GitHub refuses to start a hosted job once the included minutes are used up even when the usage summary still lags; GitEdge reads that refusal from the run's annotations about a minute after dispatch, marks the dispatch `github_included_exhausted` and the quota `exhausted` until a manual refresh or the next month. Hosted runners use GitHub's available machine images and must satisfy the job's operating system, architecture and resource requirements.

## On-demand tiers

When no private runner can take a queued job under the timing rules above (immediately when no matching private runner has been seen for five minutes, otherwise after 15 minutes in the queue), GitEdge can start a temporary machine for that one job. There are two on-demand tiers, ordered by the account's type priority (default `owned`, `rented`, `github-hosted`, `colab`):

1. **GitHub-hosted** (`github-hosted`), described above.
2. **Google Colab** (`colab`): used when the GitHub tier cannot take the job — emergency hosted runners are not enabled, the GitHub included quota is `exhausted`, or the GitHub dispatch failed (for example `hosted_runner_unavailable` for an unsupported image) — and Colab is enabled. Moving `colab` above `github-hosted` in the priority makes Colab the first choice; the GitHub tier then waits while a Colab dispatch is active and takes over when it fails.

Enable Colab with `PUT /api/actions/runners/settings` and `{"typePriority":[…],"githubIncludedUsd":…,"colabEnabled":true}` (Account settings → Runners → On demand). Colab needs a connected Google account with a paid Colab plan (Account settings → Runners → On demand); no host or browser is involved. The Actions Worker allocates a CPU runtime for each job through the Colab session backend with that account's OAuth token, starts the official runner in it and releases the runtime when the job ends. Colab runtimes are Ubuntu Linux x64 CPU runtimes. Jobs that require Windows, macOS, ARM, `GPU-*` or `VRAM-*`, and signing jobs, are never sent to Colab. A job's session lasts its `need-time`/timeout plus 30 minutes of setup, capped at the paid 24-hour session limit.

Connect the account with these session-authenticated routes:

- `POST /api/actions/colab/authorization` returns `{ "data": { "url" } }`, a Google consent URL (OAuth with PKCE) valid for ten minutes. After approval Google displays a code.
- `PUT /api/actions/colab/account` with `{"code":"<displayed code>"}` exchanges the code, stores the refresh token encrypted, reads the compute-unit balance and returns the account (`email`, `connectedAt`, `balance`, `rateHourly`, `checkedAt`, `error`).
- `DELETE /api/actions/colab/account` revokes the refresh token at Google and removes the account.

`GET /api/actions/runners/overview` returns the account under `colab.account`. If Google rejects the stored refresh token, `error` is set and no further dispatches are created for the owner until the account is reconnected.

A Colab dispatch moves through `pending` (created by the minute cron), `starting` (the Worker claimed it, issued a one-time bootstrap token and is allocating a runtime and launching the runner), `running` (the runtime exchanged the token for a runner credential) and ends as `finished`, `failed` or `cancelled`. The dispatch id is the notebook hash of the allocation, so a repeated allocation returns the same runtime. Every dispatch that reached `starting` and ended is released: the runtime is unassigned and `released_at` is recorded. Starting failures are `colab_account_unavailable`, `colab_assignment_failed`, `colab_too_many_assignments` and `colab_launch_failed`; a runtime that does not bootstrap within 15 minutes fails with `colab_bootstrap_timeout`. Retryable failures are retried after 15 minutes while the job is still queued; other failures are not retried for that job. Disabling Colab cancels dispatches that have not started a runner. Apply migration `0069_colab_server_runtimes.sql`.

`POST /api/actions/colab-runners/bootstrap` takes `{"bootstrapToken":"<64 hex>","labels":["self-hosted","Linux","X64","linux","x64"]}` and needs no other credential. The token is stored only as a SHA-256 hash, works once, and only within 15 minutes of the claim. The response matches the hosted bootstrap: an ephemeral runner of type `colab` pinned to the one job (`hosted_job_kind`/`hosted_job_id`), scoped to the job's repository, whose credential expires with the session. Inside the runtime, `runner-launcher.mjs colab --origin URL --runner-path DIR --state-dir DIR` (token in `GITEDGE_COLAB_BOOTSTRAP_TOKEN`) performs the exchange, installs the published kit with the new credential and runs the broker's `once` command, which serves that profile for one job and exits; an offer must arrive within 15 minutes. The Worker runs a launch cell in the runtime's kernel that downloads a pinned Node.js 24 and the official runner (both checked by SHA-256) and starts this command detached.

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

The workflow is an explicit local file; the source commit and ref select the remote checkout. The backend listens only on loopback. The command copies the official runner binaries into an isolated directory, registers that copy with its own execution backend, and removes temporary registration and credential files on exit. Existing runner services remain untouched. Logs, artifacts and backend state remain under `work/actions`; use `--state-dir` to choose another directory. A state directory permits one invocation at a time. The default deadline is 360 minutes; `--timeout-minutes` accepts 1–360.

Action packages are downloaded from GitHub without rewriting. `actions/checkout` uses the actual GitEdge Git transport, including addresses without the `.git` suffix. Runner.Server interprets the workflow and supplies the runner protocol; this is not a guarantee that every GitHub workflow feature works. `runs-on` must match the current machine's real OS, architecture and labels. `--label` adds a label; it does not provision another operating system. Docker actions and container jobs require a working local container runtime.

Use `--job <id>` to select a job, `--event` to select the event name, `--event-file` for an optional JSON object payload up to 1 MiB, and `--secret-file` for a YAML mapping of string secrets. GitHub environment approval integration is not implemented. `GITEDGE_TOKEN` becomes `secrets.GITHUB_TOKEN`; the command also supplies `GH_HOST`, `GH_ENTERPRISE_TOKEN` and `GITHUB_API_URL`. Inherited GitHub authentication variables are removed before starting the execution processes. The operator supplies a token with the needed repository permissions; workflow `permissions` does not mint a narrower GitEdge job token. Workflows execute with the local user's access, so run only code and secrets trusted for that machine.

Unmodified `actions/upload-artifact` and `actions/download-artifact` packages are refused for custom origins: their toolkit checks the server host before accessing the artifact service. Reusable or composite actions can contain further unsupported dependencies; those failures remain visible in the runner output. Ordinary job files and the compatibility backend's local outputs are separate from the deployed container Actions artifacts.

The direct `actions run` command does not register a persistent GitEdge runner, dispatch automatically on pushes, publish trusted system CI checks, or implement GitHub environment approvals. The container service remains the default queue and check path; administrators can explicitly enable the local broker for `.github/workflows/` execution.

## Local runner broker

The production broker uses one GitEdge registration profile per host with a configurable number of execution slots (default 1). The server can lease a GitEdge workflow, signing job or GitHub Actions job through that generic profile. Signing profiles remain protected by account approval; eligible runners are matched using their reported OS, architecture and tools. Signing secrets are granted only for the authorized task and active lease. A typical setup uses one Mac broker and one broker per Windows host, all registered as generic runners; a host that can run several jobs at once uses a single registration with `--slots N` rather than several registrations. GitHub management credentials stay on the server; the Mac receives only the GitEdge runner credential and a one-job JIT configuration in the Runner.Listener environment. The installed official runner is copied to a private temporary directory and removed after the job. Run directories use short names (`r` or `s` plus six characters) in one root per host to stay under the Windows 260-character path limit: `<drive>:\ge\r` on Windows, restricted to the current user, and `runs` under the broker state directory elsewhere. GitEdge profiles automatically include the current host's `self-hosted`, OS, and architecture labels; `--label` adds a custom label. State and GitEdge runner credentials live under `work/runner-broker` with private directory and file permissions. Use `--state-dir` to relocate that data; hosts that run the launcher always pass it. A process lock prevents concurrent profile changes or brokers, and the slot locks in `actions/` under the state directory keep broker jobs from overlapping: each held slot writes `active.lock` (slot 0) or `active-<n>.lock`, and a lock whose owner process has exited is reclaimed. The same directory holds the cached workflow engine. A standalone `actions run` shares those locks only when it is given `--state-dir <state>/actions`.

`serve` opens one outbound WebSocket per profile to `/api/actions/runner/connect`, authenticated with the profile's runner credential, so a broker needs only outbound HTTPS/WSS; no inbound port or polling is involved. The first frame is a capacity report, repeated every 30 seconds and whenever an execution slot is taken or released, with `slots` set to the pool size and `busy` to the number of held slots. Reported free memory is the host's available memory minus the `need-mem` claims (512 MiB by default) of jobs already running on the broker, so a running job's reservation counts until it finishes. The server offers a job to the best idle connected broker; the broker takes a slot, checks the job's labels against fresh local capacity and accepts or declines (reasons `busy` (another offer to this profile is in flight), `slot-busy` (no slot, or a GitEdge workflow or signing job cannot get the host to itself) and `capacity-mismatch`; the broker never judges offer expiry from its own clock, so a late accept simply receives a `withdraw`), and a server-confirmed claim arrives as an assignment that runs through the unchanged execution paths. A job holds its slot until it ends and a report follows each slot change. GitHub jobs run in separate run directories and may overlap up to the slot count; GitEdge workflow and signing jobs run alone, so none starts while another job holds a slot and no other slot is taken while one runs. If the connection drops the broker reconnects after 1 second, doubling to 60 seconds with jitter and resetting once a connection has stayed up for 60 seconds; a job already running continues. A rejected or revoked credential is retried every 60 seconds with an error in the log. Run one broker per registration. A report build is bounded to 20 seconds; if no report has been sent for 90 seconds on an open connection the broker drops that socket and reconnects, and the server closes sockets whose last report is older than about 90 seconds (close code 4008), which also reconnects with the normal backoff. Close code 4003 means another broker connected with the same credential: the older broker logs that the profile was superseded and stops reconnecting that profile, lets jobs already running finish, and then exits with status 78 so a supervisor does not restart it into a takeover loop. The systemd unit sets `RestartPreventExitStatus=78`; launchd cannot match a single status, so the generated plist uses `KeepAlive` with `SuccessfulExit=false` and starts the broker with `--supersede-exit-status 0`. A leftover standalone GitHub polling profile makes `serve` and `list` fail until it is deleted with `remove <profile>`.

`serve` is a supervisor: it starts the broker as a child process that sends a heartbeat every 10 seconds, and kills the child's process tree and restarts it when no heartbeat arrives for 90 seconds, or when no report has been sent for 180 seconds while a dispatcher connection is open. Other child exits restart with a delay of 1 second doubling to 60 seconds, reset after 10 minutes of stable running. The supervisor exits with status 78 (or `--supersede-exit-status`) when the child does, and on SIGINT or SIGTERM it asks the child to stop, waits for it to finish and then exits. Supervisor events are logged to stderr with the `[broker-supervisor]` prefix. Service units start the launcher, which runs `serve` from the installed runner kit, so they get the supervisor without changes.

The slot count is stored in the profile: `register-gitedge --slots N` sets it (1–16, default 1) and `set-slots <profile> <n>` changes an existing profile; restart `serve` to apply it. All profiles served by one process share one pool whose size is the largest profile value (or `serve --slots N` when given). Size the pool to the host's CPU and memory; offers that exceed the remaining capacity are declined.

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

The optional budget values are persisted in the local profile: `--max-job-minutes` accepts 1–360, `--daily-minutes` accepts 1–1440 rolling minutes, and `--cost` accepts a relative 0–100 score (lower is preferred). In every report the broker sends OS, architecture, logical CPUs, one-minute load, available and total memory, free space in both broker and Actions work directories, and allowlisted tools detected on the host. Tool probes are bounded and cached for ten minutes; Docker is advertised only when `docker info` reaches a working daemon. The slot count and busy count are reported. The server applies the persisted budget and capacity report when choosing work.

Workflow `runs-on` may include case-insensitive resource requirements such as `RAM-2G`, `RAM-56M`, `CPU-4`, `DISK-50G`, `GPU-NVIDIA`, `GPU-AMD`, and `VRAM-8G`. G and M mean GiB and MiB. RAM and disk refer to currently available capacity in the execution work directories. GPU vendors are NVIDIA, AMD, Intel or Apple; VRAM requires dedicated installed memory on one matching card. Shared system memory and unknown GPU data cannot satisfy VRAM requests. Multiple minima use the largest value; incompatible vendor requirements or malformed resource tags keep the job queued. The existing `need-mem-2g`, `need-cpu-2`, `need-disk-10g`, `need-tool-docker`, and `need-time-45m` forms remain supported by the same parser. The broker and server reject unknown resource tags. The broker checks claims against current local capacity before launching the workflow and uses `need-time` as a deadline, clamped to the GitEdge workflow maximum. GitHub jobs default to a 360-minute local deadline. Keep a custom label such as `ci` in every intended workflow: registration still includes standard `self-hosted` and host labels, so labels alone cannot prevent a generic `self-hosted` GitHub workflow from matching. GitHub provides no server-enforced custom-label-only policy in this broker.

To install a macOS LaunchAgent, run `service install` from a checkout and name a fixed directory for the launcher. Install copies `scripts/runner-launcher.mjs` into that directory and writes the plist but does not start it; start, stop, and status operate on `com.gitedge.runner-broker`:

```sh
pnpm run runner-broker -- service install --install-dir /path/to/launcher --state-dir /path/to/state
pnpm run runner-broker -- service start --install-dir /path/to/launcher --state-dir /path/to/state
pnpm run runner-broker -- service status --install-dir /path/to/launcher --state-dir /path/to/state
pnpm run runner-broker -- service stop --install-dir /path/to/launcher --state-dir /path/to/state
```

The LaunchAgent invokes the Node executable that ran `service install` with `runner-launcher.mjs serve --state-dir <state> --supersede-exit-status 0`, uses the current user's home directory, and writes logs under the selected state directory. Keep the launcher directory in place while the service is installed; the checkout is no longer needed afterwards.

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
  --install-dir /opt/gitedge-launcher --state-dir /var/lib/gitedge/runner-broker --run-as-user gitedge
sudo pnpm run runner-broker -- service start --install-dir /opt/gitedge-launcher
sudo pnpm run runner-broker -- service status --install-dir /opt/gitedge-launcher
```

The unit runs `node /opt/gitedge-launcher/runner-launcher.mjs serve --state-dir /var/lib/gitedge/runner-broker`. The runner kit and its dependencies are installed under the state directory, so `pnpm` must be on the unit's `PATH` (the Node directory, `/usr/local/bin`, `/usr/bin` or `/bin`) and the service account's home must hold its pnpm store.

Use `ubuntu24-1gb-light` (or another custom label) in workflows that should target this small host. The broker does not provide server-enforced light-only routing; any workflow with matching standard labels can still be assigned by GitHub's native label rules.

An owner-wide registration serves enabled repositories in that GitEdge namespace; add `--repository` only to restrict it to one repository. To accept GitHub jobs, connect each source in the repository's GitHub sync settings and enable **Route GitHub self-hosted jobs to GitEdge runners**. Apply all migrations, including `0046_github_runner_bridge.sql`. Connections use the account's shared GitHub personal access token (the one saved under Account settings → Runners → Services & signing, also used for signing source reads and billing usage); no connection stores its own copy. Forge fetches it from the Actions Worker over the service binding `ACTIONS` at `https://actions.internal/internal/account-github-token`, which answers only service-binding calls (never the public Gateway) and returns the token of the connection creator's account Runner repository; 404 `github_token_missing` means no token is saved. A classic PAT needs the `repo`, `workflow` and `admin:repo_hook` scopes, plus `user` to read billing usage. A fine-grained token needs repository runner administration, Actions read, the synchronization permissions and Actions write for automatic network retries, and can limit access to selected repositories. After replacing the PAT, a connection that GitHub refused with `github_http_401` stays paused until it is resumed in the repository's GitHub sync settings (**Resume** clears the error and reconciles). GitHub owners can differ from the GitEdge namespace.

GitHub sends signed `workflow_job` requests to the connection's public webhook. Only jobs explicitly requesting `self-hosted` and matching the registered labels are claimed. GitEdge rechecks the source job before issuing a repository-scoped, ephemeral JIT identity. GitHub retains native action downloads, environment approvals, secrets, job credentials and logs. Temporary identities are removed after execution; cleanup is retried after connection failures. The queue accepts at most 100 pending demands per connection, expires unclaimed demands after 24 hours, and does not replay a completed or failed demand. Rerun the GitHub workflow after resolving an execution-start failure. GitHub chooses the eligible job for a temporary runner; it is not pinned to a webhook job ID.

Failed GitHub runner starts retain at most 16 KiB of listener diagnostics in `profiles/<profile>/logs` with private file permissions. The JIT configuration and job lease are redacted, and the temporary execution directory is removed.

GitEdge registration creates one runner through the admin API and stores its returned runner credential locally. `GITEDGE_TOKEN` is not saved. Remove a profile with `pnpm run runner-broker -- remove <profile>`. For GitEdge removal, supply `GITEDGE_TOKEN` again with administrator scope so the broker can revoke the server registration before deleting local state. GitHub jobs dispatched through the GitEdge profile do not use local `gh` authentication.

Manage custom routing labels in Account settings → Runners. Add comma-separated labels such as `server`, `device`, `ip-residential`, or `gpu`, then request them as literal `runs-on` labels with `self-hosted`. Combine a base label such as `server` or `device` with IP-type or other tags when needed. Every requested label must match; otherwise the job remains queued. These labels are administrator-declared routing tags and do not change the runner's reported OS, architecture, or resource capacity. Standard platform labels and all resource prefixes (`RAM-`, `CPU-`, `DISK-`, `GPU-`, `VRAM-`, `need-`) are reserved and cannot be asserted as custom tags.

Give runners with a persistent cache the custom label `cache-available`. Among eligible runners, GitEdge prefers those with this label and a current report of supported cache; within each group the usual CPU preference, capacity, load, and cost score decides. The label indicates cache availability, not a hit for a particular repository or key. Workflows need not request this label. Use a custom label such as `dependency-install` on runners allowed to install system dependencies and include it in `runs-on` when a job needs that capability; it is a required routing label.

GitEdge repository administrators must enable Actions and the **Use registered local runners** repository setting (`actionsRunnerEnabled`). Apply migration `0045_runner_broker.sql` and deploy the updated services, including the Actions → Auth binding, before registering a broker. Registration does not enable repository execution automatically. `.gitedge/workflows/` keeps its container precedence; opted-in `.github/workflows/` files use the persistent runner queue.

Account settings → Runners reads live host health through the Actions Worker’s private `DEVICES_HEALTH` service binding to the `HealthReader` entrypoint (`GET https://devices.internal/api/health`). Set the Actions operator variable `RUNNER_DEVICE_IDS` to a JSON object mapping registered runner UUIDs to device identifiers, for example `{"<runner-uuid>":"tokyo-arm64-01"}`. Device identifiers follow the monitor's `[A-Za-z0-9][A-Za-z0-9_#-]{0,63}` format. The mapping is explicit; runner names and labels are never used to identify a device. A missing mapping, unknown device, or unavailable health source displays unknown host health. The endpoint is only read by the authenticated runner overview and does not expose the device inventory publicly.

Registered runners discover only workflow definitions, then clone the selected commit through Git. The container snapshot limit does not restrict other repository assets for runner execution.

### Runner kit and launcher

Hosts, VM guests and their jobs run the runner kit that the GitEdge deployment publishes, so a broker never runs from a `git pull`ed checkout. The kit is the private package `@gitedge/runner-kit`: `scripts/runner-kit-pack.mjs` takes `packages/runner-kit/package.json` and `pnpm-lock.yaml` as the kit root, plus `scripts/runner-*`, `scripts/actions-runner.mjs`, `scripts/secure-runner-context.ps1`, `scripts/signing/`, `scripts/runner-vm/`, `packages/contracts/runner-scheduling.mjs` and `packages/contracts/signing-native.mjs`. It writes one gzip-compressed JSON bundle (`{ "format": 1, "files": [{ "path", "mode", "data" }] }`, sorted paths, LF line endings, base64 data, a fixed gzip header) whose SHA-256 is the digest `sha256:<hex>`. The pack fails when a script reachable from the launcher, broker, workflow engine, guest agent or signing client imports a relative file outside the kit or a package that `packages/runner-kit/package.json` does not declare; add broker dependencies there and refresh its lockfile with `pnpm install --lockfile-only --ignore-workspace` in that directory. `node scripts/runner-kit-pack.mjs [output]` prints the digest and size and optionally writes the bundle. `pnpm run deploy` publishes it as described in [Deployment configuration](deploy.md).

The server exposes two read-only runner routes:

- `GET /api/actions/runner/kit` with a runner credential returns `{ "data": { "digest": "sha256:<hex>", "size": <bytes> } }` for the current kit, or 404 when none is published.
- `GET /api/actions/runner/kit/<hex>` returns that kit's bytes as `application/gzip`. It accepts a runner credential, or the job lease credential of a running job, which is how VM guests fetch the kit. Every published kit stays downloadable.

The dispatcher's `ready` frame carries `kit: { digest, size }` (or `null` when no kit is published). Because dispatcher WebSockets survive deploys, a report whose `capacity.kit.digest` differs from the current kit is answered with a `{ "type": "kit", "kit": { digest, size } }` frame, unless `capacity.kit.failed.digest` already names that kit. A broker running from a kit adds `kit: { digest, failed?: { digest, reason, detail? } }` to every capacity report; it is stored with the runner's capacity, recording which kit each host runs and which update failed.

`runner-launcher.mjs` is a single file with no package dependencies and is the only GitEdge code installed on a host or baked into a VM image:

- `node runner-launcher.mjs serve --state-dir <state> [--slots N] [--supersede-exit-status N]` reads the origin and credential of the first registered GitEdge profile, asks for the current kit, downloads it (at most 64 MiB, checked against the announced size and SHA-256), unpacks it into `<state>/runner-kit/<hex>`, runs `pnpm install --frozen-lockfile --prod --prefer-offline` there and starts `scripts/runner-broker.mjs serve` from it. If the server or the installation fails it starts the most recently used installed kit instead, and with no installed kit it retries every 60 seconds. It keeps the three most recently used kits.
- When a new kit is announced, the launcher installs it beside the running one. On success it asks the broker to drain: the broker closes its dispatcher connections so it takes no new work, lets running jobs finish and exits with status 75, and the launcher starts the new kit. A failed download or installation leaves the running kit serving, is written to `<state>/runner-kit/status.json`, appears in the capacity report as `kit.failed` (`kit_download_failed`, `kit_digest_mismatch`, `kit_invalid`, `kit_install_failed`) and is retried after 15 minutes. A new kit whose broker exits with an error within 60 seconds is abandoned for the previous one with reason `kit_start_failed`.
- Exit statuses: 0 after SIGINT or SIGTERM (the broker is stopped first) or when the broker stops by itself, 78 (or `--supersede-exit-status`) when the registration was superseded, and 1 when no GitEdge profile is registered or the arguments are invalid. Other broker exits restart the kit after 1 second, doubling to 60 seconds. Status 75 is internal between kit and launcher.
- `node runner-launcher.mjs colab …` is the single-job entry point inside a Colab runtime (see [On-demand tiers](#on-demand-tiers)).
- `node runner-launcher.mjs version` prints the launcher protocol version. `node runner-launcher.mjs execute-vm-job` is the guest entry point. Any other broker command with `--state-dir` (for example `list`, `set-slots` or `verify-vm-images`) runs from the most recently used installed kit.

Registering a new host still needs the broker code once, because a kit download requires the runner credential: run `register-gitedge` from a checkout, then install the service. Hosted emergency runners are unaffected; they clone the deployment's `HOSTED_RUNNER_RUNTIME_SHA` and run the broker from that checkout, whose root install includes the signing dependencies.

#### Moving an existing host to the launcher

Do this once per host with a checkout that contains `scripts/runner-launcher.mjs`. Work in progress is cancelled when the old broker stops, so pick an idle moment. Keep the existing state directory: profiles and credentials stay where they are, and slot locks, run directories and the workflow engine cache move from `<checkout>/work/actions` to `<state>/actions` (the engine is downloaded again on first use).

1. Copy the launcher to a fixed location outside the checkout, for example `install -m 0644 scripts/runner-launcher.mjs /opt/gitedge/runner-launcher.mjs`.
2. macOS LaunchAgent: either rerun `service install --install-dir <launcher-dir> --state-dir <state>`, or edit the existing plist so `ProgramArguments` is `<node>`, `<launcher-dir>/runner-launcher.mjs`, `serve`, `--state-dir`, `<state>`, `--supersede-exit-status`, `0`, and `WorkingDirectory` is `<launcher-dir>`. Make sure `PATH` in `EnvironmentVariables` contains `pnpm`. Reload it with `launchctl bootout gui/$(id -u)/com.gitedge.runner-broker` followed by `launchctl bootstrap gui/$(id -u) <plist>`.
3. Linux systemd: rerun `sudo pnpm run runner-broker -- service install --install-dir <launcher-dir> --state-dir <state> --run-as-user <user>`, then `sudo systemctl restart gitedge-runner-broker.service`.
4. Windows Task Scheduler: change the task's action to `<node.exe> <launcher-dir>\runner-launcher.mjs serve --state-dir <state>`, keep the start-in directory at `<launcher-dir>` and keep `pnpm.cmd` on the task's `PATH`.
5. Check the broker log for `[runner-launcher] starting runner kit sha256:…` and that the runner's report shows the same `kit.digest`. The old checkout can then be removed; later deploys update the host on their own.

GitEdge runner workflows currently support:

- Human `push` and `workflow_dispatch` triggers. Push supports `branches` and `branches-ignore`; path and tag filters, PRs, merge groups and other trigger types are refused. Event payloads contain the repository, ref, source SHA and triggering identity; full GitHub commit metadata and history are not synthesized.
- `string`, `number`, `boolean` and `choice` dispatch inputs, including defaults and required values, through the Actions page or native API.
- Literal `runs-on` labels including `self-hosted`. All jobs in the workflow execute on one host matching the union of their labels. The local runner receives the complete union, including `need-*` labels, so Runner.Server can match the same job requirements. Expressions, `uses` packages and matrices are interpreted by Runner.Server; unsupported dependencies fail visibly in the runner output.
- Top-level `permissions: {contents: read}` or `write`; read is the default. Other permissions, job-level permissions, environments and concurrency groups are refused. The short-lived job token permits only the current repository's contents and Releases; it cannot manage runners, change repository settings, access Issues, or publish CI checks.
- At most 64 KiB of YAML, 16 job definitions, 128 steps per job and 40 required labels. Each job declares a 1–360 minute timeout, defaulting to 360; the workflow deadline is their sum capped at 360 minutes. Self-hosted runner admission does not use the built-in container runner allowance configured in [deployment settings](configuration.md#deployment-settings).

Jobs reach a broker through its dispatch WebSocket (`GET /api/actions/runner/connect`): the server offers a job, the broker accepts once it holds its execution slot, and the server then commits the lease and sends `assign`. There is no claim endpoint and no polling of the queue. See [runner-scheduling.md](runner-scheduling.md) for ranking and the frame protocol limits.

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
