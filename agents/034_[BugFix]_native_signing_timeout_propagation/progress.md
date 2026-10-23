# Progress

- Normalized native queue labels to the approved timeout while preserving the source workflow and every other resource label.
- Normalized the broker's trusted signing workflow before demand validation, so scheduler claim, generated `runs-on`, job timeout, runner registration, and CLI deadline use the same budget.
- Focused unit tests passed 27/27; Worker integration tests passed 4/4. Actions TypeScript check passed after generating the ignored local Wrangler binding declaration; formatting and Node syntax checks passed. No deployment or host operation was performed.
