# 调研发现

- 父 checkpoint `85e9a18` 已将 cron queue schedule 参数、原子批处理与 broker 事件支持集成；本阶段在此基础上实现签名 execution class。
- `runners.ts::claim` 使用 `listRunnerCandidates`、容量/预算评估与 `claimRunnerCandidate` 原子抢占；签名必须根据服务端 binding row 与 registration execution_class 选择候选，不允许依赖 labels/body 来授权。
- 当前 machine heartbeat/complete 的身份由 registration bearer token、runId、leaseToken 与 DB lease 共同确定；签名 callback 需从 DB 组装可信身份上下文，绝不信任请求体传入的 owner/repository/profile/generation。
- Queue 与 lease 继续复用 `actions_runs`、`actions_runner_runs` 以及 slot、capacity、budget、cancel 规则；core 新增 migration 0050 `actions_signing_runs` 保存 run 到签名 request snapshot 的精确绑定。
- registration 的 `execution_class`、签名平台和批准记录由近期认证 browser human owner 创建/撤销。`dedicated_host_confirmed` 表示 owner 已核对专用 host/OS identity 的操作记录，不构成硬件证明；生产 host 尚未实测，不能报告为已隔离。
- Core 的 signing DO RPC 使用 `SIGNING_COORDINATORS`；服务端 trusted context 需包含 ownerId、runnerId、runId、leaseExpiresAt、repositoryId、workflowOid、requestId、generation、profileRevision、nonce、operatorApproved、approvedBy、approvedAt。
- Sign-only registration只领取绑定的签名任务；ordinary registration只领取常规 GitEdge/GitHub 队列，签名任务不签发 generic `ge_job` credential。签名 run 的普通 completion 不得将 signing DO 未验证的产物置为成功。
- 同一签名 request 的多阶段仍复用 repository 六次/小时 admission：初始 sign/windows_sign/ios_sign 计数一次，finalize/dmg续阶段从 admission count 排除；状态确认/lease仍独立执行。普通 Actions 的相同 admission SQL 由父级同步应用过滤。
- Broker profile 必须有显式 executionClass；老 GitEdge profile 缺字段时返回重新注册提示。Signing broker 直接运行 native signing SDK，不安装或调用官方 Runner.Listener。
- Core contract merge tightened the stored signing profile and start manifest schemas; the existing Worker callback fixture no longer matched them and failed closed. Updated the fixture to a valid Windows signing profile/manifest, preserving the production schema checks.
- Signing SDK reports output-init identity fields in its request body. Core now validates the body run ID against the Actions-created trusted context; lease token is validated at the Actions boundary and not forwarded to the coordinator.
- Broker signing heartbeat watchdog initially referenced undeclared controller/signal state. Added explicit per-run abort state and await process-tree termination before posting the trusted failure callback.
- Windows/macOS/Linux service modes have different privilege boundaries: only Linux's systemd installer accepts a target user; macOS uses a per-user GUI LaunchAgent and Windows uses Task Scheduler because the broker has no Windows service installer. Device setup docs now state those limits and require the old Mac CI profile to re-register explicitly as ordinary.
- After the latest core contract merge, callback start is passing but complete returns `signing_unavailable` in the Actions Worker integration fixture. Core is moving multipart R2 create/complete/hash into the Worker route; re-run this integration after that checkpoint before closing the task.
