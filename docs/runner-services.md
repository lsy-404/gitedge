# Private Runner services

Runner is the account's private service processor. Services currently run as finite task workflows, either manually or by cron. They use the existing account-runner queue, capacity matching, budgets, leases, cancellation and execution history.

Open **Settings → Runners → Private service center** and create Runner. GitEdge provisions exactly one private repository in the personal namespace, initializes a README and a small manual workflow, and opens Actions. The owner can edit service files and workflows. The repository's identity, privacy, transfer, collaboration, fork and individual deletion controls are locked by the server.

If `runner` is already used or retained as an old repository route, creation reports a conflict. It never converts or overwrites that repository. Interrupted storage creation can be retried safely; concurrent requests return the same repository or a temporary provisioning status.

## Configure a task service

Create or edit a YAML file under `.github/workflows/` in Runner. Target an account runner with literal `self-hosted` labels and a bounded timeout. The initial workflow works on any matching host with Node.js.

```yaml
name: Maintenance
on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 */6 * * *"
jobs:
  maintain:
    runs-on: [self-hosted, need-tool-node, need-time-5m]
    timeout-minutes: 5
    steps:
      - name: Check runtime
        run: node --version
```

Use Actions to choose the workflow, run it manually, inspect its queue/execution status and read results. Other project repositories keep their existing workflows.

## Cron behavior

- `on.schedule` accepts one to five POSIX expressions with five fields. Timezone is **UTC**.
- Schedules use the current default branch of the private Runner repository. Committing a changed definition updates its schedule; removing or invalidating the definition disables that schedule.
- The service checks due work every minute. Worker scheduling or an unavailable machine can delay execution; cron is not an exact-time guarantee.
- Duplicate scheduler ticks do not create duplicate runs for the same workflow occurrence. Missed intervals are coalesced into one queued run rather than replayed as a burst.
- Runner admission has no shared six-runs-per-hour repository cap. Queueing still respects a busy runner, disabled account, revoked machine, disabled execution and configured resource budgets.
- To stop a timer, remove its `schedule` entry and commit. Use Actions to cancel an already queued or running job.

## API

`GET /api/forge/account-runner` returns `{ data: { repository: Repository | null } }`. `POST` on the same path provisions the repository and returns `{ data: Repository }`, with status 201 for creation or 200 for reuse. Both management operations require the owner's browser session; scoped agent/job credentials continue to use the normal repository interfaces.

## Signing services

Signing uses separately approved definitions, machine purposes and credential access. An ordinary task workflow cannot gain signing access by changing labels or YAML. The native signing migration and platform requirements are described in [sign-executor-cutover.md](sign-executor-cutover.md).

See [account-runner-signing.md](account-runner-signing.md) for machine setup, profile approval and task submission.

## Runner hosts

The machines that execute these services run the runner launcher, which installs the runner kit published with each GitEdge deployment and switches to a new kit after running jobs finish. Hosts need no checkout updates; see [Runner kit and launcher](actions.md#runner-kit-and-launcher) for the launcher and for moving an existing host's launchd, systemd or Task Scheduler unit to it.

## Colab waker host

Google Colab is the second on-demand tier (see [On-demand tiers](actions.md#on-demand-tiers)). Colab sessions are opened through the official [colab-mcp](https://github.com/googlecolab/colab-mcp) server v1.0.2, which drives a Colab page in a real browser, so one fixed host with a desktop session acts as the waker.

Requirements:

- macOS or Linux with a logged-in desktop session (not a headless server), Node 24, `pnpm`, and [uv](https://docs.astral.sh/uv/) so that `uvx` is available. The waker runs `uvx git+https://github.com/googlecolab/colab-mcp@v1.0.2`; the first start downloads the server and Python 3.13 or newer.
- The default browser signed in to the account owner's Google account with a paid Colab plan. colab-mcp opens `https://colab.research.google.com/notebooks/empty.ipynb` in that browser and waits 60 seconds for the page to connect back to a local WebSocket. Allow the browser's local network access prompt for `colab.research.google.com` if it asks. Each session opens a new tab; old tabs show a disconnected state and can be closed.
- The GitEdge Colab extension loaded in that browser. Colab asks for confirmation ("Connect to a local Colab MCP server") before a page connects to colab-mcp, and nobody is there to click it. The waker copies the extension to `<state>/colab-extension` on every start; load that folder once as an unpacked extension (Edge: `edge://extensions`, Chrome: `chrome://extensions`, enable developer mode, **Load unpacked**). The waker opens the page through its own opener (colab-mcp's `BROWSER`), which adds `gitedge-waker=1` to the URL, and the extension confirms only pages carrying that marker; Colab sessions you start yourself still ask.
- A GitEdge runner registration created by the account owner (owner-wide `register-gitedge`, as for any broker). The waker reads the first registered profile in its state directory without taking the broker's state lock, so it can share the state directory of a broker already running on the same host, or use its own. Waker polls do not make the registration count as an online runner; Account settings → Runners → On demand lists it under waker hosts.

Run it through the launcher, like a broker:

```sh
node /path/to/launcher/runner-launcher.mjs colab-waker --state-dir /path/to/state --uvx /opt/homebrew/bin/uvx
```

`--colab-mcp SPEC` overrides the server package (default `git+https://github.com/googlecolab/colab-mcp@v1.0.2`). Logs go to stderr with the `[colab-waker]` prefix; colab-mcp writes its own logs under `<state>/colab-mcp-logs`.

For each dispatch the waker starts colab-mcp as an MCP stdio client, calls `open_colab_browser_connection` (up to three attempts, each with a fresh server), waits for the page's notebook tools (`add_code_cell`, `run_code_cell`, `get_cells`), then adds and runs a Python cell that downloads Node 24 and the official runner, verifies both by SHA-256 and starts `runner-launcher.mjs colab` in the background with the one-time bootstrap token. Every minute it reports to GitEdge and runs a status cell that reads the runner's exit status. When the job ends, the session expires or GitEdge cancels the dispatch, it runs `google.colab.runtime.unassign()` to release the runtime and closes colab-mcp. It handles one session at a time.

macOS LaunchAgent example (`~/Library/LaunchAgents/com.gitedge.colab-waker.plist`). It must run in the user's GUI session so colab-mcp can open the browser:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gitedge.colab-waker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/launcher/runner-launcher.mjs</string>
    <string>colab-waker</string>
    <string>--state-dir</string><string>/path/to/state</string>
    <string>--uvx</string><string>/opt/homebrew/bin/uvx</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/launcher</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardErrorPath</key><string>/path/to/state/colab-waker.log</string>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gitedge.colab-waker.plist` and stop it with `launchctl bootout gui/$(id -u)/com.gitedge.colab-waker`. Make sure `PATH` contains `pnpm`, which the launcher uses to install the runner kit.
