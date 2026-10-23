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
- Post-merge read-only review completed against main `0403aafc7306ef6dad8d2b2acca0cb5e90b2f17b`; no concrete API, scheduler, snapshot, or broker matching defect found.
- Revalidated the existing projectless routing workflow with the service parser and scheduler claim parser after the `need-time-5m` correction. Workflow is read-only, five-minute, and requires `routing-verification` plus Node.
- No dispatch, deployment, host, credential, runner-label, or active-job mutation was performed.
- Live negative control: fixed workflow committed through authenticated Edge to private Runner main 3d6a64eea762ee0809b8de254b21df00bb99e474; dispatched once as bcfb3443-d430-4a1d-952a-cf5f43cefe57. D1 confirms queued, runner_id/start null and cancellation false while no active registration has routing-verification. UI editor is not deployed until supported Linux clients are updated.
- All five brokers idle-updated and verified at0403; Gateway92c543cc published the editor. Added routing-verification solely to Windowsroot2; the same previously unassigned run completed/success on5121cd0e, without any broker restart. Removed temporary tag after completion. Cleanup7833708dc removed the one-off workflow while retaining run history. Production labels are server/ip-datacenter for the two verified OCI hosts and device for the Mac/twoWindows, preserving previous tags. No residential classification inferred.
