# Findings

- Mature signer separates user-facing admission/request state from native runner execution and validates immutable policy snapshots, source-run provenance, generation/nonce/lease identity, explicit sign authorization, multipart artifact integrity, and platform verification.
- Mature implementation also contains legacy GitHub artifact executors and hardcoded project owner configuration. Neither is suitable for the Actions migration.
- Actions already stores native `actions_runs` / `actions_runner_runs` with self-hosted runner lease/token enforcement. Generic R2 artifacts are capped at 24 MiB, so signing needs a dedicated multipart object path.
- The account Runner repository is private and uniquely identified by `system_kind='account_runner'`; signing scope must include both its repository ID and the owning user ID.
- Worker routing/config and runner lifecycle are explicitly owned by the parent/other agent; this module must expose a narrow integration API and avoid editing those files.
