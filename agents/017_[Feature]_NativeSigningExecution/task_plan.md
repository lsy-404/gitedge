# 实施计划

- [x] 合并父 checkpoint 并确认 cron 对共享 queue API 的改动。
- [x] 锁定 signing Worker 与 Actions Runner 的入队、claim 和 trusted machine context 契约。
- [x] 添加 Runner registration execution class、owner recent-auth 专用 host 批准/撤销与 migration 0051。
- [x] 将 signing requests 绑定表接入普通 Runner scheduling，严格隔离两种 execution class 并原子 claim。
- [x] 增加 signing-only machine route，按 token、registration、数据库 lease 和审批上下文验证后调用 signing DO。
- [x] 更新 Runner broker 处理普通/签名响应与签名专用执行路径，拒绝标签自选 class 和普通工作流冒充签名。
- [x] 在 `/test` 覆盖 owner/outsider/label spoof/错误 class/错误 repo/platform/过期 lease/撤销/普通 queue 正例。
- [x] 运行相关 Worker tests、类型检查与 broker checks，审查差异并本地提交。
