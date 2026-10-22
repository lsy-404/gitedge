# Progress

- [x] Inspected the isolated worktree, latest origin/main, repository guidance, and existing quota paths.
- [x] Recorded the evidence distinguishing container execution limits from self-hosted runner admission.
- [x] Restricted the six-per-hour admission to container executions and removed it from runner/native queue admission.
- [x] Updated existing tests and documentation to assert the resulting executor-specific contract.
- [x] Ran targeted Actions worker tests and static checks; committed locally.

Commands and results:
- `git fetch origin main`; checked out `codex/runner-executor-quotas` from `origin/main` at `f929b6164fe55c0c510485f9869816f482ee8560`.
- `pnpm exec vitest run --config vitest.unit.config.ts test/actions/actions-service.test.ts`: 1 file, 5 tests passed.
- `pnpm exec vitest run --config vitest.config.ts test/actions/runner-schedules.worker.test.ts test/actions/signing-runner.worker.test.ts`: 2 files, 9 tests passed.
- `pnpm run typecheck:actions`: passed.
- `pnpm exec prettier --check ...`: passed.
- `git diff --check`: passed.
- Final verification rerun after simplifying container-only count SQL: unit suite 5/5; worker suites 9/9; Prettier and `git diff --check` passed. Earlier `pnpm run typecheck:actions` also passed.
