# Findings

- GitHub's documented self-hosted runner behavior supports custom labels; jobs with multiple labels require the runner to match all requested labels, case-insensitively. GitHub bridge and native GitEdge jobs already use the shared all-label scheduler path.
- The runner-management API previously supported registration and revocation only. The account Runner dashboard showed labels but did not edit them.
- Added owner/scope-authorized `PUT /runners/:id/labels` that replaces only custom routing labels. Existing system labels remain in place; `self-hosted`, OS/architecture labels, and every `need-*` resource label are rejected as custom input. This keeps actual platform and scheduler resource boundaries separate from owner-added routing tags.
- Custom labels use existing GitHub-compatible string constraints and are stored in the runner's existing labels array; no schema migration or workflow syntax change is required. Existing scheduling continues to require every requested label and leaves unmatched jobs queued.
- The UI examples use generic labels such as `device`, `ip-residential`, and `gpu`; a base `server` or `device` label can be combined with IP-type or other tags. The service does not infer or assign host/network attributes.

References:
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job
- Extended the shared claim contract with a mandatory server registration-label snapshot for idle, busy, GitHub, ordinary workflow, and native signing responses.
- Bound candidate claim to the exact registration-label JSON used during scheduling. A concurrent label edit now makes the atomic claim fail and the run stays queued.
- Broker validates each required snapshot and uses it only for that execution's profile across ordinary GitEdge workflows, native signing, and GitHub JIT. Host OS/architecture validation and local capacity checks remain authoritative; workflow demand labels never populate the host profile.
- Regression coverage includes an old local label set, newly configured server tags, successful native/GitHub matching, rejection of absent tags, and a stale-snapshot claim race.

## Post-merge review

- Read-only review at `0403aafc7306ef6dad8d2b2acca0cb5e90b2f17b` found no reachable defect in label management, scheduling, claim snapshots, or broker matching.
- The label update endpoint preserves server-owned OS/architecture/resource labels, rejects those values from custom input, and requires the existing human admin/scope authorization. Active job labels are snapshotted separately; the labels update does not rewrite an active job. Claim uses an equality guard against the scheduled `labels_json`, so an edit racing with dispatch leaves the job queued for a later claim.
- Broker requires the server label snapshot for every GitEdge claim response, validates host platform labels before execution, and uses the snapshot for the claimed job. Matching remains case-insensitive AND; absent custom tags do not match. Capacity/tool checks remain driven by the declared `need-*` labels.
- The prepared dynamic routing workflow was not edited. `parseRunnerWorkflow` accepts its fixed label set and five-minute timeout; `parseJobClaim` confirms `valid=true`, `tools=[node]`, and `minutes=5` after the `need-time-5m` correction.
- No production runner tags, credentials, active jobs, or deployments were changed. No additional code change was warranted by this review.
