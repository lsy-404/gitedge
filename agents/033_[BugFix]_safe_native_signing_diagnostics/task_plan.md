# Safe native signing diagnostics

## Goal

Preserve fixed, already-sanitized native signing phases in SDK stderr while keeping unknown error messages, secrets, URLs, paths, stdout, and stacks out of output.

## Steps

- [x] Inspect repository instructions, current client error formatting, and native executor diagnostic contracts.
- [x] Implement strict allowlists for the existing macOS, DMG, and Windows phase/code templates.
- [x] Add positive and negative behavior tests under `/test`, including the approved timeout-budget behavior.
- [x] Run the focused test and formatting checks.
- [ ] Commit the change locally for review; do not deploy or operate hosts.
