# 操作进度

- 2026-10-21：将父 checkpoint `85e9a18` fast-forward 合入本工作分支；包含权限阶段、Runner UI 与 cron scheduler。工作树干净。
- 2026-10-21：只读审查 Actions candidate selection、atomic lease、runner registration、machine callback 与 broker service install 路径；向 core 确认 signing DO internal API/context。
- 2026-10-21：父/core 确认采用 owner/recent-auth operator approval 模型，不引入硬件 attestation；专用 host 声明不等于已验证物理隔离。
- 2026-10-21：完成 runner execution class、owner recent-auth 批准与撤销 API、签名队列绑定和原子 claim、可信 machine callback、签名专用 broker 分流及私有 context ACL。
- 2026-10-21：验证 `typecheck:actions` 通过；runner claim/callback worker tests 6/6、signing coordinator tests 6/6、scheduler tests 9/9、signing SDK protocol tests 9/9 通过；`node --check scripts/runner-broker.mjs` 及 `--help` 通过。
- 2026-10-21：Actions 与 gateway 入口仍需父线程接入签名 callback path 和 signing bindings；当前阶段未在真实专用 host 执行签名。
- 2026-10-21：签名 Coordinator 接受 `/complete` 的 202 后，Actions 同步结束对应 stage lease 并发布检查；相同 lease 的成功 complete 可幂等重放。真实 D1 Worker 测试覆盖首次提交和重放。
- 2026-10-21：待 core 增加签名失败操作并在 Worker/broker 间闭环；父级负责 Actions/gateway 路由和 signing binding 接线。
