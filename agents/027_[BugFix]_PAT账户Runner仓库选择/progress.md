# Progress

- Created an isolated worktree from the fetched `origin/main` baseline at `8558a0d`.
- Updated `AccessTokenSettings` to load the owner-only account Runner alongside the ordinary repositories and append it once by immutable repository ID. Added UI coverage that selects repository scope, verifies inclusion, refreshes with duplicate source data, and confirms the UI did not call the provisioning API.
- The focused picker UI test passed, the API docs/MCP settings UI suite passed (3 tests), the web typecheck/build passed, and formatting checks passed. No production deployment was run.
