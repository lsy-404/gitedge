# GitEdge runner device handoff

Copy this prompt to Codex on the target device and set `DEVICE` to `IONOS`, `localwin`, or `localmac`.

```text
DEVICE=IONOS

Configure or verify the GitEdge Actions broker on this device only. Do not SSH to another host, send messages, or expose credentials.

GitEdge origin: https://gitedge.voidcarve.com
Namespace owner: lsy-404
Source: https://github.com/lsy-404/gitedge.git, branch main

Inspect the existing checkout, broker profile/state, server registration, official GitHub Actions runner, service/task, capacity, and current CLI before changing anything. Preserve local work; fast-forward origin/main only when the checkout is clean and safe. Never reset, stash, overwrite, or create a duplicate registration. Use Node.js 24+ and the repository's YAML dependency. Use the official runner matching the actual OS and architecture, report the broker's real capacity and detected tools, and keep one execution slot and one active broker for this host. Do not spoof host labels.

Reuse the existing owner registration/profile. If re-registration is required, determine a safe reuse/revoke sequence first. Use a short-lived admin-scoped bootstrap PAT only through protected local input/environment; never print or paste secrets, and revoke it after successful verification. Keep broker state, credentials, and logs private (0600 files/0700 directories on Unix; equivalent current-user-only ACL on Windows).

Runners are general-purpose. Native signing uses the trusted platform SDK and receives protected profile credentials only for its active signing lease; do not install persistent signing credentials on the host. Until the GitHub execution repository is retired, preserve routing labels required by its supported workflows. Leave server signing profiles unchanged during device setup.

Honor broker retention of retired artifacts/logs for 7 days and 1 GiB combined. Active directories, credentials, and runtime data are excluded. Confirm this behavior exists in the checked-out release; do not invent a retention flag or manually prune files. Keep existing time and daily budgets on IONOS, localwin, and localmac unchanged; do not add quotas to a new profile unless requested. Tokyo02 alone is explicitly configured without time or daily limits. Preserve an existing profile's cost. For a new registration, use the supported relative `--cost` value of 0 or 10 based on the host's role; do not treat registration as an update command. The GitEdge profile does not require GitHub CLI authentication; `gh` is only required for a standalone GitHub polling profile.

For DEVICE=IONOS: this is the separate existing IONOS VPS, not a Tokyo host. Inspect its existing state and never apply Tokyo-only settings. Confirm the upgraded main checkout contains `scripts/runner-host-setup.sh`, then run `sudo bash scripts/runner-host-setup.sh` to apply Linux defaults: 8 GiB swap and journald capped at 128 MiB / 7 days. The script requires root, needs at least 12 GiB free to add swap, and preserves existing swap of 8 GiB or more. If the script is absent, stop and report it; do not guess a substitute. Do not pass `--oci-idle-load`; that optional policy is for Tokyo hosts only. Reuse systemd if already configured.

For DEVICE=localwin: verify actual Windows/architecture labels. Preserve any existing service or scheduled task. The broker has no Windows service command; if persistence is needed, use native Task Scheduler for the logged-in user with a safe logon/restart policy and current-user-only credential ACL. Use absolute Node executable and broker-script paths, the checkout as the working directory, an explicit state directory, and a PATH containing the workflow tools. Put Git for Windows' `bin` directory before Windows system paths so explicit `shell: bash` steps resolve Git Bash rather than the WSL launcher. For Rust MSVC builds, initialize the Visual Studio developer environment and set `CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER` to its absolute MSVC linker path so Git Bash's GNU `link.exe` cannot shadow it. Verify the task in its actual logon environment. Consider an 8–16 GiB pagefile only when applicable, never reducing a larger managed setting.

For DEVICE=localmac: verify actual macOS/architecture labels and preserve the existing registration, checkout, state, and LaunchAgent. Keep existing signing routing labels until the GitHub execution repository is retired and migration is verified; do not create duplicate registrations. Keep OS-managed swap.

For Linux Rust builds, install a C compiler and linker (`build-essential` on Ubuntu); musl targets may also require `musl-tools`. Keep HOME equal to the service user's home. The systemd unit explicitly stores Cargo and Rustup caches under the private writable broker state directory and includes Cargo's bin directory in PATH.

Linux systemd and macOS LaunchAgent use the supported `pnpm run runner-broker -- service install|start|stop|status ...` commands. Do not claim Windows service support or invent broker commands. After configuration, verify the dashboard shows exactly one broker for this host with matching real labels, capacity, tools, and cost. Run one small matching job and complete or cancel it within 5 minutes; confirm it ran on this host and logs contain no secrets. Return checkout revision, profile identity (no secrets), probes/capacity, retention, service/task, dashboard, smoke-job, and bootstrap-token revocation results. Do not commit or push host configuration or secret/state files. Stop and report before destructive state changes, unrelated revocation, server policy changes, or secret exposure.
```
