# 调研发现

- `src/worker/common/repositories.ts` 的 repositoryRole 原先直接合并 namespace owner/member 与 repository_collaborators admin/write/read；特殊仓库现以 personal namespace `created_by` 为唯一 human owner。
- `resolveRepositoryPath` 现在返回可选 `systemKind`，Git 和 Forge 的常规授权经共享 resolver；owner-delegated agent/session/job 仍必须匹配具体 repository ID、session/job/token scopes。
- `workers/auth/src/access-tokens.ts` 的 token 仓库范围签发与返回此前独立依赖 namespace/collaborator SQL；现 Runner 只允许该 personal namespace owner。`workers/auth/src/agents.ts` active-session 查询也曾绕过 resolver，现只接受 account owner 的 session。
- `workers/actions/src/runner-overview.ts` 对 runner、排队/执行历史、GitHub runner 连接的列表查询曾直接接受 namespace owner/collaborator admin；现特殊仓库必须匹配 namespace creator，其余仓库权限保持既有条件。
- Forge Dashboard/notification SQL 与平台管理员仓库搜索存在独立枚举路径，现将 Runner 限定为其 creator，并对平台 repository list 隐藏。
- controls 阻止 Runner collaboration/invitations 和 metadata mutations；lifecycle 阻止 individual delete/transfer；fork/GitHub sync 拒绝 Runner；import/create 阻止 personal `runner` 路径，包括旧别名仍占用路径时由 existing path conflict 拒绝。
- 不应改 `workers/forge/src/index.ts`、`workers/forge/src/common.ts`、contracts/forge.ts 或 migration 0048；这些由 core 提交维护。Index 需直接读/按名字读做 account owner 检查，列表隐藏 `system_kind='account_runner'`，settings 和 rename 身份修改返回明确 409，normal personal name `runner` 拒绝；旧 live repo/retained alias provisioning fail-closed。
- Worker 开发文档已按技能要求检索 Cloudflare 官方 best-practices 页面；本变更不引入平台 API/配置。
- Migration review 发现 repositories UPDATE trigger 原本只验证新 namespace/creator 组成合法 owner pair，未比较 OLD identity；可将既有 Runner 原子迁移给另一个合法账号。现 trigger 明确禁止 namespace_id 或 created_by 改变，并以 Worker D1 测试覆盖组合变更与单独 creator 变更。
