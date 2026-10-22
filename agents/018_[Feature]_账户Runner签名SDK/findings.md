# Findings

- The SDK consumes the broker's private context file only for local identity/lease binding, validates strict owner approval and GitEdge UUIDs, and deletes the context and temporary work directory after execution.
- Native platform manifests use the mature strict snake_case contracts; the adapters preserve their archive unpacking, signing, notarization, packaging, signature verification, and per-file SHA-256 checks.
- All authenticated callbacks carry the runner registration token plus run UUID and lease headers. Source/template downloads verify the expected full digest, and output uses 8 MiB streamed parts with per-part SHA-256, Content-Range and an independently verified whole-archive digest.
- Windows requires a profile-pinned Azure endpoint/account/certificate profile/subject and an explicit Managed Identity or Workload Identity mode, checked against the one-time authorize response. Azure CLI and other identity-chain providers are disabled.
- Finalization requests require an expiring server authorization but the SDK does not pass Apple signing credentials to the mature finalizer. macOS output is bound to the approved profile, request, stage, source, and finalization notarization evidence.
- If the lease heartbeat fails during native execution, the SDK now aborts the active platform command immediately; abort cleanup is allowed to remove temporary keychains and files. The broker also supervises the lease independently and terminates the process tree.
- The real DO/D1/R2 Worker integration fixture reaches signing output initialization, but source admission currently fails with `signing_source_storage_unavailable`. Core is moving R2 lifecycle work into the Worker route and switching to Workers `crypto.DigestStream`; rerun the full fixture after that repair lands.
- Shared native manifest and verification schemas now come directly from `packages/contracts/signing-native.mjs`; a duplicate SDK copy would allow Worker and executor validation to drift.
- Callback identity is headers-only. Core is removing output-init's duplicate JSON run/lease fields to match the common callback contract.
- The Actions core's stage scheduler, independent DMG template storage, and retry-idempotent completion remain cross-service integration requirements; local mock tests do not verify production native credentials or host tooling.
# Callback identity contract

All signing callback identity is carried in the mandatory `X-Runner-Run-Id` and `X-Runner-Lease-Token` headers, with the registration bearer token. JSON POST bodies contain only operation-specific fields. This avoids duplicate identity representations and strict-schema failures; the Actions boundary validates the lease headers before forwarding trusted context to the coordinator. Output multipart parts continue to use those same headers.
