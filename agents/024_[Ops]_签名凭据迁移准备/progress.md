# Progress

- Read the required agent-mode, Cloudflare, Wrangler and Workers best-practices instructions.
- Confirmed the GitEdge worktree source is `origin/main` at `ad1413ceb9790f4e2c1b109c68deb692976c1317`; created isolated branch `codex/credential-migration`.
- Inspected the legacy Worker config and read-only Wrangler metadata. No secret values were requested or displayed.
- Retrieved IRIS repository metadata and current shell workflow using the connected GitHub integration.
- Local `op item list` invocation did not return before the bounded wait and was interrupted; no item values were read. The parent reports a separate successful metadata search found no signing/Azure/GitEdge-specific item titles.
- Added a temporary GitEdge import branch to the existing credentials write endpoint and a service binding to the fixed-scope legacy WorkerEntrypoint RPC.
- Added recipient-encrypted envelope implementation and a local synthetic-token round-trip test. Added route tests for unsupported credential kinds and unapproved profile rejection.
- Expanded the secret-free policy candidates to 11 profiles across IRIS, Oblivionis, Epilogue, SynthV Toolbox and Stardust. Retrieved each linked workflow and recorded which input artifacts exist versus which caller adapters are still required.
- Validated all 11 candidate policy objects against the current `SigningPolicySchema`.
- Validation passed: GitEdge Actions typecheck and 19 unit tests in `test/actions/signing.test.ts`; legacy Worker typecheck/build dry run and two synthetic envelope tests. The full GitEdge deployment-stack dry run could not start child `pnpm` on this Windows shell; direct Actions typecheck passed.
- No production RPC, credential write, policy update, deployment, service restart or storage change was performed.
- Security review found the temporary service binding could otherwise be used by any owner of a self-approved profile. The import now requires exact configured `LEGACY_SIGNING_OWNER_ID` and `LEGACY_SIGNING_REPOSITORY_ID` matches before profile-status reads or private RPC; missing values fail closed. Added negative owner/repository tests and a positive encrypted-storage round trip.
- Raised the macOS legacy object/envelope cap from 16 KiB to 100 KiB. This covers the source contract's 40,000-character certificate plus 10,000-character notarization key and JSON/AES-GCM/base64 overhead; added a schema-valid >16 KiB test. The prior Cloudflare inventory reports 37.9 kB total across the two credential objects, but not per-object sizes.
- Revalidation passed after the security fix: GitEdge Actions typecheck and 20 signing tests; old Worker typecheck, build dry run, and 3 migration tests. The ignored production Wrangler config now has blank fail-closed owner/repository vars; the operator must set exact stable IDs before any deployment intended for transfer.
