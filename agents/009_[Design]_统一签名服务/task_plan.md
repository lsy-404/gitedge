# GitEdge Account Runner 签名迁移方案

- [x] 读取 agent-mode 与仓库规则，按只读审计流程调查。
- [x] 核对现有 signing-center 契约、三平台执行要求及 IRIS-Build、Epilogue、Oblivionis 的实际调用点。
- [x] 核对 GitEdge Actions runner 注册、调度、workflow 发现、执行 broker、token/lease 与 artifact 限制。
- [x] 按最新目标编写 GitEdge Actions + per-account private Runner 的最终架构、依赖缺口、跨仓改动和切换计划。
- [x] 明确 dedicated runner host/OS 隔离是前置条件；不实施跨仓生产切换。
- [ ] 父任务审阅后再决定后续实施拆分。
