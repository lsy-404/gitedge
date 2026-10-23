# Findings

- `formatClientErrorOutput` recognizes only three fixed `SigningContextError` codes, but `runSigning` currently wraps every non-`ClientError` in `ClientError("SIGNING_FAILED")`. A context-reader failure therefore reaches the formatter only as a generic wrapper and loses the allowlisted context code.
- The safe minimal fix is to rethrow the actual `SigningContextError` alongside `ClientError`; the formatter already emits only its strict fixed-code allowlist and falls back to `SIGNING_FAILED` for unknown codes.
- Regression evidence confirms `runSigning` returns the same context error object to the formatter; a `TOKEN=private-value` code produces only `SIGNING_FAILED` and does not leak the value.
