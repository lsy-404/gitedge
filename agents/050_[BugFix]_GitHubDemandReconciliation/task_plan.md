# GitHub demand reconciliation

- [x] Compare GitHub job assignment with the claimed demand in production.
- [ ] Reconcile the original job after a known assigned temporary runner exits.
- [ ] Cover a different job consuming the runner, terminal jobs and disabled connections.
- [ ] Verify and deploy Forge without interrupting brokers or active jobs.

Only requeue a known issued and assigned runner's demand when GitHub still reports the same original job queued. Preserve unknown JIT outcomes and cancellation gates. Use conditional updates so delayed cleanup cannot erase a new lease.

- [ ] Preserve consumed lease time atomically in the existing immutable audit ledger before resetting a demand, and include it in runner budgets without schema changes.
