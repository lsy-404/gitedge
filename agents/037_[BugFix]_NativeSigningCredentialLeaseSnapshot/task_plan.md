# Task plan

- [x] Inspect the signing authorization route, broker lease snapshot, and SDK expiry validation.
- [x] Return the authoritative lease snapshot with each credential grant and validate against that snapshot in the SDK.
- [x] Add regression coverage for a server snapshot newer than the SDK heartbeat snapshot and reject missing, expired, non-integer, and overlong grants.
- [x] Run focused client and signing route tests, inspect the final diff, and commit the isolated change.
