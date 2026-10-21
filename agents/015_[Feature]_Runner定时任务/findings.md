# Findings

- 用户确认仅按需任务工作流并追加 cron；不需要常驻 HTTP/daemon。
- Actions Worker 已有每分钟 cron tick；当前 native workflow 只支持 push/manual，需要拓展而不是新增调度服务。
- cron-parser 5.10.2 官方 README 支持 UTC 时区与 next()；采用五字段 POSIX 表达式，禁用随机和扩展字段。
- 日程仅特殊 Runner 默认分支；同一workflow同一到期时刻唯一，错过的周期合并一次，保留现有执行预算与租约。
- Worker 实测发现 cron-parser/Luxon 的 CJS/ESM 互操作使 DateTime 为 undefined；改用维护中的零依赖 Croner 10.0.1，Node 与真实 Workers 测试均通过，不保留旧库或适配层。
- cron index 在每次默认分支推送后重新读取当前默认分支，避免延迟投递的旧push覆盖新日程；到期再次读取当前定义，删除或无效定义不再执行。
- 原生入队改为D1 atomic batch同时建立run和runner job；唯一scheduled_at索引防止重叠tick创建重复任务。
