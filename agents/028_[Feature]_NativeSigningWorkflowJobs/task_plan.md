# Native signing through standard workflow jobs

- [x] Record current signing claim, runner execution, and profile validation contracts.
- [x] Issue a short-lived repository job token for signing claims and execute one pinned job through Runner.Server.
- [x] Append a trusted SDK step with protected-context paths and an explicit success receipt.
- [x] Add focused regression coverage for workflow setup environment, preparation failure, and missing receipt.
- [x] Bind native signing API calls to the run-scoped job token, with a narrow completion replay path.
- [x] Carry approved workflow host labels into scheduler demand and validate their resource claims.
- [x] Run targeted tests and review the final diff.
