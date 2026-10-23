# Progress

- Tokyo ARM diagnosis: wrangler d1 execute gitedge --remote (workers/auth/wrangler.production.jsonc) SELECT only; first call 7403, retry succeeded. ARM last_seen advanced ~35s per sample, runner online. No SSH, no D1 writes, no host changes.

- AccountRunners.vue: summary moved above AccountRunnerServices with computed counts; offline runners get ConfirmButton remove (api.removeRunner -> DELETE /api/actions/runners/:id), per-runner error.
- runner-overview.ts: visibleRunners excludes revoked_at; removed unreachable "revoked" state (contract, displayState, i18n, i18n test key list). History still uses authorizedRunner.
- i18n: runnerRemove, runnerRemovePrompt, runnerRemoveError (zh-CN, en).
- test:web 416 passed; format:check pass; typecheck only fails on missing croner/jose modules (not installed in worktree); test:workers 589 passed, 5 suites fail to load for same missing croner/jose.
- Applied review fixes in AccountRunners.vue, OFFLINE_MS 60s -> 90s in runner-overview.ts
- pnpm install; typecheck pass; test 520 pass; test:workers 634 pass; test:web 416 pass; format:check pass
- Pushed main a839ec5 to origin. Built web; deployed gateway version 23bf68da-3a94-45fd-8b83-b1bce5f753e9. First actions deploy failed: Docker engine not running; started colima and redeployed actions version 5a64e3c4-ad3a-49b8-89d7-7df328d51fb0 (image already present remotely). Forge was already current (deployed 08:17Z after its last change). No D1 migration in range.
- Smoke: site 200, new runner removal bundles served 200, anonymous overview 403.
