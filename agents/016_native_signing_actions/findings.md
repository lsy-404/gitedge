# Findings

- Mature signer separates user-facing admission/request state from native runner execution and validates immutable policy snapshots, source-run provenance, generation/nonce/lease identity, explicit sign authorization, multipart artifact integrity, and platform verification.
- Mature implementation also contains legacy GitHub artifact executors and hardcoded project owner configuration. Neither is suitable for the Actions migration.
- Actions already stores native `actions_runs` / `actions_runner_runs` with self-hosted runner lease/token enforcement. Generic R2 artifacts are capped at 24 MiB, so signing needs a dedicated multipart object path.
- The account Runner repository is private and uniquely identified by `system_kind='account_runner'`; signing scope must include both its repository ID and the owning user ID.
- Worker routing/config and runner lifecycle are explicitly owned by the parent/other agent; this module must expose a narrow integration API and avoid editing those files.

- Durable Objects must not access R2. The coordinator now handles only its SQLite upload plan and verified metadata; the Worker performs streaming multipart operations.
- Workers exposes streaming SHA-256 as `crypto.DigestStream`, not a global `DigestStream`; the official Cloudflare Crypto declaration supplies the type missing from the DOM `Crypto` interface.
- Profile YAML/workflow reads use the Git service's canonical `GitFileSchema`; Forge has no file-read route.
- A release source's OIDC identity must be issued while its workflow run is active; successful completed default-branch builds remain admissible with API-verified run/artifact state.
