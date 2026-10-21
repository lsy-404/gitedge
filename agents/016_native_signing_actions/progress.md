# Progress

- Created local branch `codex/signing-actions-core` from integrated baseline `ae967313eaa654a93d3b54786bee9ad6d3d8e6d9`.
- Loaded agent-mode, Cloudflare, and Workers best-practices skills; read the cutover plan and mature signer source.
- Implemented the SigningCoordinator state machine, owner-bound request admission, trusted machine route adapter, GitHub workflow/run/artifact checks, and source archive verification.
- Added migration 0050 for native-run bindings, immutable approved profile snapshots, and owner/profile/platform-scoped AES-GCM credentials.
- Added 8 MiB multipart output upload up to 2 GB with streaming per-part and final archive SHA-256 checks. Windows profiles require an explicit managed/workload identity mode.
- Added mature snake_case per-platform manifests, strict report schemas, archive verification, and Apple notary status/log verification for terminal macOS reports. Finalize stages receive no signing credentials.
- Added `GET/POST /signing/profiles` and credential status/install/revoke operations. Approval and credential writes require a recent owner session; profile and credential responses expose no secret material.
- Profile approval now reads the YAML and workflow from the exact private Runner repository at the pinned Forge OID; source GitHub APIs are used only for provenance checks.
- Added idempotent macOS sign-to-finalize progression and `reconcileSigningRequests` for the parent-owned scheduled hook. It retries accepted/unbound final stages through the idempotent native enqueue adapter.
- Added owner/repository-scoped job and token admission, repeat-safe failure callbacks, repeat-safe completion preflight, and multipart verification recovery after a transient R2 read failure.
- Focused signing tests pass (11 tests), `pnpm run typecheck:actions` passes, and `git diff --check` passes.
- DMG stages remain explicitly rejected because there is no separately approved template object path. `reconcileSigningRequests` still needs the parent to invoke it from the existing scheduled handler; this branch does not edit Actions routing or scheduler files.
