# Findings

- The broker starts `scripts/signing/client.mjs` as a child process without a per-workflow environment override. A pinned workflow step's `env` cannot configure the sibling native signer process.
- The macOS SDK uses `process.env.PYTHON || "python3"`; the iOS plist parser instead rejected an unset `PYTHON`. Matching the existing macOS selection is the smallest correction.
- The plist parser still calls `plistlib.load(..., aware_datetime=True)`, so unsupported interpreters fail rather than silently weakening date handling. Host readiness must use a Python that supports the required API.
- The parent reported a live Mac probe for the ordinary `python3`: `/usr/bin/python3`, version 3.9.6, `PYTHON` unset, and `tarfile.data_filter` unavailable. This confirms the macOS archive gap on that host; it does not alter the iOS requirement to provision an interpreter with `aware_datetime` support.
