# Findings
- 唯一执行依据为 docs/runner-scheduling.md，源提交 5697d93；当前设计 budget 是 maxJobMinutes / dailyMinutes / relative cost，不额外添加未在稿内确认的真实月费账本。
- 稿内旧 broker 的无申领兼容规则是用户明确批准的局部例外。
- 原 F: 主检出处于 design/runner-scheduling，保留其未跟踪 agents 审计；实现从设计提交另建 worktree。
- AMD2 已有 gitedge-runner 用户及基础依赖，无 Node 与 runner 注册。GitEdge 已登录，注册需要现有 admin API。
