# Findings
- Existing repository F:/Development/lsy-404@gitedge contains unrelated uncommitted runner changes; it is preserved.
- Origin main baseline caac5e4. Integration and feature work use isolated worktrees in the existing Windows Codex worktree root.
- Existing profile API/UI and durable GitHub synchronization are extended rather than replaced.
- [Startup configuration] Multiple logged-in Cloudflare accounts -> select the account already used by this GitEdge deployment -> remote Artifacts binding connected successfully.
- [Local deployment health] Missing deployment session encryption key -> generate a fresh local-only ignored .dev.vars key and restart -> full health ok.
- [Profile review] Timestamp incorrectly converted from milliseconds, filtered collection reused for totals/README, and false pinned label -> delegated corrections and regression coverage before integration.
- [Sync review] Bootstrap can resurrect deleted refs after missed webhook -> delegate common ref state and bidirectional deletion regression fixes; equal-ref bootstrap also needs a recorded baseline.
