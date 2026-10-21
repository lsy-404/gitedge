# Findings

- `parseJobClaim` removes only `need-*` labels from ordinary subset matching and retains the full source label array for GitHub JIT configuration.
- Broker profiles persist optional budget values with contract bounds: job minutes 1–360, daily minutes 1–1440, relative cost 0–100.
- Capacity uses Linux `MemAvailable` capped by remaining cgroup v2 memory, Node `statfs` available blocks, OS/architecture/logical CPUs/load, and a 10-minute allowlisted tool-probe cache. Docker is reported only after `docker info` succeeds. The report is single-slot/idle and sent on every GitEdge claim.
- GitHub jobs use a local `need-time` deadline (default 360 minutes). GitEdge resource requirements are aggregated over the workflow; execution timeout is clamped to the workflow timeout. The runner server remains the authority for queue budget and capacity matching.
- systemd runs the broker under a named non-root account, limits service CPU/memory/tasks, and uses SIGTERM with a 60-second stop window. Existing macOS LaunchAgent behavior is unchanged.
- Official GitHub Actions runner Linux x64 release checked for parent deployment: v2.338.0, published 2026-10-06; asset `actions-runner-linux-x64-2.338.0.tar.gz`, 227,660,598 bytes, release digest `sha256:af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32`. Release notes move runner internal Node operations to Node 24. Official dependency installer includes libkrb5-3, zlib1g, LTTng UST, OpenSSL 3 and ICU; Ubuntu 24.04 uses libicu74.
- Existing broker runtime requires Node >=24 and `yaml@2.9.1` (lockfile resolution); capacity and scheduling parser use Node built-ins plus the shared parser module.
- The repo-wide global ignore excludes `/agents`; task audit files must be force-added explicitly to keep the required records in the branch.
