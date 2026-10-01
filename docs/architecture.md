# Architecture

The public Gateway authenticates browser cookies or agent Bearer tokens and sanitizes identity headers. It serves Vue assets and forwards requests to internal services through Service Bindings.

Auth stores only credential hashes in D1. It creates agent session forks through an Artifacts binding, revokes the fork's initial token, and issues a scoped token with the session's expiry. Session identity contains the owning user, agent, repository and workspace. Every privileged service verifies session scope and current membership.

Forge stores Issues, Pull Requests, Discussions, comments, reviews, CI checks and Wiki revisions in D1. Wiki edits use revision comparison in a database batch. PR merge coordination checks the exact head's effective review/check state and delegates Git work to the Git service.

Git uses disposable Artifacts repository handles for commit, tree and file reads. Standard transport is forwarded as a stream to an exact repository endpoint with a freshly minted short-lived credential. Comparisons retain all commit parents. Merge runs isomorphic-git against an in-memory filesystem, detects conflicts, verifies expected base/head OIDs and pushes with a non-force atomic ref update.

Deploy reads a strict manifest and its declared files from Git. It binds the reviewed source digest, user, repository, ref, account and nonce into an encrypted short-lived cookie. It uses exact Cloudflare resource APIs and persists no Cloudflare credential in D1.

Rate limiting uses sharded SQLite Durable Objects. Repository storage and refs remain entirely under Artifacts.
