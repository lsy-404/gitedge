# Native signing timeout propagation

## Goal

Use the approved signing profile timeout consistently from native queue admission through runner scheduling and the trusted SDK job, while leaving ordinary workflow timeout behavior unchanged.

## Steps

- [x] Trace native queue, scheduler, broker claim, trusted workflow, and CLI timeout behavior.
- [x] Normalize only valid `need-time-*m` resource labels to the approved profile budget.
- [x] Preserve all non-time labels and the stored approved workflow source.
- [x] Add focused Worker, broker, workflow, and CLI contract tests.
- [x] Run focused tests and formatting checks.
- [x] Commit locally for review; do not deploy.
