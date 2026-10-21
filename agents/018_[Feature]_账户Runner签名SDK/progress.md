# Progress

- 2026-10-21: Created isolated branch `codex/account-runner-signing-sdk` from `85e9a18`; confirmed target signing directories are absent on this base.
- 2026-10-21: Read the native executor sources and Actions signing contract; sent `createSigningClient` / `runSigning` contract and confirmed multipart protocol with the access owner and parent.
- 2026-10-21: Committed foundation checkpoint `43cefb4` with strict UUID context handling, private file cleanup, Actions callbacks, streaming multipart transfer, native mature tooling and the first mock protocol suite.
- 2026-10-21: Aligned against core commit `0e13dfa` and its current changes: start manifests use mature snake_case platform contracts; verification reports retain mature per-file digests and bind source, profile, request, stage, and output archive separately without circular digests.
- 2026-10-21: Wired Windows approved Azure identity mode and dynamic profile-pinned Azure subject/endpoint; disabled Azure CLI. Mock end-to-end tests now cover Windows identity, iOS signing, macOS signing and credential-free finalization; heartbeat starts before large archive downloads and tracks the server lease expiry.
- 2026-10-21: Remaining service requirements sent to core: per-stage artifact resolution/template selection, macOS workflow stage transitions, and idempotent completion after an unknown response. Focused tests pass; real platform canaries remain external.

