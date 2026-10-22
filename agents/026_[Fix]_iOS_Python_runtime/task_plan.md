# iOS signer Python runtime selection

## Scope

Make the iOS native signing SDK use the same configured-or-standard Python selection as the macOS signer. Keep the existing strict plist parser behavior and do not discover, download, or fall back to another interpreter.

## Plan

- [x] Inspect broker-to-signing SDK process environment and confirm workflow step `env` does not reach the signing child.
- [x] Change iOS plist parsing to use `process.env.PYTHON || "python3"`.
- [x] Add a behavior test proving an unset `PYTHON` selects the standard `python3` executable while preserving explicit configuration.
- [x] Run focused tests and commit only this task's implementation, test, and audit files.
