# Findings

- The source profile endpoint returns `users.created_at` directly. Existing registration/account code stores millisecond timestamps; the public UI must format those as milliseconds, not multiply by 1000. The final profile response and UI now use milliseconds correctly.
- HTTP smoke passed against `http://127.0.0.1:8977` using the generated profile `verify-be11be81b3` (`http://127.0.0.1:8977/verify-be11be81b3`). It authenticated to register a disposable user, create public/private repositories, star both, create an issue in each, and update the account profile. The final profile GET was anonymous.
- Verified the anonymous response includes edited display name, bio, location and website; `joinedAt` is a plausible millisecond timestamp; the public repository and public star are present; the private repository, private star and private issue activity are absent; and the public issue activity is present.
- No site credential or generated password was printed or saved. The disposable profile remains available for the parent to preview.
- This smoke did not create a system repository because no cleanup-free API flow was needed to verify public/private data handling.
- `pnpm exec prettier --check` could not run because Prettier is not installed in the workspace dependencies. `node --check` and `git diff --cached --check` pass.
