# Per-account Runner repository

For provisioning, service configuration and cron operation, see [runner-services.md](runner-services.md).

## Decision

Each account gets one GitEdge-owned special repository named **Runner** at the canonical path `<personal-namespace>/runner`. It is private and owned by the account's personal namespace. The stable identity is the account `users.id`, personal `namespaces.id`, and the special `repositories.id`; usernames and namespace slugs are presentation and routing values that can change.

The repository is the Git source for account-owned workflows. It is not an executor identity or a credential. Users may edit and commit workflow files using the existing Git interface. Ordinary CI and approved signing definitions can coexist in this repository, but ordinary workflow execution never inherits signing trust. Workflows already present in other account repositories remain in place and continue running there. There is no shared global Runner repository and no collaboration grant by default.

## Repository invariants and lifecycle

Add a nullable repository kind such as `system_kind='account_runner'`, with a partial unique index allowing at most one per personal namespace. Enforce that the kind is only valid in a personal namespace and that its creator matches that namespace's account owner. The row always has canonical slug `runner` and private visibility. Provisioning is idempotent and owned by Forge so the repository row, Git storage, and normal repository services are created together.

The special repository remains absent from public profile and anonymous repository views. Human access belongs only to its owner; owner-delegated agent/job credentials must also satisfy their explicit repository scope. Namespace members, repository collaborators, and other repository admins do not gain access. Reject collaborator grants and organization transfers. Ordinary repository rename, visibility, archive, settings, fork, and individual deletion operations must reject this repository. Account username changes update the personal namespace slug while preserving the stable IDs and repository contents. Account deletion follows the existing personal-repository deletion and purge lifecycle and revokes runner and signing profiles.

Users retain normal Git content operations, branch management, commits, and workflow editing. They may not rename the repository or change its namespace, visibility, ownership, or execution trust by editing repository settings. Normal personal repositories named `runner` are rejected; this reservation is scoped to personal namespaces.

### Existing `runner` path collisions

Never convert, overwrite, delete, or take ownership of an existing repository. If the personal namespace has a live repository at `runner`, or `repository_paths` maps that path to another repository, provisioning fails with an actionable conflict. GitEdge's path table intentionally retains old slugs after rename, so renaming alone may not free the path. The owner must rename the existing repository and explicitly release only its old `runner` route before provisioning can proceed; repository data and history remain intact. The release must be an explicit owner-authorized operation and must verify the route still belongs to the renamed repository. Do not add a compatibility migration or silently steal the alias.

## Workflow source and execution identity

The initial slice runs workflows stored in Runner itself. Discover `.github/workflows/` in Runner and support push plus manual dispatch, matching the existing runner broker trigger capabilities. These are ordinary same-repository Actions jobs: Runner and its commit are the workflow source and default checkout/check target, and the existing single-repository job token remains sufficient. Do not automatically discover workflows from, fan out to, or replace workflows in the account's other repositories; those projects continue to run their existing CI in place.

A workflow may use another repository only through an explicit, owner-authorized source declaration. The authorization binds the exact source repository and permitted ref/event or immutable commit, and the run records both the Runner workflow repository/commit and declared source repository/commit. A cross-repository task receives a short-lived, lease-bound credential scoped to the exact repositories and read/write operations declared for that task; it is revoked on completion, cancellation, or lease expiry. No namespace-wide token or personal access token is used. Ordinary same-repository jobs keep their single-repository token. Writes to another repository require separate explicit authorization and are unavailable to signing tasks.

## Signing trust boundary

Signing definitions live outside ordinary Actions discovery, for example `.gitedge/signing/<profile>.yml`; they are never executable as a generic workflow trigger. The account owner may edit ordinary CI freely. A signing profile is separately authorized by GitEdge signing policy and binds the account, Runner repository ID, exact definition path and immutable workflow commit OID, permitted source/product policy, and allowed signing operation/output. Signing input is a validated source archive with verifiable provenance; the signing job does not execute workflow code from an untrusted source repository.

Changing a trusted definition does not silently update trust. A changed workflow OID requires explicit authorization of the new profile revision before it can sign. Repository privacy, workflow content, runner labels, and user-supplied dispatch inputs cannot grant signing permission.

Signing work runs only on a server-selected trusted-signing execution profile/pool, distinct from ordinary CI. The account's dedicated Mac, Windows, or iOS runner executes the signing tools. The execution class is authoritative server-side queue/runner metadata; labels are scheduling hints and cannot select or impersonate it. Ordinary CI receives no signing credentials. For an authorized signing job, the trusted process may obtain only the materials required for that operation for a short period, place them in a temporary keychain or file as required by platform tools, and remove them during cleanup. The design accounts for host-side keychain use; it does not claim that Apple signing material never reaches the runner host. GitEdge orchestrates policy and job lifecycle, while the trusted account runner performs signing; there is no separate external signing service holding or using the account key.

Signing must use a dedicated host/VM or a demonstrated OS security boundary that ordinary CI cannot read or elevate into. A second broker profile under the same OS user does not isolate credentials: current jobs share the broker's service identity and can read files accessible to that identity. Existing ordinary localmac/localwin registrations therefore do not establish signing readiness.

The signing operation is bound to GitEdge's native job/run/lease identity and validated source-run proof. GitHub OIDC and GitHub run IDs are not the execution or callback identity. The current broker lacks a signing-profile-aware enqueue path and trusted-runner material delivery/cleanup contract; those are required GitEdge execution interfaces.

## Minimum implementation changes

| Area                  | Required change                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database              | Add the repository kind, namespace uniqueness and ownership invariants; record workflow/source repository and commit separately only for cross-repository tasks. These are ordinary forward schema changes deployed with the feature; no compatibility layer or data migration is proposed.                            |
| Forge/repository APIs | Idempotently provision Runner; detect live and retained-path conflicts; reserve the personal slug; enforce private/locked identity on REST, Git and other repository mutation routes; block fork, transfer, collaboration and individual deletion.                                                                     |
| Authorization         | Make special-repository access owner-only in the shared repository-role resolver and apply it consistently to Git, API, workflow listing and runner overview.                                                                                                                                                          |
| Actions/Auth          | Run Runner's own push/manual workflows without changing existing project workflows or same-repository token scope. Add explicit cross-repository source declarations, provenance for both immutable repository/commit identities, and auditable lease-bound tokens restricted to declared repositories and operations. |
| Runner broker         | Select ordinary versus trusted-signing execution class from server-side authorization; deliver only operation-specific short-lived signing materials to the trusted account runner and require cleanup; reject workflow/label attempts to request the trusted class.                                                   |
| Signing policy        | Authorize immutable profile revisions and validated source archives; bind signing requests/results to native GitEdge job/run/lease proof. The dedicated account runner performs signing with platform tools; ordinary jobs cannot receive its signing materials.                                                       |
| Account UI            | Expose an owner-only Runner repository link/editor separately from runner instance, queue and execution status.                                                                                                                                                                                                        |

## Acceptance

- First use creates exactly one private Runner in the account's personal namespace; repeated requests return the same repository.
- Existing live or retained `runner` routes fail closed with an actionable message; no repository is converted, deleted, or silently displaced.
- Repository identity, visibility, namespace, collaboration, fork, transfer and individual deletion remain locked through every supported API and Git path; owner content edits work.
- Username change preserves repository identity. Account deletion revokes execution/signing authority and uses the established account repository purge path.
- Runner push and manual runs use Runner's own workflow source; unrelated project workflows continue unchanged in their original repositories.
- Same-repository jobs keep a single-repository token. A cross-repository task requires explicit owner authorization, records both immutable repository/commit identities, and receives only the declared auditable scope; signing consumes a validated source archive without running untrusted source workflows.
- Ordinary workflows cannot invoke signing definitions or obtain signing materials by changing YAML, labels, or inputs. Only an authorized immutable profile on the trusted execution class can request signing; the dedicated account runner executes signing tools, uses necessary materials temporarily, cleans them, and profile revision changes require reauthorization.
- Runner repository discovery and execution status are visible only to its account owner; no global shared repository or implicit cross-account collaboration exists.
