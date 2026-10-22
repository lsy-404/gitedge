# 调查结果

- broker 的 `acquireActionsSlot()` 在 GitEdge profile claim 前创建 `work/actions/active.lock`，并在 `finally` 中释放；空闲任务监视同一锁路径是可靠的主要忙碌信号。
- 东京02与A1采样时 broker service 运行，journal 显示真实 job 开始和完成；01没有发现 GitEdge broker systemd unit。采样时三台锁均不存在。
- Tokyo02 的 `/opt/gitedge/work/actions` 指向 `/var/lib/gitedge-runner/actions`，目录为 `0750 gitedge-runner:gitedge-runner`；A1 的 `/opt/gitedge/work` 为 `0700 gitedge-runner`。专用任务用户无权读取锁路径，因此root监督器只检查锁/压力，再由 `Popen` 将任务降至独立UID/GID并清空附加组；服务不扩大生产目录权限。
- AMD主机约1GiB内存；A1约12GiB且OpenList运行。以负载/CPU数0.75、CPU PSI 80%、内存/IO PSI、MemAvailable共同退避；任务限额交给systemd unit。
- 控制器向任务独立进程组TERM，2秒后仍未退出则KILL同组，避免网络请求无限拖延抢占；超时清理也处理主进程退出后的同组残留进程。科研任务依赖客户端自己的检查点恢复。
- 用户已选Folding@home；本任务只实现控制器，客户端安装和配置由父任务处理。
