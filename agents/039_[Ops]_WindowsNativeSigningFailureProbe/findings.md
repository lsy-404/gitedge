# Findings

- The target Windows native run is terminal failure. The probe is constrained to the runner's existing step log files, the exact run window, and the established `GitEdge-native-signing` step filename. It emits only fixed SDK codes, known Windows phases/diagnostics, and heartbeat booleans.
- The current SDK formatter explicitly allows `INSECURE_CONTEXT_FILE`, `INVALID_CONTEXT`, and `INVALID_CONTEXT_FILE`; these codes are included alongside the existing client error allowlist so the probe can distinguish context setup failures from generic signing failures.
- The first dispatch completed successfully but targeted root one and returned zero candidate files. A read-only lookup of this exact native run's runner metadata identified `windows-broker-2`, so that probe result is out of scope for failure attribution. The fixed probe now scans only root two.
- The corrected probe found exactly one candidate in root two (`candidateCount=1`, no ambiguity, 16 in-window lines, no read errors or limits). It reported `SIGNING_FAILED` at `2026-10-23T01:39:07.8009454Z`, no specific Windows diagnostic, and all lease/heartbeat error flags false. This narrows the failure to the signing step but does not identify a more specific cause.


- The scan refuses to combine matches from multiple step files; it reads only a single non-symlink GitEdge-native-signing file whose modification time is near the fixed window and whose RFC3339 log lines fall inside that window. The output includes the expected request/native-run IDs but no log paths, messages, or host arguments.
- The corrected run was `88e0db61-29eb-493c-b4f9-2eb49407a01e` (controller run `39886270288`, GitEdge commit `77781f320d319532d662efe99761116e0e9f2e09`). Its summary matched request `0781e294-ff4c-4626-83c7-81f92ea46923` and native run `fb66abb1-767a-4bd8-8f95-6e7ef22d6313`; expected runner was `windows-broker-2`.
