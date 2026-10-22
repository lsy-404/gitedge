# Findings

- `AccessTokenSettings` currently loads `api.repositories()` only. The account-runner repository has a separate owner-only `api.accountRunner()` endpoint and is absent from the regular repository list.
- The token creation contract already accepts selected repository IDs; only the owner-facing list is incomplete.
- The Forge GET endpoint returns `{ repository: null }` when no account Runner exists and does not provision on GET, so the picker can read it without creating state. The UI appends that repository only when its ID is not already listed.
- The focused picker test passes inclusion, duplicate suppression and no-create assertions. The full affected settings suite also contains an unrelated existing route assertion failure when its final session test attempts to navigate to `/login` under the linked dependency tree.
