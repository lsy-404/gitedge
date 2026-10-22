# Task plan

- [x] Inspect the latest isolated worktree and read repository/Cloudflare operation guidance.
- [x] Identify the exact request path and exception boundary for the failed submit call.
- [x] Inspect available production telemetry for the 503 without reading or changing secrets or data.
- [x] Reproduce the 503 handling boundary locally; production logs do not preserve enough detail to identify the underlying branch yet.
- [x] Add safe admission diagnostics and a focused regression test without changing source verification behavior.
- [x] Run relevant tests and checks, then commit the isolated branch locally.
- [ ] Capture a new first-attempt canary after the diagnostic deployment and repair the confirmed cause.
