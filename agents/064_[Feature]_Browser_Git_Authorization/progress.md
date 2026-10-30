# Progress

- Implemented the OAuth Worker endpoint, fixed public client, storage, short-lived access tokens and refresh rotation.
- `pnpm exec tsc --noEmit -p workers/auth/tsconfig.json`: passed.
- `pnpm run check:migrations`: passed.
- `pnpm exec vitest run --config vitest.config.ts test/account/git-oauth.worker.test.ts test/account/access-tokens.worker.test.ts`: 2 files, 24 tests passed, including concurrent refresh, scope expansion rejection, expired authorization code, disabled user, and active-limit accounting during refresh.
- GCM/browser acceptance is being performed separately by integration work.
