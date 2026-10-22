# 操作记录

- 已检查空闲负载脚本、broker 活动锁获取与释放代码，以及东京三台机器的服务、进程、内存和负载只读状态；远端仅只读。
- 已从最新 `origin/main` 建立本地 `codex/idle-backoff` 隔离工作树。
- 完成root监督器与 `gitedge-idle` 原生降权子进程控制器；argv无命令时拒绝启动。活动锁、CPU负载/PSI、内存/PSI、IO PSI触发TERM进程组；压力解除45秒后从持久state目录恢复。数据目录超512MiB暂停且不删除文件。
- 子进程退出宽限2秒，随后KILL自身进程组并有界等待；磁盘探针也有界清理。systemd Swap容量探测容忍页级差异；idle安装路径不执行swap或journal维护，01不存在的actions目录通过可选只读路径处理。
- systemd配置低CPU/IO权重、CPUQuota50%、无swap、内存上限、日志速率限制及任务用户权限隔离。
- 测试覆盖活动锁抢占、低压力负例、CPU/内存/IO PSI、磁盘上限、恢复和清理，位于仓库根 `/test`。
- `py_compile`、Node语法检查、Git Bash语法检查、`git diff --check`通过；Node测试在Windows跳过2项Linux进程组/`/proc`集成用例。WSL启动失败，未能本机执行Linux运行验证。
- 已提交本地分支 `codex/idle-backoff`，没有推送、合并或远端写入。

- A1首次真实启动结果为未启动FAH（manager约7MiB、未监听7396）；初判锁抖动。核对生产broker源码后确认空poll也持锁，修为短锁不暂停任务、超过5秒才busy，并检测真实bridge/Runner进程立即抢占。
- Linux隔离集成测试复测4/4通过，覆盖2秒锁抖动保留恢复计时、短锁不中断运行task、5秒持续锁抢占、bridge进程即时抢占及既有CPU/内存/IO/磁盘/进程清理用例。
