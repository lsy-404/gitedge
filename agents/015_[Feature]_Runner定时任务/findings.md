# Findings

- 用户确认仅按需任务工作流并追加 cron；不需要常驻 HTTP/daemon。
- Actions Worker 已有每分钟 cron tick；当前 native workflow 只支持 push/manual，需要拓展而不是新增调度服务。
- cron-parser 5.10.2 官方 README 支持 UTC 时区与 next()；采用五字段 POSIX 表达式，禁用随机和扩展字段。
- 日程仅特殊 Runner 默认分支；同一workflow同一到期时刻唯一，错过的周期合并一次，保留现有执行预算与租约。
