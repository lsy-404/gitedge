# Findings

## Current callers and run state

- Current `lsy-404/IRIS` main has no live IRIS-Build dispatch path in `.githooks/pre-push`, `scripts/`, `.github/`, or `package.json`; `.github/workflows/core.yml`, `shell.yml`, and `publish-shell.yml` use IRIS's own current release/upload secrets and workflows. There is no `sign.voidcarve.com`, `SIGNING_API_KEY`, or `repository_dispatch` reference in the current code search. The licensing README's statement that a local hook and six-hour scan trigger IRIS-Build is stale and inconsistent with the current implementation; documentation correction is in progress. It is not evidence of an active build dependency or a separate archive gate.
- Current `lsy-404/IRIS-Build` main retains old-service client code (`scripts/import-macos.mjs`, `scripts/submit-macos.mjs`, `scripts/submit-windows.mjs`, `scripts/publish-shell.mjs`), used by `import-macos.yml`, `build.yml`, and `publish-shell.yml`. This is legacy implementation inside the repository proposed for archive, not an independent upstream caller; no current IRIS-main path to those legacy signing endpoints was found.
- In-scope consumer review: current main in Oblivionis, Epilogue, SynthV (`SynthVCopilot/synthv-toolbox`), and Stardust uses GitEdge signing. Old-domain strings appear only in historical audit notes or tests asserting absence of the old string.
- GitHub Actions read-only queries on 2026-10-22 returned zero `in_progress` runs for `IRIS`, `IRIS-Build`, `signing-exec-private`, and `signing-exec-public`. The three target repositories (`IRIS-Build`, `signing-exec-private`, `signing-exec-public`) currently report `archived:false`. No archive, delete, cancel, or secret operation was performed.
- IRIS run `39861295192`: latest GitHub jobs readback shows `prepare` is `completed/cancelled`, while its `Wipe workspace` step remains `in_progress` and post steps are pending. A prior metadata-only GitEdge D1 read showed all nine bridge jobs completed with `cleanup_pending=0` (six success, three null conclusions). GitEdge lease cleanup is clear, but GitHub workspace cleanup is still active; do not touch that runner or cancel the run.

## Old-service resources and preservation

- Worker: `voidcarve-signing-center`, custom domain `sign.voidcarve.com`; cron runs every 15 minutes. GitEdge no longer has a service binding to it.
- Durable Object binding `COORDINATOR` exports `SigningCoordinator`. Preserve its namespace, objects, and request history; do not run `wrangler delete`.
- R2 bucket `voidcarve-signing-credentials` contains two encrypted Apple credential objects: `apple/signing-credentials.v1` and `apple/ios-signing-credentials.v1`. Preserve them unchanged; do not read plaintext or delete them.
- R2 bucket `voidcarve-signing-artifacts` stores request artifacts with an existing seven-day request-object lifecycle. Do not perform any extra bucket-wide deletion. Preserve DO history.
- The Worker also uses a GitHub token. Do not revoke the shared source token. Reassess the legacy Azure UAMI separately only after old jobs are actually drained.
- The signing-center repository is outside the three target repositories. This task prepares service retirement only and does not archive that repository.

## Retirement checklist (prepared only)

1. Immediately before retirement, recheck old-repository workflow runs and old-service/GitEdge request status; wait for workspace cleanup of IRIS run `39861295192` to finish.
2. Stop the old Worker ingress and cron first to prevent new requests. Do not delete the Worker or its DO class/namespace.
3. Preserve the `SigningCoordinator` namespace and records, both encrypted Apple R2 objects, and object policy. Keep the shared GitHub source token and old Azure UAMI unchanged.
4. Correct the stale IRIS licensing README description of the former IRIS-Build trigger; this documentation correction is in progress and does not require a separate production authorization.
5. Archive the three target repositories only after all remaining tasks are terminal and the new signing chain is accepted. Handle the signing-center repository separately.

## Evidence boundary

This record uses read-only GitHub REST queries, current-main source searches, and an existing Cloudflare D1 metadata-only result. No secret values, R2 contents, or sensitive DO fields were read; no production service, runner, workflow, or repository was changed.
