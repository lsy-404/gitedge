# GitEdge runner device handoff

Copy the common prompt and one device block to Codex on that device. It authorizes local inspection and configuration only; do not send credentials or messages.

## Common prompt

```text
Configure the GitEdge Actions broker on this device using the device block below. Work on this host only; do not SSH to other hosts or send messages.

GitEdge: https://gitedge.voidcarve.com, owner lsy-404
Source: https://github.com/lsy-404/gitedge.git, branch main

Inspect the existing checkout, broker state/profile, registration, official Actions runner, service/task, capacity, and CLI help first. Preserve local work. Upgrade the existing checkout by fast-forwarding origin/main only when clean and safe; never reset, stash, overwrite, or create a duplicate registration. Use Node.js 24+ and the repository's YAML dependency. Use the official runner matching the actual OS/architecture; report actual OS, architecture, CPUs, load, memory, work-disk space, and tools detected by broker probes. Keep one execution slot and exactly one active broker for this host; never spoof host labels.

Reuse the current owner registration/profile. If a change requires re-registration, establish a safe reuse/revoke sequence before acting. A short-lived admin-scoped bootstrap PAT may be used only through a protected local input/environment; never print or paste secrets, and revoke it after successful verification. Keep state, credentials, and logs private: 0600 files/0700 directories on Unix, equivalent current-user-only ACL on Windows. Do not register ordinary CI with a signing key.

This is an ordinary runner. Do not create or restore public/private exec profiles, place signing-service private keys here, or alter server signing configuration. A dedicated signing pool will be handled separately.

Use the broker's supported current retention behavior: retire logs/artifacts after 7 days and keep their combined retired total at or below 1 GiB; leave active directories, credentials, and runtime data untouched. If this checkout/release does not implement that policy, do not invent a flag or clean files manually; report it. Do not set max-job or daily-minute quotas unless explicitly requested. Send an explicit relative `--cost` value of 0 or 10 for new/updated profile reporting; choose based on measured comparative capacity, report the choice, and preserve unrelated registrations. Never reduce existing larger swap/pagefile settings.

Use only implemented service commands: `pnpm run runner-broker -- service install|start|stop|status ...` supports systemd on Linux and LaunchAgent on macOS. On Windows, inspect existing service/task state; the broker has no Windows service command. If persistence is needed, use native Task Scheduler for the logged-in user with a safe logon/restart policy and current-user-only credential ACL. Do not invent broker service commands.

For a persistent service, configure journald limits of 128 MiB and 7 days where applicable. Prepare capacity only as specified in the device block. Verify one dashboard entry with matching real labels/capacity/tools/cost, then run one small matching job and complete or cancel it within 5 minutes. Confirm the run used this host and logs contain no secrets. Report checkout revision, profile identity (no secrets), probes/capacity, retention behavior, service/task, dashboard, smoke-job and bootstrap-token revocation results. Do not commit or push host configuration or secret/state files. Stop and report before overwriting state, revoking unrelated registrations, changing server policy, or exposing secrets.
```

## Device blocks

### IONOS Linux VPS

```text
Device: IONOS Linux VPS, node02; keep it online full-time. Verify actual labels are linux/x64. Do not set a time or daily quota. Configure 8 GiB swap if disk space permits, and set journald to 128 MiB / 7 days. Reuse the existing systemd broker service and state.
```

### localwin Windows

```text
Device: localwin Windows. Verify actual labels are windows/x64. Inspect and preserve existing service/task configuration. If persistence is needed, use Task Scheduler for the logged-in user; do not claim broker Windows-service support. Consider an 8–16 GiB pagefile only when applicable, preserving larger managed settings.
```

### localmac existing macOS broker

```text
Device: localmac, existing macOS broker. Verify actual labels are macos/arm64. Preserve the current lsy-404 owner registration, checkout, state, and LaunchAgent; inspect and safely update the existing identity to remove historical signing-specific labels only if supported. Do not create duplicate registrations or signing profiles. Keep OS-managed swap.
```
