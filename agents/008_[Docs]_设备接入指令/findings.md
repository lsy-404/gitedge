# Findings

- Broker entry point is `pnpm run runner-broker --`; it requires Node.js >=24 and loads the repository's `yaml` package.
- GitEdge registration requires an installed official Actions runner and an admin-scoped `GITEDGE_TOKEN`; profile credential files are created private. Registration is owner/repository scoped and names are unique in local broker state.
- Broker capacity probes report actual OS, architecture, CPUs, load, memory, work-directory disk, and supported tools. Tool probes include node, pnpm, git, docker, python, go, and rust.
- `service install|start|stop|status` delegates to systemd on Linux and LaunchAgent on macOS. The service helper rejects other platforms; there is no supported Windows service command.
- Broker profile budget parsing supports `--max-job-minutes`, `--daily-minutes`, and `--cost`; omitted fields remain omitted, and server claim handling can retain previously stored budget fields. Instructions therefore avoid quotas and require explicit relative cost reporting when changing a profile.
- Parent supplied broker retention: retired artifacts and logs limited to 7 days and 1 GiB total; active directories, credentials, and runtime remain untouched.
- IONOS is a separate existing Linux VPS, not Tokyo02. Parent supplied `sudo bash scripts/runner-host-setup.sh` as the supported Linux setup command; it requires root, at least 12 GiB free to add 8 GiB swap, preserves existing swap >=8 GiB, and applies journald 128 MiB / 7 days. `--oci-idle-load` is Tokyo02-only.
- The handoff worktree does not yet contain `scripts/runner-host-setup.sh`; the prompt requires the target checkout to confirm the script exists before running the parent-supplied command.
- Tokyo02 is the dedicated OCI runner and is the full-time/no-time-quota host; do not apply its settings to IONOS.
- The user now intends signing to migrate fully to the GitEdge account runner. Until the GitHub execution repository is retired, preserve existing signing labels and credential boundaries. This task prepares ordinary CI only; later macOS/Windows signing pools require isolated identities and credentials.
- Inspected the parent integration's `scripts/runner-host-setup.sh`: no arguments or `--oci-idle-load` only; root and Linux required. Default mode checks aggregate swap, adds `/swapfile.gitedge` only below 8 GiB with at least 12 GiB free, and configures journald `SystemMaxUse=128M`, `RuntimeMaxUse=32M`, `MaxRetentionSec=7day`. The optional OCI mode creates/starts an idle-load timer and is not for IONOS.
- Existing localmac registration and signing-label history are supplied task facts. CLI exposes no profile-update command; device Codex must inspect available supported APIs and safely update the existing identity rather than creating a duplicate.
