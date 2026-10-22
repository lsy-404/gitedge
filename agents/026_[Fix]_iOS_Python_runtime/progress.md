# Progress

- Inspected the signing broker launch path, service environment, and native signer Python selection. No host or workflow was modified.
- Updated `scripts/signing/ios-sign.mjs` to select `process.env.PYTHON || "python3"`, matching the macOS signer while leaving `plistlib.load(..., aware_datetime=True)` unchanged.
- Added unit coverage for an unset `PYTHON` and an explicit executable path.
- Focused Vitest: 2 passed. Prettier check and `git diff --check` passed.
