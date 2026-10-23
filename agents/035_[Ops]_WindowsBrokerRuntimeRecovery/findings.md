# Windows broker runtime recovery

## Scope
Update only the two ordinary Windows broker roots under their existing idle-slot gate and verify the actual broker processes against target revision `4c94799660f698dc5a65ae933ded9ffda5c4cd79`. Keep temporary helper scheduled tasks until production signing canaries have completed; do not stop or restart either broker again in this task.

## Findings
The reviewed idle-safe stage completed successfully in runner workflow `eb832f09-fdfb-450e-ac19-1aea69361bd7`. A later readback workflow (`2ad69462-a100-4f37-bb53-006537fd8fcb`) confirmed both checkouts at the target SHA and both receipts successful. It also matched each receipt's new PID and creation time to the exact Node executable, broker script, `serve` action, and state directory; the corresponding `active.lock` was owned by that same PID with action `serve`.

| Broker root | Old PID | New PID | Receipt completed | New process started | Task / helper | State lock |
| -- | --: | --: | -- | -- | -- | -- |
| `D:\GitEdge\runner-broker` | 97244 | 62360 | 2026-10-23T00:31:40.219Z | 2026-10-23T00:30:52.082Z | Running / Ready, helper result 0 | PID 62360, `serve`, owned |
| `D:\GitEdge\runner-broker-2` | 98104 | 92308 | 2026-10-23T00:31:35.918Z | 2026-10-23T00:30:47.318Z | Running / Ready, helper result 0 | PID 92308, `serve`, owned |

Both receipts recorded 45 seconds of stable task runtime. The readback found exactly one matching broker process per root, neither old PID remained, and neither fixed stderr busy marker was present. Therefore the earlier stale-state-lock concern was not borne out: each lock was validly held by its live replacement broker. No lock was deleted and no broker was stopped or restarted after the stage.

The immediately subsequent D1 read showed fresh registration and capacity heartbeats, with zero consecutive failures and no hold: `windows-broker` at `2026-10-23T00:44:54.465Z` and `windows-broker-2` at `2026-10-23T00:44:50.809Z`. Runner IDs were `d0d02c77-b42f-4c44-93b2-797b6746635a` and `5121cd0e-dc33-44cf-a2c2-ecb53ec471ef` respectively.

The readback's original JSON array exceeded the runner-log line limit and had a PowerShell array-shape issue. The fixed readback emits one bounded flat JSON record per root, compares the active lock against the matched process PID, and completed successfully. Its controller run was `39879853070`; GitEdge committed the fixed workflow as `417992bc16d2b77f934d3c046dab73ed489de346`.

Temporary helper tasks remain in place pending completion of platform signing verification. Their cleanup is a separate exact-task operation and has not been performed here.

## Validation
- PowerShell parser accepted the readback script.
- The fixed maintenance-controller contract test passed and verified the embedded workflow payload digest and read-only behavior.
- The live readback completed successfully and its two NDJSON records matched receipts, process identity, task state, and lock ownership.
- D1 confirmed fresh heartbeats after the readback, zero consecutive failures, and no hold for both Windows registrations.

## Status
Windows runtime recovery and verification are complete. Temporary helper cleanup remains pending the platform signing canaries.
