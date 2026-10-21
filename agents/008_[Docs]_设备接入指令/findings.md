# Findings

- Broker entry point is `pnpm run runner-broker --`; it requires Node.js >=24 and loads the repository's `yaml` package.
- GitEdge registration requires an installed official Actions runner and an admin-scoped `GITEDGE_TOKEN`; profile credential files are created private. Registration is owner/repository scoped and names are unique in local broker state.
- Broker capacity probes report actual OS, architecture, CPUs, load, memory, work-directory disk, and supported tools. Tool probes include node, pnpm, git, docker, python, go, and rust.
- `service install|start|stop|status` delegates to systemd on Linux and LaunchAgent on macOS. The service helper rejects other platforms; there is no supported Windows service command.
- Broker profile budget parsing supports `--max-job-minutes`, `--daily-minutes`, and `--cost`; omitted fields remain omitted, and server claim handling can retain previously stored budget fields. Instructions therefore avoid quotas and require explicit relative cost reporting when changing a profile.
- Parent supplied planned broker retention: retired artifacts and logs limited to 7 days and 1 GiB total; active directories, credentials, and runtime remain untouched. The receiving device must confirm that the checked-out release implements it and must not invent a flag or prune manually.
- node02 is to remain full-time with no time/daily quota, 8 GiB swap where disk allows, and journald bounded to 128 MiB / 7 days.
- Existing localmac registration and signing-label history are supplied task facts. CLI exposes no profile-update command; device Codex must inspect available supported APIs and safely update the existing identity rather than creating a duplicate.
