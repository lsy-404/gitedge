# Account Runner signing SDK implementation plan

- [x] Inspect the existing native signing executors and Actions signing contracts; report the SDK boundary to the API owner.
- [x] Port the approved platform executors and strict signing schemas without weakening platform verification.
- [x] Add a native UUID/context-file client with bounded API operations, streaming multipart transfer, and complete cleanup.
- [x] Add contract, HTTP protocol, context-file, and platform executor mock tests under `/test`.
- [x] Abort native platform execution immediately when the signing lease heartbeat fails.
- [ ] Finish cross-service stage/template artifact progression and idempotent completion against the integrated Worker, run focused checks, and commit locally without pushing.
