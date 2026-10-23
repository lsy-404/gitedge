# Findings

## Current failure path

- `runSigning` wraps native executor failures as `ClientError("SIGNING_FAILED")` and preserves the original Error as `cause`.
- `executeMacos`, the disk-image executor, and `executeWindows` already replace raw executor errors with fixed, sanitized operation messages. The Mac canary's message shape is `macOS signing operation failed: <fixed phase>`.
- `formatClientErrorOutput` currently emits only the outer error code, discarding these fixed phases. It must not emit `cause.message`, stack, stdout, or arbitrary cause properties.
- The coordinator keeps SDK stdout generic; this change affects only the existing SDK stderr/log path and does not expand the server contract.

## Design

- Parse only exact operation message templates and emit only allowlisted phase/code tokens.
- Preserve the existing first-line generic outer code. Append one fixed diagnostic line for recognized native causes.
- For unrecognized Error causes, emit only a built-in Error class label without its message. Unrecognized cause text remains absent.
- Emit Windows nested diagnostics only when their exact scope and mode are recognized and their detail matches a fixed literal or bounded numeric format. Unknown bracket content is discarded while preserving the fixed phase.
- Include the three fixed macOS signature verification phases `signature_chain`, `signature_team`, and `signature_timestamp`.
- Extend the trusted appended SDK step's job timeout to the approved run timeout because the setup workflow's original short timeout also bounds the signing step. Keep this within the existing profile budget and enforce the broker's supported 1..360 minute bound.
- Do not alter signing verification, credential handling, or coordinator APIs.
