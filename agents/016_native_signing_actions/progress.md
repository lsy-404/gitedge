# Progress

- Created local branch `codex/signing-actions-core` from the integrated baseline and read the mature signer, cutover plan, and Worker conventions.
- Implemented owner-bound signing admission, immutable profile snapshots, source provenance, platform verification, credentials, multipart output, notary stages, and fair reconciliation.
- Profile approval reads both YAML and pinned workflow from the exact private Runner through the Git service and validates the canonical GitFile schema.
- The coordinator now records multipart plans, parts, and verified results in SQLite only. Actions Worker owns R2 multipart creation/completion, reads, writes, and streaming digest verification.
- Digest checks use Cloudflare's official `crypto.DigestStream` runtime API. TypeScript extends the DOM Crypto interface using Cloudflare's official Crypto type.
- Source admission allows completed-success default-branch builds, requires exact OIDC identity for active builds, and requires active-run OIDC for releases. Source state/tag reachability is rechecked before signing and subsequent stages.
- Source transfer enforces the profile artifact limit and fixed streaming length. Runner failures, cancellations, and expired leases transition requests through bounded reconciliation.
- Fixed strict reconciliation RPC payloads to send only owner ID, repository ID, and nonce; the real DO route rejected the previously spread D1 candidate row.
- Machine callback failures log request ID, operation, normalized error code, and error type without request bodies or credentials. Output authorization remains fail-closed.
- Removed unused DO schema compatibility logic and raised the internal RPC JSON limit to support verification reports.
- Credential encoding now uses shared base64 helpers, and notarization JSON uses the shared bounded reader.
- Focused signing tests pass (18 tests), `pnpm run typecheck:actions` passes, and `git diff --check` passes.
- The UI-owned end-to-end harness is being rerun with a platform executor that invokes the lazy credential provider.
