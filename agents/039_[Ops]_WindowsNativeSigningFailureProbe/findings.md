# Findings

- The target Windows native run is terminal failure. The probe is constrained to the runner's existing step log files, the exact run window, and the established `GitEdge-native-signing` step filename. It emits only fixed SDK codes, known Windows phases/diagnostics, and heartbeat booleans.
- The current SDK formatter explicitly allows `INSECURE_CONTEXT_FILE`, `INVALID_CONTEXT`, and `INVALID_CONTEXT_FILE`; these codes are included alongside the existing client error allowlist so the probe can distinguish context setup failures from generic signing failures.


- The scan refuses to combine matches from multiple step files; it reads only a single non-symlink GitEdge-native-signing file whose modification time is near the fixed window and whose RFC3339 log lines fall inside that window. The output includes the expected request/native-run IDs but no log paths, messages, or host arguments.
