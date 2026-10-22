# iOS signer Python runtime selection

## Scope

Make the iOS native signing SDK use the same configured-or-standard Python selection as the macOS signer. Keep the existing strict plist parser behavior; do not add discovery, downloads, or interpreter fallback.

## Plan

- [x] Inspect broker-to-signing SDK process environment and confirm workflow step `env` does not reach the signing child.
- [x] Change iOS plist parsing to use `process.env.PYTHON || "python3"` directly.
- [x] Validate syntax and formatting; defer end-to-end platform verification to a real iOS signing canary.
