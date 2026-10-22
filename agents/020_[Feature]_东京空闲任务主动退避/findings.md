# 调查结果

- 生产 A1 的 `runner-broker.mjs` 在每次 GitEdge profile claim 前调用 `acquireActionsSlot()`，HTTP claim 返回空结果也在 `finally` 释放锁，然后默认睡眠30秒。活动锁会在短时空轮询期间出现，不能单独视为真实任务。锁内容含常驻broker PID和startedAt；PID本身不能证明job正在执行。
- 东京02与A1采样时 broker service 运行，journal 显示真实 job 开始和完成；01没有发现 GitEdge broker systemd unit。采样时三台锁均不存在。
- Tokyo02 的 `/opt/gitedge/work/actions` 指向 `/var/lib/gitedge-runner/actions`，目录为 `0750 gitedge-runner:gitedge-runner`；A1 的 `/opt/gitedge/work` 为 `0700 gitedge-runner`。专用任务用户无权读取锁路径，因此root监督器只检查锁/压力，再由 `Popen` 将任务降至独立UID/GID并清空附加组；服务不扩大生产目录权限。
- AMD主机约1GiB内存；A1约12GiB且OpenList运行。以负载/CPU数0.75、CPU PSI 80%、内存/IO PSI、MemAvailable共同退避；任务限额交给systemd unit。
- 控制器向任务独立进程组TERM，2秒后仍未退出则KILL同组，避免网络请求无限拖延抢占；超时清理也处理主进程退出后的同组残留进程。科研任务依赖客户端自己的检查点恢复。
- 用户已选Folding@home；本任务只实现控制器，客户端安装和配置由父任务处理。

- A1实际启动验证发现空闲客户端未出现且7396监听端口不存在：旧controller每次遇到短claim锁都会清空45秒恢复计时。运维只读样本显示约17秒一次的poll锁，常持续2–3个1秒采样；负载0.06–0.21。
- 真实job信号：broker claim工作期间持续持有活动锁；执行通过 `scripts/actions-runner.mjs run` 桥接，并产生 `Runner.Server`、`Runner.Listener run`、`Runner.Client`，workflow worker进程可标为 `Runner.Worker`。通过root读取 `/proc/<pid>/cmdline` 在内存中匹配这些执行进程名，不读取或输出cmdline，也不访问environ/credential。
- 控制器保留短锁期间的45秒计时；锁连续存在超过5秒才作为busy，真实runner/bridge执行进程立即busy。
