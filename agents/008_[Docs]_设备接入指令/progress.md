# Progress

- Read `AGENTS.md`, `PRODUCT.md`, existing `/agents` index, and the agent-mode skill.
- Inspected `docs/runner-scheduling.md`, `scripts/runner-broker.mjs`, `scripts/runner-capacity.mjs`, `scripts/runner-broker-service.mjs`, and `scripts/runner-systemd-unit.mjs`.
- Added `docs/runner-devices.md` with a common copy-paste prompt and device-specific context for IONOS Linux, localwin Windows, and existing localmac macOS broker.
- Updated the prompt with the seven-day / 1 GiB retired artifact/log retention and journald limits.
- Corrected IONOS/Tokyo02 host identity and setup boundaries; consolidated device guidance into one `DEVICE=IONOS|localwin|localmac` prompt.
- No code, service, remote host, or secret changes were made.
