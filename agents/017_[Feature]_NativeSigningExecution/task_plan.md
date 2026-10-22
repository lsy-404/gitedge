# 实施计划

- [x] 合并父 checkpoint 并确认 cron 对共享 queue API 的改动。
- [x] 锁定 signing Worker 与 Actions Runner 的入队、claim 和 trusted machine context 契约。
- [x] 添加 Runner registration execution class、owner recent-auth 专用 host 批准/撤销与 migration 0051。
- [x] 将 signing requests 绑定表接入普通 Runner scheduling，严格隔离两种 execution class 并原子 claim。
- [x] 增加 signing-only machine route，按 token、registration、数据库 lease 和审批上下文验证后调用 signing DO。
- [x] 更新 Runner broker 处理普通/签名响应与签名专用执行路径，拒绝标签自选 class 和普通工作流冒充签名。
- [x] 在 `/test` 覆盖 owner/outsider/label spoof/错误 class/错误 repo/platform/过期 lease/撤销/普通 queue 正例。
- [x] 为签名阶段增加可信失败回执，保证 SDK 执行错误也结束 Actions lease。
- [x] 完成 Runner signing approval/profile/credentials UI、操作文档和独立签名 broker 注册流程。
- [x] 验证 Actions 类型检查、签名/调度测试、真实 Worker callback、UI panel 与 broker 脚本语法。
- [x] 合入 core metadata/source credential 契约并通过完整前端类型检查。
- [x] 同步 core output-init wire parser 修复及 native SDK cancellation checkpoint。
- [x] 合入 core R2 multipart route checkpoint，复跑真实 Worker callbacks/harness 并提交审计结论。
