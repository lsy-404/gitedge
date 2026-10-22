# Progress

- Inspected the signing broker launch path, service environment, SDK import path, and native signer Python selection. No host or workflow was modified.
- Updated `scripts/signing/ios-sign.mjs` to select `process.env.PYTHON || "python3"` directly, matching macOS. The strict plist API call remains unchanged.
- Removed the selector-only export and tests; the production behavior is a direct expression and the real iOS signing canary is the meaningful end-to-end validation.
- `node --check scripts/signing/ios-sign.mjs`, Prettier check, and `git diff --check` passed.
