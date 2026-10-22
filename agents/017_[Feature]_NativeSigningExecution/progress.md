# 操作进度

- 2026-10-21：将父 checkpoint `85e9a18` fast-forward 合入本工作分支；包含权限阶段、Runner UI 与 cron scheduler。工作树干净。
- 2026-10-21：只读审查 Actions candidate selection、atomic lease、runner registration、machine callback 与 broker service install 路径；向 core 确认 signing DO internal API/context。
- 2026-10-21：父/core 确认采用 owner/recent-auth operator approval 模型，不引入硬件 attestation；专用 host 声明不等于已验证物理隔离。
- 2026-10-21：完成 runner execution class、owner recent-auth 批准与撤销 API、签名队列绑定和原子 claim、可信 machine callback、签名专用 broker 分流及私有 context ACL。
- 2026-10-21：验证 `typecheck:actions` 通过；runner claim/callback worker tests 6/6、signing coordinator tests 6/6、scheduler tests 9/9、signing SDK protocol tests 9/9 通过；`node --check scripts/runner-broker.mjs` 及 `--help` 通过。
- 2026-10-21：Actions 与 gateway 入口仍需父线程接入签名 callback path 和 signing bindings；当前阶段未在真实专用 host 执行签名。
- 2026-10-21：签名 Coordinator 接受 `/complete` 的 202 后，Actions 同步结束对应 stage lease 并发布检查；相同 lease 的成功 complete 可幂等重放。真实 D1 Worker 测试覆盖首次提交和重放。
- 2026-10-21：待 core 增加签名失败操作并在 Worker/broker 间闭环；父级负责 Actions/gateway 路由和 signing binding 接线。
- 2026-10-21：合入 core signing coordinator 多阶段、失败与重试状态机；`/fail` 只在当前 owner-approved lease 验证后提交，Worker 将 coordinator 回执映射到 Actions failure 并允许同 lease 幂等重放。签名 Worker 测试 6/6 通过。
- 2026-10-21：完成 Runner UI 最近认证批准/撤销组件；新增签名 profile 按名批准与分开的平台/GitHub source credential JSON 安装/撤销子面板，凭据页面只显示配置状态，不回显秘密。UI行为测试 7/7 通过；profile metadata/status 类型由 core 提供后复跑前端类型检查。
- 2026-10-21：文档补充精确 `<owner>/runner` 注册 scope、普通/签名 broker 命令、owner profile 批准和本地 JSON 凭据配置步骤。
- 2026-10-21：更新 broker 加载规则，缺少执行 class 的旧 GitEdge profile 会提示重新注册；签名注册使用 native SDK，无需安装官方 runner listener 或传入 `--runner-path`。
- 2026-10-21：合并 core metadata 与 owner-scoped source credential 契约；`vue-tsc --noEmit`、Runner UI tests 7/7、Actions worker tests 13/13、signing/scheduler unit tests 29/29、Actions typecheck、broker syntax/help 均通过。
- 2026-10-21：修复签名 heartbeat watchdog 缺失的 per-run abort state；heartbeat 失败时等待 native process tree 停止后才提交可信 `/fail` 回调。Core 正在收敛 SDK output-init identity body 字段的 parser 契约，合并后补最终回归。
- 2026-10-21：合并 core 2878909 的 output-init lease identity 契约与 SDK `45b98b3` cancellation checkpoint；更新 Windows/macOS/Linux 专用签名用户部署说明。SigningEnv cast 已由结构化 environment type guard 替代，Actions 类型检查通过。
- 2026-10-21：真实 Worker callback start 在 core strict manifest contract 下通过；`complete` fixture 当前受 core R2 multipart route 重构影响返回 503，待其 checkpoint 合并后复跑并记录结果。
- 2026-10-21：补充 signing callback 的 GIT binding fail-closed 守卫和真实 Worker fixture；profile approval UI 覆盖 API 拒绝时保留错误且不显示已批准状态。UI tests 8/8、Actions typecheck、Vue typecheck 通过；core 的 GitFileSchema profile route/checkpoint 尚待合并，complete Worker case 仍返回 `signing_unavailable`，暂不作为通过结果。
