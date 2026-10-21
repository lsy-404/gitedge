# 操作记录

- 已确认指定 worktree `codex/runner-retention` 位于 `7d5cdda`，工作区干净。
- 已阅读仓库 `AGENTS.md`、`PRODUCT.md` 和 agent-mode 技能；此任务不修改共享 `agents/tasks.md`。
# Implementation

- Added `scripts/runner-retention.mjs`: the default policy expires artifacts older than seven days and removes the oldest remaining artifacts when the combined retained total exceeds 1 GiB. It reads only known run folders and `.log` files, skips symbolic links, and verifies each deletion remains a direct child of its resolved owned root.
- Integrated broker cleanup at the beginning of each idle polling pass while holding the broker lock and the shared actions execution lock. This serializes pruning against both broker execution and direct actions CLI runs.
- Integrated direct actions CLI cleanup after it acquires its state lock. Broker-launched CLI execution shares the broker-held actions lock.
- Added Vitest coverage for expiry, total-byte trimming, unrelated files, symbolic-link boundaries, and exclusion while another process holds the execution lock.

## Validation

- `node --check` passed for all three changed MJS files.
- `git diff --check` passed.
- A standalone Node behavior check passed for expiry, byte trimming, and symlink targets.
- The initial Vitest attempt preceded dependency setup; after the dependency junction became available, the targeted suite passed with 4 tests.

## 最终验证与交付

- 针对性 Vitest：1 个测试文件、4 项通过。
- Prettier 检查、三份 MJS 语法检查和 `git diff --check` 均通过。
- 仅提交本地 `codex/runner-retention` 分支；不合并或推送。
