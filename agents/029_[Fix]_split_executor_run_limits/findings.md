# Findings

The six-run cap originates in the container-backed Actions admission path. Container inserts rely on the schema default `executor='container'`, so both the conditional insert and `Retry-After` lookup now explicitly scope their count to that executor. This keeps the container cap atomic and prevents runner rows from changing either rejection or retry timing.

Self-hosted runner admission now inserts the run without an hourly count. Native signing likewise no longer applies an hourly count to its first stage. The signing path still checks approved profile identity in the insertion, and continuation stages still require an admitted initial request. Existing idempotency and scheduler/capacity/lease controls are unchanged.

Validation: `test/actions/actions-service.test.ts` passed 5/5, including container rejection with six recent container runs and exclusion of seven simulated runner rows from count/retry calculation. `test/actions/runner-schedules.worker.test.ts` and `test/actions/signing-runner.worker.test.ts` passed 9/9, including real D1 enqueue of seven ordinary runner runs and seven approved native signing requests, plus continuation-admission negative control. `typecheck:actions`, Prettier check and `git diff --check` passed.
