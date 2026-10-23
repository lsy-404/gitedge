# Windows broker runtime recovery

## Scope
Prepare the Windows-only idle-safe updater for the two ordinary broker roots. Target runtime revision: `4c94799660f698dc5a65ae933ded9ffda5c4cd79`. No host mutation has been performed in this task.

## Findings
The prior host readback showed persistent broker Scheduled Tasks in `Ready` with `LastTaskResult` 1. The stage workflow previously required `Running`, so it rejected the verified inactive state before installing the already-reviewed idle-safe helper. The persistent broker task may be `Running`, or it may be `Ready` only with a prior run and result 1. All other states/results remain rejected. The helper itself waits for the root's existing atomic active lock and performs its own exact process/task checks before replacement.

## Validation
Regenerated the fixed stage PowerShell and workflow payload. PowerShell parser and YAML 1.2 validation are part of the builder. A payload assertion confirms the generated script accepts `Running` or the exact known `Ready`/result-1 state and no longer contains the Running-only gate. Windows helper smoke test passes and confirms exact PID replacement plus a fresh broker stable for 45 seconds.

## Status
Prepared for root review. Do not upload or dispatch before review.
