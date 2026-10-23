# Progress

- Tokyo ARM diagnosis: wrangler d1 execute gitedge --remote (workers/auth/wrangler.production.jsonc) SELECT only; first call 7403, retry succeeded. ARM last_seen advanced ~35s per sample, runner online. No SSH, no D1 writes, no host changes.

- AccountRunners.vue: summary moved above AccountRunnerServices with computed counts; offline runners get ConfirmButton remove (api.removeRunner -> DELETE /api/actions/runners/:id), per-runner error.
- runner-overview.ts: visibleRunners excludes revoked_at; removed unreachable "revoked" state (contract, displayState, i18n, i18n test key list). History still uses authorizedRunner.
- i18n: runnerRemove, runnerRemovePrompt, runnerRemoveError (zh-CN, en).
- test:web 416 passed; format:check pass; typecheck only fails on missing croner/jose modules (not installed in worktree); test:workers 589 passed, 5 suites fail to load for same missing croner/jose.
- Applied review fixes in AccountRunners.vue, OFFLINE_MS 60s -> 90s in runner-overview.ts
- pnpm install; typecheck pass; test 520 pass; test:workers 634 pass; test:web 416 pass; format:check pass
