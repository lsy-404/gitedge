# Progress

- Read the approved runner scheduling design, Agent Mode workflow, repository instructions, current broker/service lifecycle and shared scheduling contract.
- Cherry-picked the shared contract into this worktree and implemented runner capacity probes, profile budgets, claim payload, resource/deadline checks, Linux systemd service management, deployment instructions and focused tests.
- Validation: `node --check` passed for all broker modules; `pnpm exec vitest run --config vitest.unit.config.ts test/broker-capacity.test.ts test/actions/runner-scheduling.test.ts` passed (2 files, 19 tests); Prettier check and `git diff --check` passed.
- Follow-up verified the actual GitEdge runner command arguments include the original demand labels, including reserved need-* labels.
- The parent owns live runner deployment; no server, SSH, or credential operations were performed here.
