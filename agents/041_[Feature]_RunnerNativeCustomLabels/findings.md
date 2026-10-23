# Findings

- GitHub's documented self-hosted runner behavior supports custom labels; jobs with multiple labels require the runner to match all requested labels, case-insensitively. GitHub bridge and native GitEdge jobs already use the shared all-label scheduler path.
- The runner-management API previously supported registration and revocation only. The account Runner dashboard showed labels but did not edit them.
- Added owner/scope-authorized `PUT /runners/:id/labels` that replaces only custom routing labels. Existing system labels remain in place; `self-hosted`, OS/architecture labels, and every `need-*` resource label are rejected as custom input. This keeps actual platform and scheduler resource boundaries separate from owner-added routing tags.
- Custom labels use existing GitHub-compatible string constraints and are stored in the runner's existing labels array; no schema migration or workflow syntax change is required. Existing scheduling continues to require every requested label and leaves unmatched jobs queued.
- The UI examples use generic labels such as `device`, `ip-residential`, and `gpu`; a base `server` or `device` label can be combined with IP-type or other tags. The service does not infer or assign host/network attributes.

References:
- https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/apply-labels
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job
