# Findings

- `pnpm run build` starts Node with `npm_execpath` available, but `scripts/deploy-stack.mjs` launched children as bare `pnpm`. Windows cannot spawn the `.cmd` shim through `spawnSync` without shell handling.
- Use `process.execPath` with the active `npm_execpath` as a distinct argument, preserving argument boundaries and avoiding shell execution. Keep the POSIX direct-Node fallback; on Windows without pnpm context, fail with an actionable message.
