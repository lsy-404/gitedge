# 实施计划

- [x] 盘点真实 repository resolver、列表/direct-read、Git 与 Forge 生命周期路径，并确认 core/index 交界。
- [x] 在共享 repository-role resolver 中加入 account_runner 的 owner-only 人类权限，保留 owner delegated exact repository scope。
- [x] 在实际可达的 Forge 控制、lifecycle、fork/import/invitation/profile/GitHub-sync 及 Auth/Git/Actions 绕过点拒绝身份变更和越权读取；保留正常内容写入。
- [x] 在 /test 添加 owner/member/collaborator/admin token 与 normal repo 正反例。
- [ ] 集成 core schema/index commit 并执行相关 Worker 测试与类型检查。
- [ ] 检查 diff 约束并提交本地分支。
