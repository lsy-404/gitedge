# Account Runner signing

Signing runs use the private account Runner repository and the same generic runner registrations as other GitEdge and GitHub jobs. The Actions Worker owns profile approval, encrypted credential storage, request state and artifact storage. A runner is eligible when its reported operating system, architecture, labels and tools satisfy the signing profile and workflow requirements. No separate signing registration, dedicated-host approval or OS service identity is required. The intended deployment uses one Mac broker and two Windows brokers, all registered as generic runners.

## Runner setup

Install the broker and platform toolchain on each host, then register it with the standard `register-gitedge` command for the account Runner repository. Keep the GitEdge registration token and local runner state private. The broker stores the returned GitEdge runner credential; private keys and long-lived secrets stay encrypted on the server and never reach a runner; see [Credential flow](#credential-flow).

macOS and iOS profiles need Apple's command line tools for verification, stapling and packaging; signing itself uses a pinned `rcodesign` that the client installs. Windows profiles need the approved Microsoft signing tooling. Android profiles need a Java runtime and Android SDK build-tools on a macOS or Linux host. The broker reports its real OS, architecture and available tools so the scheduler can match requirements; custom labels do not change the host platform.

## Signing runtime

The signing scripts are part of the runner kit that every GitEdge deployment publishes (see [Runner kit and launcher](actions.md#runner-kit-and-launcher)). `scripts/signing/` and `packages/contracts/signing-native.mjs` ship in the kit, and their dependencies are pinned by the kit's lockfile in `packages/runner-kit/`. A broker running under the launcher already has the signing client of its kit installed, so a signing claim downloads nothing: the broker starts `scripts/signing/client.mjs` from its own kit directory. Signing runs are dispatched like other runs; there is no separate signing digest.

### On the runner

A runner needs Node.js 24 or newer, pnpm, network access to the GitEdge origin and the npm registry (or a warm pnpm store) for kit installation, and the platform tools below. The kit lives under `runner-kit/` in the broker state directory, which must be readable by the account that runs jobs. Before the platform step the signing client verifies Node, its dependencies and these tools, and fails with a specific reason such as `preflight_python`, `preflight_dependency` or `preflight_tool_rcodesign`. The reason and a short detail appear on the signing request.

- macOS and iOS: Python 3.12 or newer (`PYTHON` selects the interpreter, default `python3`), `codesign`, `lipo` and `ditto`; macOS also needs `plutil`, `tar`, `spctl` and `xcrun stapler`, DMG stages `hdiutil`, and iOS `security`, `openssl` and `xcrun vtool`. Signing stages (`sign`, `dmg_sign`, `ios_sign`) also need network access to `github.com` and to Apple's notarization upload bucket on S3: preflight installs `rcodesign` 0.29.0 from the apple-codesign release on GitHub, verifies the archive's SHA-256 against the digest pinned in `scripts/signing/apple-remote.mjs`, and caches it under `~/Library/Caches/gitedge` of the account that runs jobs (`$XDG_CACHE_HOME/gitedge` or `~/.cache/gitedge` on Linux). A failed download or digest reports `preflight_tool_rcodesign`. Xcode's `notarytool` and `xcodebuild` and a signing keychain are not used.
- Windows: PowerShell 7 (`pwsh`) and the approved Microsoft signing tooling.
- Android (macOS or Linux): a JDK with `javac` (`JAVA_HOME/bin/java` and `javac`, or both on `PATH`; Java 11 or newer) and Android SDK build-tools 30 or newer with `aapt2`, `zipalign` and `lib/apksigner.jar`. The newest installed build-tools under `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` (macOS) or `~/Android/Sdk` (Linux) are used, so set `ANDROID_HOME` and `JAVA_HOME` in the broker environment when jobs run as another account. Preflight reports `preflight_tool_java`, `preflight_tool_javac`, `preflight_tool_android_build_tools`, `preflight_tool_aapt2` or `preflight_tool_apksigner`.

A disposable VM installs its host's kit before every job. To speed this up, warm the pnpm store in the VM image by running `pnpm install --frozen-lockfile --prod` once in `packages/runner-kit` of a recent release and keeping the store; correctness never depends on the warm-up.

## Credential flow

Stored credentials keep their format, but the Actions Worker is the only place they are decrypted. The `authorize-sign` response (the grant) carries public material only, and every secret-dependent operation is a lease-authenticated call to the Worker:

| Platform | Grant (`credentials`)                                                                                                    | Remote operation                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Android  | `{ "chain": ["<base64 DER>", ...] }` (leaf first)                                                                        | `sign`: the Worker signs with the keystore key                                            |
| Windows  | `{ "tenant_id": "...", "client_id": "..." }`                                                                             | `azure-token`: the Worker exchanges the client secret for an Entra token                  |
| iOS      | `{ "chain": [...], "provisioning_profile": "<base64>", "extension_profiles"?: { "<extension bundle id>": "<base64>" } }` | Apple remote signing (see the Apple endpoints below)                                      |
| macOS    | `{ "chain": [...] }` (`{}` for `finalize` and `dmg_finalize`)                                                            | Apple remote signing and `notary`: the Worker signs the App Store Connect JWT and submits |

The client adds `remote` (`endpoint`, `jobToken`, `runId`, `leaseToken`) to the grant it hands to platform executors; it is the same lease credential the client uses for every other callback. Remote operations require a prior `authorize-sign` for the stage, the active lease and an unchanged approved profile. The Worker caches imported keys per isolate (keyed by owner, repository, profile revision, platform and credential update time), keeps them non-extractable, counts operations per run and kind in `actions_signing_remote_operations`, and refuses a kind after 4096 operations in one run.

Android and Apple credentials are PKCS#12 files parsed in the Worker (3DES/RC2 and PBES2 encryption, RSA and P-256/P-384 keys).

### Apple remote signing

Apple stages sign with `rcodesign sign` in its remote signing mode, with GitEdge as both the relay server and the signer:

1. The executor calls `apple-remote`. The Worker opens a session in the run's `AppleRemoteSigner` Durable Object, which generates an RSA-OAEP key pair for this session only (the private key is non-extractable and stays in memory) and returns `{ "url": "wss://<origin>/api/actions/runner/signing/apple-remote/<runId>/<token>", "publicKeyPem": "..." }`. The token is single use, because `rcodesign` cannot send authentication headers.
2. The executor runs `rcodesign sign --remote-public-key-pem-file <file> --remote-signing-url <url> ...`. `rcodesign` connects, creates a relay session and prints a session join string, which the executor posts to `apple-remote/join`.
3. The Durable Object decrypts the join string with the session key, checks that it names this relay URL and session, loads the profile's key with the Worker's credential loader and completes the key agreement. `rcodesign` then requests the certificate chain and sends each signature request over the encrypted channel; every signature is counted as an `apple-sign` operation.

Each socket upgrade, join and signature rechecks the run lease in D1, and a 30-second alarm closes the session once the lease ends, is cancelled or after one hour. Apple keys must be RSA or EC P-384: `rcodesign` 0.29 verifies every remote ECDSA signature as P-384, so a P-256 key fails with `apple_remote_signing_key_unsupported`.

macOS `sign` signs the bundle with `--for-notarization` (hardened runtime on every Mach-O, Apple timestamp). The bundle and nested `.app` bundles get the entitlements Electron's signing tool applies by default: the main bundle and plain helpers get `allow-jit` and the device and personal-information entitlements, and the `(Plugin)`, `(GPU)` and `(Renderer)` helpers get the Chromium helper sets. `dmg_sign` signs the disk image the same way. Both then zip (or take) the artifact, call `notary` with its SHA-256 and upload it to the returned S3 object with SigV4 from Node; the submission id goes into `verification.json` as before, the coordinator polls Apple and queues the `finalize` stage, and `finalize` staples with `xcrun stapler`, which needs no credentials.

`ios_sign` copies the archived app into `Payload/`, embeds the granted provisioning profile, and signs with entitlements made of the app's existing entitlements plus `application-identifier`, `com.apple.developer.team-identifier` and `get-task-allow` from the profile (no timestamp, as for development exports). The grant's leaf certificate must be the profile's development certificate. App extensions are allowed only as `.appex` bundles directly under the app's `PlugIns/`; any other nested `.app`, `.appex` or `.xpc` is rejected. Each extension needs a bundle identifier prefixed with the app's (`<app bundle id>.`), the app's version and build, and an arm64 iOS executable, and the grant's `extension_profiles` (at most 8 entries) must hold a development profile for its bundle identifier from the same team and certificate; entries for extensions not in the archive are ignored. Each extension gets its own embedded profile and entitlements built the same way, signed in the same `rcodesign` call with scoped `--entitlements-xml-file` settings, and verification repeats the profile, certificate and entitlement checks per extension. The IPA is zipped with `ditto` and verified as before.

## Approve a definition and credentials

Keep signing profiles in `.gitedge/signing/<name>.yml` within Runner. A profile pins a workflow path and commit from the same private repository, a platform, timeout and product/source policy. Approval reads that exact workflow from GitEdge and stores an immutable snapshot. Editing YAML does not authorize a new revision; approve it again explicitly.

Source policy identifies permitted GitHub repository IDs, workflow path, actor IDs, events and branch/tag names. GitHub is used to validate the source build; the workflow uploads its source archive directly to GitEdge.

Without `releaseTagPattern`, a source build must come from its repository's default branch. A release profile additionally checks its approved tag pattern, the exact `v<version>` tag and default-branch ancestry. All submissions require GitHub Actions OIDC proof for that source run. Grant the source job `id-token: write`; the CLI obtains a fresh identity with the Gateway origin as its audience. A caller integrating the client directly supplies `sourceIdentity`, or sets `GITEDGE_SOURCE_IDENTITY` for the CLI. Identity tokens are never part of the stored request.

Use the signing profile panel to approve a profile and install platform credential JSON. A single GitHub personal access token (PAT) for the account Runner repository is saved once in the Access card (Services & signing), which lists the token with its GitHub account; every signing profile in the repository uses it to read source runs, it is encrypted with AAD `<owner>:<repository>:github-source`, it also serves every GitHub sync connection the account created and its billing usage reads, and it survives profile re-approval. Windows platform credentials must be exactly `{ "tenant_id": "...", "client_id": "...", "client_secret": "..." }`. The service encrypts credentials at rest and uses them only inside the Actions Worker. Credential writes and removal require recent human authentication. The panel exposes configuration metadata, never stored secret values.

## Windows recipes

A Windows source ZIP holds `source.json` (`source_sha`, `version`, `bundle_id`, `architecture`) and an `app/` directory. The recipe in `policy.project.windows` decides what the signing host does with it:

- `installer: nsis` or `installer: squirrel` (with `product_name`, `electron_version`, `executable_name` and `portable`) signs an Electron application and builds its installer. The output is `product.exe`, plus `product-portable.exe` or the Squirrel `RELEASES` and `.nupkg` files.
- `installer: none` signs the files placed directly in `app/` and returns them under their own names. It accepts up to 64 `.exe`, `.dll`, `.node` or `.msix` files, without subdirectories. Use it for builds that package their own installer and sign each file through a sign command, such as Tauri. An MSIX package's manifest `Publisher` must equal the certificate subject.

```yaml
policy:
  project:
    windows:
      bundle_id: com.example.app
      architecture: x64
      max_unpacked_bytes: 2000000000
      installer: none
```

The signing host receives no client secret. The executor points the Artifact Signing module's managed-identity credential at the Worker through `IDENTITY_ENDPOINT` (the request's `azure-token` URL), `IDENTITY_HEADER` (the lease credential) and `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`, and excludes the environment credential. Only the `https://codesigning.azure.net` resource is served.

Both recipes verify each signature with SignTool (`/pa`, all signatures, timestamp required) and check the signer subject against `policy.azure.subject`.

## Android profiles

An Android profile signs one release APK with an upload or app-signing key kept in GitEdge. The broker reports the tools `java` and `android-build-tools` when they work on the host, or, for a VM pool, when image verification finds them in the guest (set `JAVA_HOME` and `ANDROID_HOME` in the pool's `guest.environment`), and Android signing jobs require both plus Node.js (`need-tool-node`, `need-tool-java`, `need-tool-android-build-tools`); they run on any macOS or Linux runner that reports them. Hosted fallback runners use Linux. Labels from the pinned workflow are added as usual, so a workflow pinned for Android should not require `macOS`, `ARM64` or iOS-only tools unless the Android key must stay on that host.

```json
{
  "name": "application-android",
  "platform": "android",
  "timeoutMinutes": 30,
  "enabled": true,
  "workflowPath": ".github/workflows/signing.yml",
  "workflowOid": "0123456789abcdef0123456789abcdef01234567",
  "policy": {
    "stage": "android_sign",
    "project": {
      "id": "application-android",
      "enabled": true,
      "max_artifact_bytes": 500000000,
      "android": {
        "package_name": "com.example.app",
        "certificate_sha256": "<64 lowercase hex characters>"
      }
    },
    "sourceRepositories": [ ... ]
  }
}
```

`certificate_sha256` pins the signing certificate: the SHA-256 digest of the DER certificate, as printed by `apksigner verify --print-certs` or by `keytool -list -v` without colons and in lowercase. Android policies cannot set `teamId` or `azure`.

Platform credentials are exactly `{ "keystore_p12": "<base64 PKCS12 keystore>", "store_password": "...", "key_alias": "...", "key_password": "..." }`. Passwords and the alias must be single lines.

The source ZIP holds exactly two root files: `unsigned.apk` (the unsigned release APK) and `source.json`:

```json
{
  "platform": "android",
  "package_name": "com.example.app",
  "version": "1.2.3",
  "version_code": 10203,
  "source_sha": "0123456789abcdef0123456789abcdef01234567"
}
```

The submission `version` must equal `source.json` `version` and the APK `versionName`; `version_code` must equal the APK `versionCode`; the package name must match the policy and the APK. The host checks the archive digest and layout, reads the APK with `aapt2 dump badging` (debuggable APKs are rejected), runs `zipalign -p 4`, signs with `apksigner` (APK Signature Scheme v2 and v3; v1 follows the APK's `minSdkVersion`), and verifies the result with `apksigner verify --print-certs`: exactly one signer whose certificate digest equals `certificate_sha256`. No key material reaches the host: the executor compiles `scripts/signing/android-remote/RemoteProvider.java` with `javac` into a private temporary directory and runs `apksigner` with a `GITEDGE` keystore backed by that provider, which fetches the certificate chain from `signer` and sends every signature to `sign`. Before signing, the executor checks that the grant's leaf certificate digest equals `certificate_sha256`. The provider configuration (endpoint and lease credential) is a mode-0600 file in the same directory and is removed afterwards. Signatures use SHA-1, SHA-256, SHA-384 or SHA-512 digests as `apksigner` selects for the APK. The output contains `signed.apk` and `verification.json` (`version_code`, `certificate_sha256`, `v1_verified`, `v2_verified`, `v3_verified` and the APK digest).

Failures are reported as `android_<phase>_<code>`, for example `android_source_source_binding`, `android_apk_metadata_apk_version`, `android_signature_verification_certificate_mismatch` or `android_tools_build_tools_unavailable`.

## Submit from a workflow

Use an exact-Runner-repository token with `repo:write` to submit and `repo:read` to poll/download, or a job credential bound to that Runner repository. A normal project's job credential cannot submit on behalf of the account Runner. Profile approval, credential installation and removal require a human browser session.

The request file contains source proof and a profile name:

```json
{
  "profile": "application-macos",
  "platform": "macos",
  "sourceRepositoryId": "123456",
  "sourceRunId": "234567",
  "sourceCommitOid": "0123456789abcdef0123456789abcdef01234567",
  "sourceDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "sourceSize": 123456,
  "version": "1.0.0"
}
```

The digest and size describe the complete source ZIP uploaded by the workflow. Use a repeatable idempotency key for the same submission.

Set `GITEDGE_SIGNING_TOKEN` through the workflow's secret store, then run:

```sh
node scripts/signing/request.mjs submit \
  --origin https://forge.example.com \
  --repository RUNNER_REPOSITORY_UUID \
  --input signing-request.json \
  --source source.zip \
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

The dispatch uses the GitHub sync connection of the signing owner whose GitHub repository ID equals the entry's `id` and whose `owner/name` equals `fullName` (case-insensitive), and for whose GitEdge repository the owner is an administrator. The request path uses the connection's stored owner and name. It authenticates with the account's shared GitHub token, which needs Actions read and write permission on that repository. Without an enabled connection, or with a missing permission, the dispatch fails and the signing result is unaffected.

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

| Method | Path                                       | Purpose                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/signing/profiles`                        | Read approved profile metadata                                                                                                                                                                                                                  |
| POST   | `/signing/profiles`                        | Approve `{ "name": "profile-name" }` from Runner                                                                                                                                                                                                |
| GET    | `/signing/source-credential`               | Read `{ "configured": true, "updatedAt": 1700000000000, "login": "octocat" }` for the repository (`?repositoryId=`)                                                                                                                             |
| POST   | `/signing/source-credential`               | Install the shared GitHub source-read token `{ "token": "..." }`; returns the same status. GitHub is asked for the token's account (`GET /user`): 401 is rejected with `github_token_invalid`, other failures store the token with `login` null |
| DELETE | `/signing/source-credential`               | Revoke the shared GitHub source-read token; returns the same status                                                                                                                                                                             |
| GET    | `/signing/profiles/:name/credentials`      | Read credential configuration metadata                                                                                                                                                                                                          |
| POST   | `/signing/profiles/:name/credentials`      | Install `{ "platform": "macos", "credentials": { ... } }`                                                                                                                                                                                       |
| DELETE | `/signing/profiles/:name/credentials`      | Remove credentials for `{ "platform": "macos" }`                                                                                                                                                                                                |
| POST   | `/signing/requests`                        | Submit source proof with `Idempotency-Key`                                                                                                                                                                                                      |
| GET    | `/signing/requests/:id`                    | Read request state                                                                                                                                                                                                                              |
| POST   | `/signing/requests/:id/retry`              | Retry only the failed stage with `{ "runId": "FAILED_RUN_UUID" }` or `{ "runId": null }`                                                                                                                                                        |
| PUT    | `/signing/requests/:id/source/parts/:part` | Upload an authenticated 8 MiB source part                                                                                                                                                                                                       |
| POST   | `/signing/requests/:id/source/complete`    | Verify the uploaded source and queue signing                                                                                                                                                                                                    |
| GET    | `/signing/requests?sourceRunId=...`        | Find requests for an authorized source run                                                                                                                                                                                                      |
| GET    | `/signing/requests/:id/download`           | Download verified final output                                                                                                                                                                                                                  |

The runner endpoints below are under `/api/actions/runner/signing/requests/:id/` and use the same lease authentication and `authorize-sign` precondition. Responses use the usual `{ "data": ... }` envelope, except `azure-token`, which returns the bare managed-identity JSON.

| Method | Path                   | Purpose                                                                                                                                                                                                                                                                                |
| ------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `signer`               | `{ "keyType": "rsa"\|"ec-p256"\|"ec-p384", "chain": ["<base64 DER>"] }` (Android, iOS, macOS)                                                                                                                                                                                          |
| POST   | `sign`                 | Android: `{ "data": "<base64>", "hash": "SHA-256", "format": "der" }` returns `{ "signature": "<base64>" }`; `format` is `der` (default) or `raw` for ECDSA                                                                                                                            |
| GET    | `azure-token`          | Windows, App Service managed-identity protocol: `?api-version=2019-08-01&resource=https://codesigning.azure.net`, header `X-IDENTITY-HEADER: <jobToken>.<runId>.<leaseToken>`; returns `{ access_token, expires_on, resource, token_type }` with `expires_on` as a Unix-seconds string |
| POST   | `notary`               | macOS `sign` and `dmg_sign`: `{ "sha256": "<hex>", "submissionName": "..." }` returns `{ id, region, bucket, object, awsAccessKeyId, awsSecretAccessKey, awsSessionToken }`                                                                                                            |
| GET    | `notary/:submissionId` | macOS: `{ "status": "In Progress"\|"Accepted"\|"Invalid"\|"Rejected" }`                                                                                                                                                                                                                |
| POST   | `apple-remote`         | macOS `sign` and `dmg_sign`, iOS `ios_sign`: opens a remote signing session and returns `{ "url": "wss://...", "publicKeyPem": "..." }`                                                                                                                                                |
| POST   | `apple-remote/join`    | `{ "sessionJoinString": "<base64url>" }` from `rcodesign`; returns `{ "joined": true }`                                                                                                                                                                                                |

The runner failure callback `POST /runner/signing/requests/:id/fail` accepts an optional `reason` (`^[a-z0-9_]{1,64}$`, for example `preflight_dependency` or `preflight_python`) and `detail` (up to 300 characters; control characters are replaced by spaces). The account signing list returns them beside each request as `failure: { reason, detail }`, `null` unless the request failed; the request object itself is unchanged.

Runner callbacks require the registered runner credential or the job credential, and the matching native run lease. Signing profile approval and the task/lease authorization govern signing and credential access. Account-runner capacity, cancellation, history and repository admission limits apply to signing stages.

Signing requests have a six-day deadline. Source archives and unfinished uploads expire after 24 hours. Failed execution stages retain their inputs until that original deadline so they can be retried; success, cancellation, invalid source and rejected notarization remove inputs immediately. Signed output archives also expire 24 hours after the request succeeds, or can be released immediately after publication with the output delete endpoint. Request metadata remains in history; expired downloads return 410. Import verified outputs into release storage before their retention period ends.
