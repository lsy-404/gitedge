# 账户 Runner 核心实施计划

- [x] 确认 GET/POST contract、Forge 路由及 Artifacts/token 生命周期接口。
- [x] 添加 repository kind schema 与可选 `systemKind` contract。
- [x] 实现 owner-only 状态读取和幂等私有 Runner provision，包括 Git 初始化与明确冲突/pending 响应。
- [x] 在 Forge index 注册路由，不触碰共享 repository mutation/access 实现。
- [x] 在 `/test` 覆盖权限、并发、幂等与 slug/导入冲突。
- [x] 运行有针对性的 Worker 测试与类型检查，修复本任务引入的问题。
- [x] 提交本分支变更，不推送或合并。
