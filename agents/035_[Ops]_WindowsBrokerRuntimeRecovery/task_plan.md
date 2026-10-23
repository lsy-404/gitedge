# Plan

- [x] Update the Windows stage gate to accept the verified Ready/result-1 state or Running.
- [x] Regenerate and validate the fixed Windows stage payload.
- [x] Obtain root review and run the reviewed idle-safe update on both Windows roots.
- [x] Read back successful receipts, exact live process identities, task state, and state-lock ownership for both roots.
- [x] Confirm post-readback D1 heartbeats and record the actual runtime evidence for both 4c947996 and bfe613 runtime targets.
- [ ] After platform signing verification, clean up only the exact owned temporary helper tasks.
