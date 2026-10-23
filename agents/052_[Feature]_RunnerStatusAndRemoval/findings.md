# Findings

- The runner dashboard and summary counts already existed on main; there was no removal control and the summary sat below the services panel.
- Backend DELETE /api/actions/runners/:id already revokes a registration (owner or creator).
- Branch claude/gitedge-runner-ui-update-53e7f8 carries four unmerged runner scheduling commits (050, 051).

## Tokyo ARM diagnosis (2026-10-23)
- [tokyo arm reported offline] -> [remote read-only D1 SELECT on actions_runners, 4 samples over ~90s] -> broker-tokyo-arm64-01-6f312711 (revoked_at NULL) heartbeats every ~35s (last_seen within 2-3s of the amd64 node); UI offline threshold is 60s (OFFLINE_MS in workers/actions/src/runner-overview.ts). It is ONLINE now; no fault reproduced. Margin is only ~25s, so a single slow heartbeat or a restart during the 022 updater swap could show a transient offline.
- [host access] -> [ssh config, known_hosts, 1Password config, agents notes] -> ARM host address is not recorded in any note or ssh alias (only an unhashed pair of 161.33.x.x IPs in known_hosts, unattributed); SSH not attempted to avoid guessing. No host mutation made.
- Note: registration name is broker-tokyo-arm64-01-6f312711, not tokyo-arm64-01. Offline revoked rows (macos-broker x1, macos-broker-2) exist and are the removal-UI test data.

- The overview no longer returns revoked registrations, so the "revoked" runner state was dead and was removed from the contract, i18n and the locale-key test list (test/ui/i18n-messages.test.ts); no behavioral test changed.

- [Review found 4 defects in removal UI] -> [accessible name per runner, allow removal for any non idle/busy runner, abort in-flight poll after removal, space token gap] -> [applied]
- [Tokyo ARM shown offline while heartbeating every ~35s] -> [OFFLINE_MS was 60s, one late beat flips the state] -> [raised to 90s to tolerate two missed beats]
