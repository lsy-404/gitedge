# Runner cron

- [x] 核对已有每分钟 Actions scheduled handler 与成熟 cron-parser API。
- [ ] 支持五字段 UTC on.schedule，限制有效表达式及数量。
- [ ] 默认分支更新建立日程，按 native runner 队列去重执行。
- [ ] 验证并发 tick、删除/禁用/改动日程、权限与现有用量限制。
- [ ] 在真实 Runner 上验证一次定时任务，交付代码和文档。
