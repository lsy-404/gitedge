# Task plan

- [x] Inspect the SDK error catch path and formatter allowlist at the current main revision.
- [x] Preserve actual `SigningContextError` instances through `runSigning` without exposing untrusted text.
- [x] Add end-to-end regressions for an allowlisted context error and an untrusted code after `runSigning` rejects.
- [x] Run the focused signing runtime tests and inspect the change.
- [x] Commit locally for review.
