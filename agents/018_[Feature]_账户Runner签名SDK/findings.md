# Findings

- The SDK consumes the broker's private context file only for local identity/lease binding, validates strict owner approval and GitEdge UUIDs, and deletes the context and temporary work directory after execution.
- Native platform manifests use the mature strict snake_case contracts; the adapters preserve their archive unpacking, signing, notarization, packaging, signature verification, and per-file SHA-256 checks.
- All authenticated callbacks carry the runner registration token plus run UUID and lease headers. Source/template downloads verify the expected full digest, and output uses 8 MiB streamed parts with per-part SHA-256, Content-Range and an independently verified whole-archive digest.
- Windows requires a profile-pinned Azure endpoint/account/certificate profile/subject and an explicit Managed Identity or Workload Identity mode, checked against the one-time authorize response. Azure CLI and other identity-chain providers are disabled.
- Finalization requests require an expiring server authorization but the SDK does not pass Apple signing credentials to the mature finalizer. macOS output is bound to the approved profile, request, stage, source, and finalization notarization evidence.
- The Actions core's stage scheduler, independent DMG template storage, and retry-idempotent completion remain cross-service integration requirements; local mock tests do not verify production native credentials or host tooling.
