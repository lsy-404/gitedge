# 调研记录

- 基线为 `codex/profile-sync-delivery`，提交 `caac5e4`。
- GitHub 与 GitEdge 的 refs 由签名 webhook 加持久 job 驱动；Git worker 在写入时重新读取 source/destination，并通过原生 Git 非强制更新与精确 ref 前置条件避免覆盖。
- 缺陷：ref bootstrap 只比较当前状态。它无条件将本地单边 ref 推向 GitHub、将远端单边 ref 拉入 GitEdge；共同 ref 不同则同时排入两侧。常规 push webhook 丢失或暂停期间发生删除后，reconcile 会将删除误判为新建并复活 ref；未知共同历史还会依 job 顺序尝试修改两侧。
- 修复：利用成功 `push` job 中的 after OID 作为共同基线；初次相同 refs 通过无操作 push job 记录基线；仅一侧离开基线时单向同步，另一侧同时离开时记录 `ref_conflict`。重试会重新读取 refs 和基线；删除方向携带基线 OID，Git worker 据此验证对侧 ref 未变化。
- 传输竞态：transfer worker 原先只用读取时的目标 OID作为 Git CAS 值，未校验排队时的共同基线。现在非空 `before` 在目标已等于目标值的幂等短路后与最新目标值比较；已知不存在的新 ref 使用全零 OID，目标在排队后出现则报 `sync_ref_conflict`。PR 专用 transfer 的 `before:null` 仍表示没有普通 ref 基线。
- PR 映射：远端 `refs/heads/gitedge/pr/<number>` 是 PR head 映射而非普通同名分支，普通 ref reconcile 排除该命名空间，避免将它作为额外 branch 导入/导出。
- 持久性：purge 保留每个连接/ref 最新成功 push job，其他完成 job 仍按既定 30 天窗口清理。真实 D1 Worker 回归覆盖初始相等基线、远端删除、本地删除、本地新建、并发变化和历史保留。
- 误报排除：reviewer 初始报告称 issue_comment deleted 未处理；核对 `inboundComment` 后确认该事件已有并发检查、D1 事务删除、墓碑和重复事件短路，本次不改动。
- 测试问题：purge SQL 初稿运行时 D1 报 `near LIMIT: syntax error`；重写为多行子查询后集成测试通过。
- PowerShell 在 `New-Item -Path` 上将任务目录名中的 `[]` 解释为通配符；改用 .NET `Directory.CreateDirectory` 创建要求的审计目录。
- Cloudflare 官方 Workers best-practices 页面已检索；最新 `@cloudflare/workers-types` 版本为 `5.20261023.1`。本次未改变平台 API 或 bindings，仅使用现有 D1 能力。
