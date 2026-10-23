# Progress

- Created isolated `codex/runner-tags` worktree from `origin/main` at `bfe613abb3c4a6bac6cdf160338eacbbc5dceb10`.
- Read the agent-mode skill, project instructions, and GitEdge project index.
- Added shared system-label classification and custom-label validation to the runner contract.
- Added owner-authorized custom-label replacement endpoint, audit event, and AccountRunners editor.
- Documented native `runs-on` usage and the fact that custom labels do not change reported host capacity.
- Added worker tests for owner authorization, platform/resource label protection, emptying custom labels, and persistence; scheduler tests for all-label routing; and UI tests for editing custom tags.
- Validation passed: runner scheduler tests (12), signing/runner worker tests (5), AccountRunners UI tests (9), Actions TypeScript typecheck, Vue typecheck, and `git diff --check`.
- Product code remains local to this worktree; no dispatch, deployment, host changes, or credential changes occurred.
- Parent review copy adjustment: examples now use reusable base tags (`server`/`device`) plus optional IP-type and other tags. Confirmed broker heartbeat updates only capacity/budget/last-seen columns, active job labels are stored separately at enqueue and not changed by runner label updates, and runner management rejects job/PAT identities without human admin authorization.
- Follow-up: implemented authoritative claim-label snapshots and stale-label claim guard. Broker execution remains local-profile immutable and requires the server snapshot on every response; no compatibility fallback was added.
- Validation passed: Actions signing/GitHub worker tests (12), broker label contract tests (2), Actions TypeScript typecheck, and `git diff --check`. Prettier completed on all modified files.
- No host, deployment, or production operation was performed.
- Additional verification: runner-scheduling unit tests passed (12), including scheduler label semantics.
