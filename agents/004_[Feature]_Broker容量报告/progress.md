# Progress

- Read the approved runner scheduling design, Agent Mode workflow, repository instructions, current broker/service lifecycle and shared scheduling contract.
- Cherry-picked the shared contract into this worktree and implemented runner capacity probes, profile budgets, claim payload, resource/deadline checks, Linux systemd service management, deployment instructions and focused tests.
- Validation: `node --check` passed for all three broker modules; `pnpm exec vitest run --config vitest.unit.config.ts test/broker-capacity.test.ts test/actions/runner-scheduling.test.ts` passed (2 files, 18 tests); Prettier check and `git diff --check` passed.
- Next: inspect the final diff, stage only broker-owned files and this audit folder, commit the task branch, then report the branch and runtime/deployment boundary to the parent.
