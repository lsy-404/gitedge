# 操作记录

- 先运行 `git worktree list --porcelain`，确认目标 worktree 和分支未占用；在 `C:/Users/User/.codex/worktrees/gitedge/bidirectional-sync` 创建 `codex/bidirectional-sync`，从 `codex/profile-sync-delivery` 开始。
- 阅读 `AGENTS.md`、`PRODUCT.md`、`agents/project.md`、Forge/Git 同步实现、D1 migration 和现有测试。
- 修改 `workers/forge/src/github-sync-git.ts`：加入纯 ref 方向规划，按共同 OID 决定同步方向，缺少基线且双方不同或双方偏离基线时返回冲突。
- 修改 `workers/forge/src/github-sync-store.ts`：从成功 push job 读取指定 ref 的最后同步 OID。
- 修改 `workers/forge/src/github-sync.ts`：bootstrap 对相等 refs 建立 no-op 基线 job；按基线协调新增、删除和单侧变化；将双侧变化记为 `ref_conflict` 并在重试时重算；purge 保留每个 ref 最新成功 job。
- 在 `test/github/ref-sync-plan.test.ts` 覆盖新建、单侧更新、双向删除、并发变化及相同 refs。
- 在 `test/github/sync-settings.worker.test.ts` 使用实际 D1 覆盖初始相同 refs 记录、远端/本地删除方向、并发删除冲突及30天后基线保留。
- 在 `test/git/github-sync.worker.test.ts` 调用实际 Git Worker endpoint，验证新 ref 的目标在协调后出现会返回冲突。
- 执行 `pnpm exec vitest run --config vitest.unit.config.ts test/github/ref-sync-plan.test.ts`：通过，7 tests。
- 执行 `pnpm exec vitest run --config vitest.config.ts test/github/sync-settings.worker.test.ts`：通过，3 tests。Vitest 输出了共享 node_modules 中两个依赖 sourcemap 缺失提示，不影响结果。
- 执行 `pnpm exec tsc --noEmit -p workers/forge/tsconfig.json`：通过。
- 执行 `pnpm exec tsc --noEmit -p workers/git/tsconfig.json`：通过；Git Worker 与 Forge D1 测试共 5 项通过，planner 测试 7 项通过。
- 执行 `pnpm exec prettier --check` 覆盖所有改动源文件与测试：通过；`git diff --check`：通过。
- reviewer 复核未发现剩余具体问题；提交前关键词检查无违规项。
- 在 `codex/bidirectional-sync` 创建本地提交 `17ac1315e213972aadb33a7bec8147d08c695dd9`；未推送、未创建 PR，工作区干净。
