# Findings

- The native toolchain in `runner/` contains mature per-platform verification and packaging flows; these files were copied intact into `scripts/signing/` and are invoked only on their matching native host.
- The broker callback contract uses GitEdge UUIDs and a runner registration credential. It does not use GitHub numeric run IDs, OIDC environment claims, or GitHub run environment variables.
- The context reader requires a regular single-link file, a restricted POSIX mode and owner, or a protected Windows DACL owned by the current sign-host identity. The client deletes it in `finally`.
- Multipart output uses 8 MiB parts, per-part SHA-256, content ranges and bounded retries; the final complete request carries the whole archive digest and the mature verifier's per-file report.
- Core's current generic manifest does not yet contain the formal native platform schemas needed to invoke the copied mature executors. Windows additionally requires an explicitly approved Managed Identity or Workload Identity mode; Azure CLI is disabled. Do not treat a generic manifest as a usable signing request.
