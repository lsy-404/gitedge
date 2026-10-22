# Task plan

- [x] Inspect the isolated worktree, latest origin/main, repository guidance, and existing quota paths.
- [x] Record the evidence distinguishing container execution limits from self-hosted runner admission.
- [x] Restrict the six-per-hour admission to container executions and remove it from runner/native queue admission.
- [x] Update existing tests and documentation to assert the resulting executor-specific contract.
- [x] Run targeted Actions worker tests and static checks; commit the verified branch locally.
