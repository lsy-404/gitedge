# Progress

- Created an isolated worktree from the reviewed GitEdge base commit `28dac43`.
- Read the `agent-mode` workflow, GitEdge instructions, both PowerShell invocation sites, and the existing Windows PowerShell 5.1 ACL harness.
- Added `scripts/signing/windows-process.mjs` to create a child-only environment that filters `PSModulePath` case-insensitively; wired it into the broker secure-path and SDK context-reader subprocesses.
- Extended the Windows PowerShell 5.1 harness to start Node with a synthetic polluted module path, run the real context reader/checker, verify another inherited marker survives, and reject inherited and extra-SID ACLs.
- The real harness passed. Focused client worker suite passed 16/16; Node syntax checks, Prettier, and `git diff --check` passed. A first Vitest invocation selected a config that excludes this suite; reran with the repository's standard config successfully.
