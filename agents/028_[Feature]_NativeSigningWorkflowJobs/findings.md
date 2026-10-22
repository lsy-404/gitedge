# Findings

- Signing claims currently bypass repository job-token issuance and run the SDK directly as a child process. This skips the normal Runner.Server environment that establishes setup-action PATH and environment changes.
- `runSigning()` completes the lease through its native callback before returning. The broker therefore must rely on a receipt written only after the SDK returns successfully and must not send ordinary runner completion for signing.
- The SDK already receives a protected context file path; the standard workflow job can use that as its only SDK secret-bearing input while setup steps receive no platform credentials.
- Signing profiles are pinned to a workflow revision. Approval must constrain signing workflows to one job without matrix expansion so one native lease cannot fan out.
- Standard Runner.Server passes the ordinary short-lived job token through its normal `github.token` setup. The broker removes inherited token variables before launching it, then adds only that job token plus the broker-slot marker to the child environment.
- The setup action steps and appended SDK command share the same Runner.Server job process, so the runner's existing PATH/environment propagation applies without introducing a custom setup interface.
- The SDK context now contains only the short-lived `ge_job_` credential. Signing machine routes validate it against AUTH's active job identity, the repository and owner, the run/request pair, and the lease; ordinary runner operations still require the registered runner credential.
- A completed job token can only replay the matching successful completion or failed execution callback while the original token and lease remain live. It does not authenticate ordinary runner operations.
- Native queue labels now include literal labels from the approved workflow. The broker validates the same labels and passes them to Runner.Server so host matching and resource budgeting reflect the pinned `runs-on` contract.
- Verification after these changes: signing workflow unit tests 25 passed; signing runner worker tests 3 passed; signing Actions runtime tests 4 passed; SDK client tests 9 passed; Actions typecheck passed.
