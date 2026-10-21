# Native signing in Actions

## Objective
Move native signing request admission, policy snapshots, source provenance, large artifact transfer, platform verification, and short-lived credential authorization into the Actions Worker, bound to the account owner and private Runner repository.

## Scope
- `workers/actions/src/signing/**`
- `packages/contracts/src/signing.ts`
- migration `0050`
- `/test` signing behavior tests
- this audit's `task_plan.md`, `findings.md`, and `progress.md`

Do not modify Actions routing, runner lifecycle/scheduler, Worker config, root package, or unrelated audit files. Do not push, deploy, or access secrets/live services.

## Plan
1. [x] Read the mature native signer and cutover document; identify invariants and execution boundary.
2. [x] Read Actions auth, runner lease, artifact, and migration conventions; agree the integration hook and runner contract with the parent.
3. [x] Implement request/policy/source/transfer/verification services with fail-closed eligibility and owner/repository binding.
4. [x] Complete the DMG four-stage path and verify Apple notary acceptance before later stages.
5. [x] Replace globally shared source GitHub token with owner/repository/profile-scoped encrypted credentials.
6. [x] Fix machine profile read for queued start and strengthen end-to-end tests for DMG retries/stage transitions.
7. [ ] Finish fair reconciliation and remaining audit findings, rerun validation, and commit the final checkpoint.
