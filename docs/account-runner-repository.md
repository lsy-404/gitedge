# Per-account Runner repository

## Decision

Each account gets one GitEdge-owned special repository named **Runner** at the canonical path `<personal-namespace>/runner`. It is private and owned by the account's personal namespace. The stable identity is the account `users.id`, personal `namespaces.id`, and the special `repositories.id`; usernames and namespace slugs are presentation and routing values that can change.

The repository is the Git source for account workflows. It is not an executor identity or a credential. Users may edit and commit workflow files using the existing Git interface. Ordinary personal CI and approved signing definitions can coexist in this repository, but ordinary workflow execution never inherits signing trust. There is no shared global Runner repository and no collaboration grant by default.

## Repository invariants and lifecycle

Add a nullable repository kind such as `system_kind='account_runner'`, with a partial unique index allowing at most one per personal namespace. Enforce that the kind is only valid in a personal namespace and that its creator matches that namespace's account owner. The row always has canonical slug `runner` and private visibility. Provisioning is idempotent and owned by Forge so the repository row, Git storage, and normal repository services are created together.

The special repository remains absent from public profile and anonymous repository views. Private-repository authorization must resolve its owner as the sole principal: namespace members, repository collaborators, and other repository admins do not gain access. Reject collaborator grants and organization transfers. Ordinary repository rename, visibility, archive, settings, fork, and individual deletion operations must reject this repository. Account username changes update the personal namespace slug while preserving the stable IDs and repository contents. Account deletion follows the existing personal-repository deletion and purge lifecycle and revokes runner and signing profiles.

Users retain normal Git content operations, branch management, commits, and workflow editing. They may not rename the repository or change its namespace, visibility, ownership, or execution trust by editing repository settings. Normal personal repositories named `runner` are rejected; this reservation is scoped to personal namespaces.

### Existing `runner` path collisions

Never convert, overwrite, delete, or take ownership of an existing repository. If the personal namespace has a live repository at `runner`, or `repository_paths` maps that path to another repository, provisioning fails with an actionable conflict. GitEdge's path table intentionally retains old slugs after rename, so renaming alone may not free the path. The owner must rename the existing repository and explicitly release only its old `runner` route before provisioning can proceed; repository data and history remain intact. The release must be an explicit owner-authorized operation and must verify the route still belongs to the renamed repository. Do not add a compatibility migration or silently steal the alias.

## Workflow source and execution identity

There are two distinct repositories in an automatically triggered personal workflow:

| Role | Identity and meaning |
| --- | --- |
| Source repository | The personal repository receiving the event; its commit OID is the checkout and check/result target. |
| Workflow repository | The account's Runner repository; its exact commit OID supplies the workflow definition executed for that event. |

Keep `actions_runs.repository_id` and `commit_oid` as the event/source identity. Record `workflow_repository_id` and `workflow_commit_oid` separately, along with the workflow path. Manual dispatch uses the selected Runner commit and records its identity the same way. This makes a run reproducible and prevents Runner's workflow commit from being mistaken for the source commit.

For the initial slice, discover ordinary personal workflows from `.github/workflows/` in Runner and support push plus manual dispatch, matching the existing runner broker trigger capabilities. A source repository must have Actions enabled. Exclude Runner itself to avoid recursive dispatch; do not dispatch organization repositories or external fork events by default. The check, event, checkout, and output remain attached to the source repository.

The job receives a short-lived, lease-bound, read-only credential scoped exactly to the workflow repository and source repository. The token is revoked on completion, cancellation, or lease expiry. No namespace-wide token or personal access token is used. Source-repository writes require a separate explicit source-repository authorization and are unavailable to signing jobs. Current action job tokens are scoped to one repository, so exact two-repository read scope is a required Actions/Auth change.

## Signing trust boundary

Signing definitions live outside ordinary Actions discovery, for example `.gitedge/signing/<profile>.yml`; they are never executable as a generic workflow trigger. The account owner may edit ordinary CI freely. A signing profile is separately authorized by the signing service and binds the account, Runner repository ID, exact definition path and immutable workflow commit OID, permitted source/product policy, and allowed signing operation/output.

Changing a trusted definition does not silently update trust. A changed workflow OID requires explicit authorization of the new profile revision before it can sign. Repository privacy, workflow content, runner labels, and user-supplied dispatch inputs cannot grant signing permission.

Signing work runs only on a server-selected trusted-signing execution profile/pool, distinct from the ordinary account runner pool. The execution class is authoritative server-side queue/runner metadata; labels are scheduling hints and cannot select or impersonate it. The signing private key is never injected into a workflow runner. The runner produces the unsigned build output; the signing service validates source-run proof and the GitEdge job/run/lease identity, performs signing with service-owned keys, and returns a result bound to that native run. GitHub OIDC and GitHub run IDs are not the execution or callback identity.

The current broker can lease native GitEdge Actions and GitHub bridge jobs, but it has no signing-profile-aware enqueue path or key-isolated native callback contract. Those are required signing-service interfaces, not reasons to grant signing secrets to ordinary Actions jobs.

## Minimum implementation changes

| Area | Required change |
| --- | --- |
| Database | Add the repository kind, namespace uniqueness and ownership invariants; add workflow-repository ID/OID to run provenance. These are ordinary forward schema changes deployed with the feature; no compatibility layer or data migration is proposed. |
| Forge/repository APIs | Idempotently provision Runner; detect live and retained-path conflicts; reserve the personal slug; enforce private/locked identity on REST, Git and other repository mutation routes; block fork, transfer, collaboration and individual deletion. |
| Authorization | Make special-repository access owner-only in the shared repository-role resolver and apply it consistently to Git, API, workflow listing and runner overview. |
| Actions/Auth | Snapshot workflows from Runner, fan out only to opted-in owned personal source repos, preserve source-run/check identity, record both immutable OIDs, and issue a short-lived read token scoped to the two exact repositories. |
| Runner broker | Select ordinary versus trusted-signing execution class from server-side authorization; reject workflow/label attempts to request the trusted class. |
| Signing service | Authorize immutable profile revisions; enqueue native GitEdge jobs and validate run/lease-bound source proof; keep signing keys service-side and return signing results tied to the native run. |
| Account UI | Expose an owner-only Runner repository link/editor separately from runner instance, queue and execution status. |

## Acceptance

- First use creates exactly one private Runner in the account's personal namespace; repeated requests return the same repository.
- Existing live or retained `runner` routes fail closed with an actionable message; no repository is converted, deleted, or silently displaced.
- Repository identity, visibility, namespace, collaboration, fork, transfer and individual deletion remain locked through every supported API and Git path; owner content edits work.
- Username change preserves repository identity. Account deletion revokes execution/signing authority and uses the established account repository purge path.
- Push and manual runs record distinct source and workflow repository/commit identities; source checks and checkout use the source commit, workflow execution uses the recorded Runner commit.
- Job credentials read only the exact two repositories, cannot write in signing mode, expire with the lease, and do not expose namespace-wide credentials.
- Ordinary workflows cannot invoke signing definitions or obtain signing keys by changing YAML, labels, or inputs. Only an authorized immutable profile on the trusted execution class can request signing, and profile revision changes require reauthorization.
- Runner repository discovery and execution status are visible only to its account owner; no global shared repository or implicit cross-account collaboration exists.
