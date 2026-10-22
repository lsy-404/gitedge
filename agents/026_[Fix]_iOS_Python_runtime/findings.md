# Findings

- The broker starts `scripts/signing/client.mjs` as a child process without a per-workflow environment override. A pinned workflow step's `env` cannot configure the sibling native signer process.
- The macOS SDK uses `process.env.PYTHON || "python3"`; the iOS plist parser now uses the same direct expression. Its existing `plistlib.load(..., aware_datetime=True)` requirement remains strict.
- The parent reported a live Mac probe for ordinary `python3`: `/usr/bin/python3`, version 3.9.6, `PYTHON` unset, and `tarfile.data_filter` unavailable. This is concrete evidence for the macOS unpack gap on that host; the upcoming real iOS canary is the validation for the iOS runtime and full native signing path.
- The broker resolves its repository root relative to `scripts/runner-broker.mjs` and spawns a fresh `scripts/signing/client.mjs` process for each native signing stage. Replacing only `scripts/signing/ios-sign.mjs` on that checkout does not require restarting the broker; perform the file update after active signing children have drained so no child is still between stage routing and dynamic import.
