# GitEdge runner device handoff

Copy the shared prompt and one device block into Codex on the target device. It authorizes that Codex to inspect and configure only that host. Do not send credentials in chat or register the same broker twice.

## Shared prompt

```text
Configure the GitEdge Actions runner broker on this device using the device-specific facts below. Work on this device only; do not SSH to or make changes on another host, and do not send messages or credentials anywhere.

GitEdge origin: https://gitedge.voidcarve.com
Namespace owner: lsy-404
Source: https://github.com/lsy-404/gitedge.git, main

First inspect the existing checkout, broker state, official Actions runner installation, registration, service/task state, resource capacity, and actual CLI help. Preserve existing work and credentials. Reuse and upgrade the existing checkout, state directory, profile, and registration where possible. Do not create a second broker registration for this host. Fetch and fast-forward the existing checkout from origin/main only when it is safe; stop and report local changes or divergence rather than resetting, stashing, or overwriting them. Use Node.js 24 or newer and the repository's YAML runtime dependency.

Use the official GitHub Actions runner matching this host's OS and architecture. Keep exactly one active GitEdge broker/profile for this host. Do not spoof host OS/architecture labels. Probe and report the real tools available with the broker's supported probes; do not claim tools that are not installed. Configure one execution slot. Keep the broker state, profile credentials, and logs private (0600 files/0700 directories on Unix; an equivalent current-user-only Windows ACL).

Registration must be owner-scoped to lsy-404 at the origin above. Use the existing registration token/profile when valid. If re-registration is truly required, first establish how the current registration will be reused or safely revoked so there is never an unintended duplicate. Never paste a PAT, runner credential, or secret into chat or command output. Use a short-lived admin-scoped bootstrap PAT only through a protected local environment/input method; after successful registration and verification, remove it from the process/environment and revoke it. Do not register ordinary CI on this host with a signing key.

This host is an ordinary GitEdge Actions runner. Do not create or restore public/private exec profiles, and do not place signing-service private keys on this runner. The owner is preparing a unified signing service separately; do not migrate or alter server signing configuration.

Use the broker's current log-retention default. Do not invent a retention CLI flag or change retention policy. Do not configure a time/daily quota unless the owner explicitly requested one. Keep relative cost reporting enabled; use the profile's supported explicit --cost value (0–10 for this host, chosen from actual comparative capacity) when creating or updating a profile, because omitting budget fields may leave old server budget data in place. Report the selected value. Do not alter unrelated profiles or existing larger swap/pagefile settings.

Capacity preparation: Linux VPS should have 8 GiB swap if disk space permits. Windows may use an 8–16 GiB pagefile when applicable, preserving any larger managed setting. macOS uses OS-managed swap; do not replace it. Recheck free disk, memory, CPU, architecture, and tools after any adjustment.

Use the service manager actually supported by this checkout: Linux systemd and macOS LaunchAgent are implemented by `pnpm run runner-broker -- service ...`. The current CLI does not implement a Windows service. On Windows, inspect any existing service or scheduled task and preserve its account/working directory; if persistence needs configuration, use the native Task Scheduler for the logged-in user with a safe restart-at-logon policy, and explain the exact task and permissions. Do not claim Windows service support or use a made-up broker command.

After configuration, verify the dashboard shows one broker for this host with the expected real labels, capacity, tools, and cost; confirm no duplicate registration; then run one small job matching these labels and cancel or allow completion within 5 minutes. Check that the run is attached to the correct host and that logs contain no credentials. Stop if a step would require overwriting existing state, revoking an unrelated profile, changing server policy, or exposing a secret; report the evidence and next safe action.

Return a concise report with checkout revision, broker/profile identity (no secrets), actual host labels and probes, capacity and swap/pagefile status, service/task status, dashboard result, smoke-job result, bootstrap-token revocation status, and any blocker. Do not commit or push host configuration or secret/state files.
```

## Device facts

### IONOS Linux VPS

```text
Device: IONOS Linux VPS
Expected host labels to verify (not spoof): linux, x64
Service: use the supported systemd service after inspecting the current service user and private state ownership. Configure 8 GiB swap only if disk space permits and no larger setting exists.
```

### localwin Windows

```text
Device: localwin Windows
Expected host labels to verify (not spoof): windows, x64
Service: broker CLI has no Windows service implementation. Inspect current service/task state first; if needed, configure a native Task Scheduler task for the logged-in user and document its current-user-only credential ACL. Consider an 8–16 GiB pagefile only when applicable and never reduce a larger managed pagefile.
```

### localmac existing macOS broker

```text
Device: localmac, existing macOS broker
Expected host labels to verify (not spoof): macos, arm64
Service: reuse and upgrade the existing LaunchAgent and state. The current owner registration is lsy-404; inspect it and preserve it. Remove historical signing-specific labels only through a safe update of the existing registration/profile, without creating public/private exec profiles or putting signing keys on this host. Keep OS-managed swap.
```
