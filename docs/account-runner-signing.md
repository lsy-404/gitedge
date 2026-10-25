# Account Runner signing

Signing runs use the private account Runner repository and the same generic runner registrations as other GitEdge and GitHub jobs. The Actions Worker owns profile approval, encrypted credential storage, request state and artifact storage. A runner is eligible when its reported operating system, architecture, labels and tools satisfy the signing profile and workflow requirements. No separate signing registration, dedicated-host approval or OS service identity is required. The intended deployment uses one Mac broker and two Windows brokers, all registered as generic runners.

## Runner setup

Install the broker and platform toolchain on each host, then register it with the standard `register-gitedge` command for the account Runner repository. Keep the GitEdge registration token and local runner state private. The broker stores the returned GitEdge runner credential; signing credentials remain encrypted on the server and are delivered only to the authorized task under its active lease.

macOS profiles need the required Apple signing and notarization tools. iOS profiles need the approved Xcode, SDK, certificate and provisioning profile. Windows profiles need the approved Microsoft signing tooling. The broker reports its real OS, architecture and available tools so the scheduler can match requirements; custom labels do not change the host platform.

## Approve a definition and credentials

Keep signing profiles in `.gitedge/signing/<name>.yml` within Runner. A profile pins a workflow path and commit from the same private repository, a platform, timeout and product/source policy. Approval reads that exact workflow from GitEdge and stores an immutable snapshot. Editing YAML does not authorize a new revision; approve it again explicitly.

Source policy identifies permitted GitHub repository IDs, workflow path, artifact name, actor IDs, events and branch/tag names. GitHub is used to validate the source build and download its archive.

Without `releaseTagPattern`, a source build must come from its repository's default branch. A release profile additionally checks its approved tag pattern, the exact `v<version>` tag and default-branch ancestry. Release submissions require GitHub Actions OIDC proof for that source run. Grant the source job `id-token: write`; the CLI obtains a fresh identity with the Gateway origin as its audience. A caller integrating the client directly supplies `sourceIdentity`, or sets `GITEDGE_SOURCE_IDENTITY` for the CLI. Identity tokens are never part of the stored request.

Use the signing profile panel to approve a profile and install platform credential JSON. GitHub source-read credentials use purpose `github-source` and JSON `{ "token": "..." }`. Windows platform credentials must be exactly `{ "tenant_id": "...", "client_id": "...", "client_secret": "..." }`; the broker does not use a preconfigured managed or workload identity. The service encrypts credentials at rest and grants them per authorized task. Credential writes and removal require recent human authentication. The panel exposes configuration metadata, never stored secret values.

## Submit from a workflow

Use an exact-Runner-repository token with `repo:write` to submit and `repo:read` to poll/download, or a job credential bound to that Runner repository. A normal project's job credential cannot submit on behalf of the account Runner. Profile approval, credential installation and removal require a human browser session.

The request file contains source proof and a profile name:

```json
{
  "profile": "application-macos",
  "platform": "macos",
  "sourceRepositoryId": "123456",
  "sourceRunId": "234567",
  "sourceArtifactId": "345678",
  "sourceCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "sourceDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sourceSize": 123456,
  "version": "1.0.0"
}
```

The digest and size describe the complete GitHub Actions artifact ZIP downloaded by the service, including its metadata and template files. They do not describe an inner TAR, IPA or DMG. Use actual run/artifact metadata and a repeatable idempotency key for the same submission.

Set `GITEDGE_SIGNING_TOKEN` through the workflow's secret store, then run:

```sh
node scripts/signing/request.mjs submit \
  --origin https://forge.example.com \
  --repository RUNNER_REPOSITORY_UUID \
  --input signing-request.json \
  --idempotency-key build-artifact-request-001

node scripts/signing/request.mjs wait \
  --origin https://forge.example.com \
  --repository RUNNER_REPOSITORY_UUID \
  --request SIGNING_REQUEST_UUID \
  --timeout-minutes 60 \
  --output signed-output.zip
```

The client prints the request as JSON. Download validates the declared size and whole-archive SHA-256 before publishing the output file. The returned ZIP contains the platform output and its verification report. Verify each report's file digest when importing individual files into a release.

A failed stage can be retried from its run in the Actions UI or with the same request and failed run IDs:

```sh
node scripts/signing/request.mjs retry \
  --origin https://forge.example.com \
  --repository RUNNER_REPOSITORY_UUID \
  --request SIGNING_REQUEST_UUID \
  --run FAILED_RUN_UUID
```

Retry preserves the admitted source, request ID, previous successful stages and other platforms. It creates a fresh run and lease for only the failed stage after rechecking the original profile, source, retained input and notarization when applicable. Repeat the same command after an interrupted request to recover its reserved run. Expired requests, cancelled stages and revoked profiles cannot be retried. The release workflow can keep its original request IDs and publish after all required outputs are ready.

## Publish after signing

A `policy.sourceRepositories[]` entry may declare a `publish` block. When a request for that source repository reaches `succeeded` (intermediate macOS stages do not count), GitEdge dispatches one GitHub `workflow_dispatch` event on it:

```yaml
policy:
  sourceRepositories:
    - id: "123456789"
      fullName: example-org/example-app
      # workflowPath, artifactName, actorIds, events, refs ...
      publish:
        workflow: publish-shell.yml # file name under .github/workflows of that repository
        ref: main # branch or tag to dispatch on
        inputs: # optional: GitHub input name -> template
          build_run_id: sourceRunId
          commit: sourceCommitOid
```

Input values are never free text. Each is one of the fixed templates `sourceRunId`, `sourceCommitOid`, `version` or `requestId`, resolved from the submission. `publish` is part of `policy`, so adding or changing it changes the policy digest and revision: the owner must approve the profile again before it takes effect. A source repository without `publish` triggers nothing.

The dispatch uses the GitHub sync connection of the signing owner whose GitHub repository ID equals the entry's `id` and whose `owner/name` equals `fullName` (case-insensitive), and for whose GitEdge repository the owner is an administrator. The request path uses the connection's stored owner and name. Its token needs Actions read and write permission on that repository. Without an enabled connection, or with a missing permission, the dispatch fails and the signing result is unaffected.

The Actions Worker records an outbox row per request (`actions_signing_publish_dispatches`: `pending`, `dispatched` or `failed`) when signing succeeds and attempts it immediately in the background. Retryable failures (network, 5xx, 429) are retried by the minute cron up to 6 attempts with a delay that starts at one minute and doubles. Permanent failures set `failed` at once; `last_error` holds the error code:

| Code                          | Cause                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `github_connection_not_found` | No enabled connection of the signing owner (with repository admin access) matches the ID and name        |
| `github_dispatch_forbidden`   | GitHub answered 403: the token lacks Actions read and write permission                                   |
| `github_dispatch_not_found`   | GitHub answered 404: the token lacks Actions write permission, or the workflow file is absent on the ref |
| `github_dispatch_rejected`    | GitHub answered 422: unknown ref, workflow without `workflow_dispatch`, or an input it does not accept   |
| `github_dispatch_redirected`  | GitHub answered 3xx: the repository was renamed or moved; update the connection and the profile          |

Network errors, 5xx and 429 (`github_dispatch_unavailable`, `forge_unreachable`) are retried.

Delivery is at least once. A dispatch GitHub accepted can still be recorded as failed (for example when the response is lost), and a retry then dispatches again, so duplicates are possible. Declare an input mapped to `requestId` and use it in the workflow for deduplication or a `concurrency` group so a repeated dispatch does not publish twice.

## HTTP endpoints

All paths below are under `/api/actions` on the Gateway. Pass the private Runner's `repositoryId` query parameter.

| Method | Path                                  | Purpose                                                     |
| ------ | ------------------------------------- | ----------------------------------------------------------- |
| GET    | `/signing/profiles`                   | Read approved profile metadata                              |
| POST   | `/signing/profiles`                   | Approve `{ "name": "profile-name" }` from Runner            |
| GET    | `/signing/profiles/:name/credentials` | Read credential configuration metadata                      |
| POST   | `/signing/profiles/:name/credentials` | Install `{ "platform": "macos", "credentials": { ... } }`   |
| DELETE | `/signing/profiles/:name/credentials` | Remove credentials for `{ "platform": "macos" }`            |
| POST   | `/signing/requests`                   | Submit source proof with `Idempotency-Key`                  |
| GET    | `/signing/requests/:id`               | Read request state                                          |
| POST   | `/signing/requests/:id/retry`         | Retry the failed stage with `{ "runId": "FAILED_RUN_UUID" } |
| GET    | `/signing/requests/:id/download`      | Download verified final output                              |

Runner callbacks require the registered runner credential and matching native run lease. Signing profile approval and the task/lease authorization govern signing and credential access. Account-runner capacity, cancellation, history and repository admission limits apply to signing stages.

Signing requests have a six-day deadline. The dedicated signing artifact bucket retains source and output objects for seven days and aborts unfinished multipart uploads after one day. Request metadata remains in history; expired downloads return 410. Import verified outputs into release storage before their retention period ends.
