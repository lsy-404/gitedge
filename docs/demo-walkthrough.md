# GitEdge demonstration walkthrough

Target runtime: about six minutes at a natural pace. The scene notes are production cues; the narration is the spoken text.

## Scene 1 — A forge for people and agents

GitEdge is an MIT-licensed Git forge built on Cloudflare Workers and Artifacts. It brings repository browsing and native Git together with pull requests, issues, tasks, reviews, and checks. This walkthrough follows two live agent sessions working at the same time, then shows how a person reviews and merges the result. The interface is the entry point; services behind it enforce the repository boundaries.

## Scene 2 — The Gateway is the public boundary

Every public application request enters through the Gateway. It serves the Vue interface, applies request checks and rate limits, then routes work to the owning service. Auth manages identities, credentials, and sessions. Forge stores collaboration records. Git uses Artifacts for repository objects and refs. An agent credential is checked against its current session and repository before privileged work proceeds. The service checks determine what the credential can actually do.

## Scene 3 — Two sessions, two workspaces

Here are two active sessions for the same repository, running at the same time. Each has its own identifier and Artifacts fork from the selected base branch. One agent can work while the other makes separate changes. A branch created in one fork does not appear in the other workspace. The session record shows its repository, permission, base ref, and expiry. The two rows make the separation visible even though both sessions contribute to the same project. During creation, GitEdge revokes the fork's initial token before issuing scoped credentials, so setup access does not outlive the session boundary.

## Scene 4 — Credentials carry a narrow scope

Each session receives an API token and Git credential tied to that session and repository. The API identity is checked against the session, repository, expiry, and agent status; Git access follows the session's read or write permission. Credentials are shown once, while GitEdge stores hashes and can revoke the session. An agent can use ordinary Git operations without receiving a general account credential. The owner can inspect expiry and revoke an active session from the account controls. If the session expires, requests are refused and the Git token is revoked.

## Scene 5 — A pull request publishes one selected head

When ready, an agent opens a pull request from its session workspace. The request records the supplying session and branch. The server requires an active session belonging to the same user and repository. The selected head becomes visible for review through that pull request; other branches inside the fork are not implicitly published. Reviewers inspect the changes in the usual diff and discussion flow, while the session keeps its own workspace. This gives maintainers a deliberate publication step between private work and shared review. The source is explicit in pull request metadata, not inferred from a branch name or display label.

## Scene 6 — Reviews and checks follow the exact commit

A review is attached to the full commit identifier the reviewer inspected. If the branch moves, the earlier review stays in history but no longer approves the current head. Checks follow the same rule: only results for the current head can satisfy required status checks. GitEdge displays the current head and merge requirements together, so reviewers can distinguish completed requirements from pending ones. Before updating the target branch, Git checks the expected base and head again, catching refs that changed during review.

## Scene 7 — Independent approval has a concrete meaning

Repositories can require independent human approval. GitEdge excludes the pull request author, agent session owner, linked task requester, and verified last pusher of the current head. If it cannot verify who pushed that head, the approval requirement stays blocked until a new commit is pushed. The merge panel shows the remaining approval count and exclusions. This rule applies to human identities even when the proposed change was produced by an agent. Independence is tied to recorded identities, and a new push returns the changed code to review.

## Scene 8 — Conflicts stop the merge cleanly

Before merging, GitEdge checks the current base and head and lets Git perform the merge. If refs changed or files conflict, the target branch does not advance. Resolve a text conflict in the session repository, push the updated head, and request review on that commit. Earlier records stay visible, but the new head needs its own review and checks. The pull request and its discussion remain available during recovery, so context is not lost when a merge attempt is blocked. Expected-commit checks also protect against competing updates to the target branch.

## Scene 9 — Tasks and MCP keep the same context

Tasks connect work to acceptance criteria, an owner, and a pull request. Agents claim tasks with a time-limited lease and renew it with heartbeats; marking work done requires acceptance. External clients can use GitEdge's stateless MCP endpoint to read repository information or submit a review. MCP accepts a Bearer token, drops browser cookies, and routes tool calls through the Gateway and REST API. The caller's scopes, repository allowlist, session limits, and rate limits still apply. Reviews must name the current head commit, just like browser reviews. Git transport, API, and MCP all follow the same repository boundaries, so a different client does not gain a separate authorization path.

## Closing

GitEdge gives people and agents a shared Git workflow while keeping sessions isolated and decisions attached to the commits they cover. Two sessions can work concurrently, publish selected heads, and move through checks, independent approval, and conflict-aware merging. It is a collaboration flow built on Workers and Artifacts, with the Gateway as public boundary and repository state as the source of truth.
