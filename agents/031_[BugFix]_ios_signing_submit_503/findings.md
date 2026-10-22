# Findings

Production canaries are Stardust, not IRIS: `stardust-fans/star-dust-fans_android`, run `39866764509` and fresh first-attempt run `39867251621`, profile `stardust-ios`. Both successfully built and uploaded the approved iOS artifact, then the submit script received HTTP 503. The fresh run's artifact upload completed at 22:46:22Z and GitHub logs show only `GITEDGE_HTTP_503` at 22:46:27Z.

The Gateway and Actions tails both observed the fresh `POST /signing/requests` at 22:46:23–25Z. No `actions:request-failed` event occurred. Read-only profile and token metadata checks confirmed the expected active profile, source repository/artifact policy, and Runner repository grant; no credential values were read.

The route's explicit Runner/profile failures and source-storage failure returned 503 without logging a safe reason. Its outer catch also translated unclassified exceptions to `signing_unavailable` without logging. Source attestation failures return 422 and remain unchanged. Added fixed phase/code/error-type diagnostics to distinguish these server-side paths without logging exception messages, request data, IDs, or credentials. A new first-attempt canary after deployment is needed to identify the exact production cause; the failed run must not be replayed.

Root reviewed, merged, and deployed the first-stage diagnostic before dispatching new first-attempt canaries; failed runs were not replayed.

The deployed substage diagnostic on run `39868445683` reported `signing_source_artifact_download_failed` after the initial GitHub ZIP redirect had passed validation. Cloudflare Workers do not support `redirect: "error"` for outbound requests, which causes an immediate `TypeError` before the target download is sent; this matches the observed source stage and is documented in the Cloudflare Workers Request API. Replaced that mode with `manual`; reject and cancel any redirect or non-2xx response from the already-validated artifact host. No subsequent redirect is followed, and the existing host allowlist and source checks remain intact.

Worker-runtime coverage verifies that the old redirect mode throws, manual download succeeds for an allowed target, and a redirect response is rejected without a second fetch. `pnpm run test:signing` passed 5/5, focused unit tests passed 20/20, Actions typecheck and formatting checks passed. Await deployment of the download fix and a new first-attempt canary to confirm successful source admission/signing.
