# Progress

- Created an isolated worktree and branch at `origin/main` `bfe613a`; no unrelated worktree changes were copied or modified.
- Located the catch in `scripts/signing/client.mjs` and existing strict output allowlist in `formatClientErrorOutput`.
- Updated `runSigning` to preserve an actual `SigningContextError`; all other non-client failures still become the generic `SIGNING_FAILED` wrapper.
- Added a regression that calls `runSigning` with a throwing context reader, then passes the actual rejection through `formatClientErrorOutput`. An allowlisted code is retained, while a secret-like unknown code remains generic.
- Focused tests passed: unit formatter suite 12/12, client worker suite 16/16; `git diff --check` passed.
- Renumbered the audit directory and task index to 040 to avoid a concurrent Windows probe audit using 039; implementation and tests were unchanged.
