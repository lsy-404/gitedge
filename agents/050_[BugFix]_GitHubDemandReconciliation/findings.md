# Findings

- Production runner 138 was issued for Shell job 120272062708 but actually picked up Core job 120271242290. The original Shell job remains queued. Literal GitHub labels permit another compatible job to consume the temporary runner.
- Existing cleanup deletes the temporary identity and leaves the original demand completed, preventing another allocation. Reconciliation belongs in Forge, which owns GitHub credentials.
- An unknown JIT response must not be replayed. Requeue only a known runner that has been observed assigned, and only after removal succeeds. Recheck current connection, repository, owner and runner authorization.

- Reviewing a requeued lease showed that clearing started_at/completed_at also removes that execution interval from the existing 24-hour usage query. Preserve the observed interval as an append-only runner-demand-requeued audit event in the same conditional D1 batch as the reset; include these intervals in budget usage. Reuse the indexed account audit ledger, avoiding schema/data migrations and telemetry-based estimates.
