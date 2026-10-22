# Private Runner services

Runner is the account's private service processor. Services currently run as finite task workflows, either manually or by cron. They use the existing account-runner queue, capacity matching, budgets, leases, cancellation and execution history.

Open **Settings → Runners → Private service center** and create Runner. GitEdge provisions exactly one private repository in the personal namespace, initializes a README and a small manual workflow, and opens Actions. The owner can edit service files and workflows. The repository's identity, privacy, transfer, collaboration, fork and individual deletion controls are locked by the server.

If `runner` is already used or retained as an old repository route, creation reports a conflict. It never converts or overwrites that repository. Interrupted storage creation can be retried safely; concurrent requests return the same repository or a temporary provisioning status.

## Configure a task service

Create or edit a YAML file under `.github/workflows/` in Runner. Target an account runner with literal `self-hosted` labels and a bounded timeout. The initial workflow works on any matching host with Node.js.

```yaml
name: Maintenance
on:
  workflow_dispatch: {}
  schedule:
    - cron: "0 */6 * * *"
jobs:
  maintain:
    runs-on: [self-hosted, need-tool-node, need-time-5m]
    timeout-minutes: 5
    steps:
      - name: Check runtime
        run: node --version
```

Use Actions to choose the workflow, run it manually, inspect its queue/execution status and read results. Other project repositories keep their existing workflows.

## Cron behavior

- `on.schedule` accepts one to five POSIX expressions with five fields. Timezone is **UTC**.
- Schedules use the current default branch of the private Runner repository. Committing a changed definition updates its schedule; removing or invalidating the definition disables that schedule.
- The service checks due work every minute. Worker scheduling or an unavailable machine can delay execution; cron is not an exact-time guarantee.
- Duplicate scheduler ticks do not create duplicate runs for the same workflow occurrence. Missed intervals are coalesced into one queued run rather than replayed as a burst.
- Runner admission has no shared six-runs-per-hour repository cap. Queueing still respects a busy runner, disabled account, revoked machine, disabled execution and configured resource budgets.
- To stop a timer, remove its `schedule` entry and commit. Use Actions to cancel an already queued or running job.

## API

`GET /api/forge/account-runner` returns `{ data: { repository: Repository | null } }`. `POST` on the same path provisions the repository and returns `{ data: Repository }`, with status 201 for creation or 200 for reuse. Both management operations require the owner's browser session; scoped agent/job credentials continue to use the normal repository interfaces.

## Signing services

Signing uses separately approved definitions, machine purposes and credential access. An ordinary task workflow cannot gain signing access by changing labels or YAML. The native signing migration and platform requirements are described in [sign-executor-cutover.md](sign-executor-cutover.md).

See [account-runner-signing.md](account-runner-signing.md) for machine setup, profile approval and task submission.
