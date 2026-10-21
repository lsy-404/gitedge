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
1. Read the mature native signer and cutover document; identify invariants and execution boundary.
2. Read Actions auth, runner lease, artifact, and migration conventions; agree the integration hook and runner contract with the parent.
3. Implement request/policy/source/transfer/verification services with fail-closed eligibility and owner/repository binding.
4. Add migration and observable behavior tests under `/test`.
5. Run focused validation, inspect diff, and commit locally; report the exact integration hook and constraints to the parent.
