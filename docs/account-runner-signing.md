# Account Runner signing

Signing runs through the private account Runner repository and dedicated signing machines. The Actions Worker owns admission, profile approval, credential grants, request state and artifact storage. A signing machine executes platform tools under its registered identity and current lease.

## Prepare a machine

Use a dedicated host, VM or OS service account that ordinary CI cannot read or impersonate. Separate labels or broker profiles do not provide that boundary. A broker service rejects a mixture of ordinary and signing profiles. Keep signing and ordinary service state directories separate.

Give the signing account access only to the signing checkout, broker state and platform tools. Keep the state directory and registration credential readable only by that OS identity. Do not run an ordinary CI broker or ordinary workflow under the signing identity. The dashboard's dedicated-host approval records the owner's review; it does not prove hardware isolation.

- **macOS:** create a separate macOS user for signing. Install and register the signing profile while logged in as that user, then install the LaunchAgent from the same account. It runs in that user's GUI session; do not install it under an ordinary CI account. Keep Apple signing credentials in the approved per-run keychain flow.
- **Windows:** create a separate local or managed OS identity and run the broker from a Task Scheduler task under that identity. `runner-broker service install` does not support Windows. Restrict the checkout, broker state and task configuration to the signing identity; verify that the selected Azure managed/workload identity is the one authorized for the signing API.
- **Linux:** use the supported systemd service with a dedicated non-root account and a private state directory owned by that account. Install with `service install --run-as-user <account>`; the installer checks the state directory ownership and mode.

Upgrade an existing Mac ordinary broker before enabling strict execution-class checks. Re-register it explicitly as ordinary with the current broker, then verify its dashboard purpose is ordinary. Do not convert an ordinary registration or OS account into a signing identity. Signing requires a separate host or OS account and a fresh signing registration approved by the account owner. A GitEdge broker profile missing its execution class must be re-registered; do not edit the profile JSON to manufacture a class.

Install Node.js 24 or newer and the repository dependencies. Install the platform runtime dependencies with:

```sh
pnpm --dir scripts/signing install --frozen-lockfile
```

macOS signing requires the Apple signing/notarization tools and a Developer ID certificate. iOS signing requires the approved Xcode toolchain, development certificate and provisioning profile. Windows signing requires the approved Azure Artifact Signing configuration and a working managed identity or workload identity; an interactive Azure CLI login does not grant signing authority.

Register a repository-scoped signing broker using `register-gitedge --signing --repository runner` and a distinct state directory. Supply the registration credential through `GITEDGE_TOKEN`, then remove it from the shell. Registration alone does not authorize signing. In **Settings → Runners**, the account owner confirms the dedicated machine and approves its signing platform with recent authentication. Revoking approval stops further signing claims and credential authorization.

## Approve a definition

Keep signing profiles in `.gitedge/signing/<name>.yml` within Runner. The profile pins a workflow path and commit from the same private repository, a platform, timeout and product/source policy. Approval reads that exact workflow from GitEdge and stores an immutable snapshot. Editing YAML does not authorize a new revision; approve it again explicitly.

Source policy identifies permitted GitHub repository IDs, workflow path, artifact name, actor IDs, events and branch/tag names. GitHub is used to validate the source build and download its archive. Signing execution does not dispatch a GitHub workflow.

Without `releaseTagPattern`, a source build must come from its repository's default branch. A release profile additionally checks its approved tag pattern, the exact `v<version>` tag and default-branch ancestry. Release submissions require GitHub Actions OIDC proof for that source run. Grant the source job `id-token: write`; the CLI obtains a fresh identity with the Gateway origin as its audience. A caller integrating the client directly supplies `sourceIdentity`, or sets `GITEDGE_SOURCE_IDENTITY` for the CLI. Identity tokens are never part of the stored request.

Use the signing profile panel to approve a profile and install platform credential JSON. Install a separate GitHub source credential for the same profile with purpose `github-source` and JSON `{ "token": "..." }`. This credential must have read access to the approved source repositories; another account's source integration is never used. Credential writes and removal require recent human authentication. The panel exposes configuration metadata, never stored secret values. Certificate material is encrypted by Actions and is issued only to the approved machine with a current request/run/lease binding. Finalization does not receive the signing certificate.

## Submit from a workflow

Use an exact-Runner-repository token with `repo:write` to submit and `repo:read` to poll/download, or a job credential bound to that Runner repository. A normal project's job credential cannot submit on behalf of the account Runner. Profile approval, credential installation and host approval require a human browser session.

The request file contains only source proof and a profile name:

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

The client prints the request as JSON. Download validates the declared size and whole-archive SHA-256 before publishing the output file. The returned ZIP contains the platform output and its verification report. Platform output names include `product.zip`, `product.dmg`, `signed.ipa` and the approved Windows installer outputs. Verify each report's file digest when importing individual files into a release.

## HTTP endpoints

All paths below are under `/api/actions` on the Gateway. Pass the private Runner's `repositoryId` query parameter.

| Method | Path                                  | Purpose                                                   |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| GET    | `/signing/profiles`                   | Read approved profile metadata                            |
| POST   | `/signing/profiles`                   | Approve `{ "name": "profile-name" }` from Runner          |
| GET    | `/signing/profiles/:name/credentials` | Read credential configuration metadata                    |
| POST   | `/signing/profiles/:name/credentials` | Install `{ "platform": "macos", "credentials": { ... } }` |
| DELETE | `/signing/profiles/:name/credentials` | Remove credentials for `{ "platform": "macos" }`          |
| POST   | `/signing/requests`                   | Submit source proof with `Idempotency-Key`                |
| GET    | `/signing/requests/:id`               | Read request state                                        |
| GET    | `/signing/requests/:id/download`      | Download verified final output                            |

Machine callbacks are separate. They require the registered runner credential and matching native run lease; caller tokens and ordinary job credentials cannot authorize them. Existing account-runner capacity, cancellation, history and repository admission limits apply to signing stages.

Signing requests have a six-day deadline. The dedicated signing artifact bucket retains source and output objects for seven days and aborts unfinished multipart uploads after one day. Request metadata remains in history; expired downloads return 410. Import verified outputs into release storage before their retention period ends.
