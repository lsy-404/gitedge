# Home-1-1 间歇连接根因分析（gitedge#93）

- 排查对象：IRIS 任务中心条目 `git/github.com/lsy-404/gitedge#93`（observedAt=1794298728376 ≈ 2026-11-09），现象记录为“IRIS 任务已运行超过 24 小时且处于 stale_running”。
- 本报告只描述与定位，不改产品代码；关联前置文档：`docs/analysis/ci-data-channel-isolation-baseline.md`（#93 前置基线，提交 `10bd60ff`）与 #92 先例诊断（分支 `diag/gitedge-92-stale`，`reports/gitedge-92/stale-diagnosis.md`，提交 `bbc510c1`）。

## 现象

1. #93 任务中心条目滞留 `stale_running`（“运行超过 24 小时无进展”的摘要来自采集器，非实时心跳）。
2. Home-1-1（CNHome/Dell R730 NAS，64 GiB，家庭间歇网络）的 CI 通道偶发断开。

## “Home-1-1” 与 “stale_running” 的含义

**Home-1-1 是部署侧的设备/runner 注册标签，不是本仓库源码中的标识。**

- gitedge 工作树 main（基线 `993168b4`）全局大小写不敏感搜索 `Home-1-1` 为 0 命中；`stale_running` 亦无字面命中（仓库用 `stale` 形容 socket/容量/锁，如 `packages/contracts/src/runners.ts:11-12`）。
- 前置基线文档明确记载（`10bd60ff:docs/analysis/ci-data-channel-isolation-baseline.md:160-161`）：“仓库内未检索到 `Home-1-1`、`datachannel` 字样；该名称是设备/runner 注册标签（存在于部署侧，不在本仓库源码中）。调度按标签匹配。”
- 该标签指 CNHome 主机上的旧网络控制身份：agents-personal 分支记录（`agents-personal:093_[Ops]_修复_Home-1-1_间歇连接并保留_CI_数据通道隔离/progress.md`）：gitedge#3 记录 “R730 NetworkControlConnector 旧身份 `home-1-1` 曾 appliedRevision160 且 lease expired、控制台最近连接 8 天前；后续将旧控制域更正到 net.leisiyu.dev，leaseValid=True/revision168，home-1-1 heartbeat 显示恢复”。
- `docs/runner-devices.md:28`（提交 `de06e395` 引入 CNHome 段）：“DEVICE=cnhome: this is the Windows Dell R730 NAS (64 GiB) on an intermittent home connection”，2 Windows + 2 Linux 槽位、每平台一个双槽注册、Hyper-V 池 `C:\ge\vm-pool`、启动任务 `GitEdgeVmPool`；“Network outages reconnect the broker without killing running jobs, but a job can still fail when its upstream stays unreachable.”（网络中断时 broker 重连且不杀正在运行的任务，但上游持续不可达时任务仍会失败。）
- 结论：Home-1-1 = R730 主机（cnhome）上以 `home-1-1` 注册的 runner/网络身份与它承载的执行槽；不是独立的调度单元。

**stale_running 的判定来源：**

- `packages/contracts/src/runners.ts:11-12`：`RUNNER_CAPACITY_STALE_MS = 45_000`、`RUNNER_SOCKET_STALE_MS = 90_000`。
- `docs/runner-scheduling.md:59`：每 broker 一条出站 WebSocket 至 `/api/actions/runner/connect`；首帧 `report`，之后每 30 秒及槽位变化上报；同一 runner 新连接以 4003 关闭旧连接；**90 秒无上报视为卡死，服务端 30 秒一次对账、以 4008 关闭、标记离线并收回 offer**；broker 随后重连。
- `workers/actions/src/runner-dispatch.ts:141`（socket 90s 过滤）、`:362`/`:596`/`:618`（容量 45s 过滤）、`workers/actions/src/runner-overview.ts:240`。
- 客户端：`scripts/runner-broker-supervisor.mjs:4,45`（90 秒无心跳终止子进程）；`scripts/runner-broker-socket.mjs` 的 `reportStallMs` 90 秒无上报自连重置；重连指数退避上限 60 秒（前置基线 `10bd60ff` 50/150 行）。
- 前置基线（`10bd60ff` 19-20、150-152 行）将 `RUNNER_CAPACITY_STALE_MS`/`RUNNER_SOCKET_STALE_MS`/`RUNNER_OFFER_TIMEOUT_MS=15s`/`RUNNER_FAILURE_HOLD_*` 列为 Home-1-1 间歇连接的直接候选点。

## #93 执行状态与日志（IRIS 记录位置与时间线）

IRIS 任务执行记录存放在仓库 `agents-personal` 分支的 `093_[Ops]_修复_Home-1-1_间歇连接并保留_CI_数据通道隔离/{task_plan,progress,findings}.md`（`git show 'agents-personal:<dir>/<file>'`）与 `.iris/tasks/`；#92 的同类记录在 `092_[Ops]_检查CNHome虚拟化…`（原始提交 `76e70283`，2026-11-10T18:23:57Z）。

提取的时间线（均引用 agents-personal `093_*` 三文件原文）：

1. **2026-11-09**（采集器 observedAt=1794298728376）：#93 记为 stale_running（摘要来自任务采集，非执行器实时心跳——#92 先例已确认该语义）。
2. **2026-11-10 07:57:20/23Z**：CN-Server-1-1 现场快照：`r730-ssh` profile 的 `frpc.json` mtime=07:57:20Z，frpc 子进程 PID24820 启动=07:57:23Z；其到 Tokyo `168.110.32.35:7443` 的 socket 于 08:06:34Z 建立（findings.md “CNHome 当前监控与 FRP 连接快照”）。
3. **2026-11-10 12:07Z 与 12:37Z**：progress.md 记录现场再次观察到 R730/FRP SSH 超时（约 30 分钟节奏的两次中断，非 macOS VM/Xcode 重启）。
4. gitedge#41 历史日志的精确对照：Tokyo FRP grant 刷新与旧 carrier 关闭同时发生（`00:57:42.852 配置更新 / 00:57:42.858 关闭`，后续 01:27:44、01:57:45/57复现；findings.md 引用）。

**关联判断：** #93 的 stale_running 与 Home-1-1（R730）连接中断相关：中断窗口与 FRP grant 半小时刷新节奏及 frpc 子进程重启一致（07:57 配置更新→frpc 重启→08:06 才重建 7443 socket，约 9 分钟控制面缺口；12:07/12:37 两次 SSH 超时同节奏）。CI 数据面（NAS 23129→Tokyo 2229→Squid，#41 迁移）与该管理隧道分离，故 #93 记录的执行停滞属于“任务记录与执行进度脱节”（同 #92 先例：agent claim 冲突、续做结果暂存本地、未回写），而不是 24 小时空转；但连接缺口确实按 30–40 分钟节奏反复出现。

## 间歇连接机制（代码定位）

- FRP grant 每 30 分钟刷新、JWT 1 小时过期（`worker/network.ts:720-735`、`worker/security.ts:5-8`）；connector `apply` 全量指纹比对后 `d.stop()`（SIGINT，3s 后 KILL）再 `exec.Start` 替换进程，**必然掉控制连接**（`native/cmd/network-connector/main.go:485-520, 622-642`）；node 侧 Login/Ping/NewProxy 等全部要求有效 grant 与 60 秒内 sync（`native/cmd/network-node/main.go:269-327`）。FRP 官方文档确认 reload 不能更新 grant 类全局元数据。此为 management 隧道周期中断的直接机制（093 findings.md 第一条结论）。
- CI 通道侧：服务端 90s stale（4008）+ 45s 容量过期 + 15s offer 超时；客户端 90s `reportStallMs` 自连重置、退避重连（上限 60s）；心跳失败时签名/租约路径在当前租约内重试（`scripts/runner-broker.mjs:988` “retrying within the current lease”）。
- 抢占语义：同 runner 新连接 4003 关旧连接；基础实施失败连续 3 次（`RUNNER_FAILURE_HOLD_THRESHOLD`）隔离 10 分钟、上限 1 小时（前置基线 33/38 行）。

## 复现（现有测试）

- `pnpm exec vitest run test/actions/github-runner.worker.test.ts`（既有服务端 runner 测试，覆盖 connect/dispatch 路径）——在只读排查分支上执行一次作机制复现（结果见提交说明/报告）。
- 结果：7/7 通过（vitest 4.1.11，9.38s，本地执行 2026-11-11），connect/dispatch 路径验证无回归；周期性中断机制以现场快照+历史日志对齐复现（见上文时间线），无需新脚本。

## 根因判断

1. **管理面周期掉线（已定位机制）**：FRP grant 30 分钟刷新会全量重写 `frpc.json` 并 stop→start 子进程，每次刷新造成约数分钟管理隧道缺口；家庭网络进一步叠加上游不可达窗口。这解释 Home-1-1 的“间歇连接”。
2. **stale_running 判定偏早且无服务端兜底**：runner socket 90 秒、容量 45 秒即 stale；任务中心条目对 #93 的 stale_running 来自采集快照，不能证明 24h 空转（#92 先例已核实；记录与执行脱节是普遍形态）。
3. **修复思路**：
   - 管理面：采用已交付的 FRP 无中断续期（progress.md：经独立子 agent 在隔离 clone 合并 `5e7c91a`，生产未切换）——保留 1 小时 grant 语义下的安全轮换路径；切换前验证各中继与 connector 的独立管理通道及线上 FRP 版本。
   - 服务端 stale 语义：对“有租约且租约仍在续（leaseRequest 心跳）”的 runner/socket 放宽 socket-stale 判定，或增加 stale-run 清算（避免任务在 24h 断联后仍标 running）；候选点即 `RUNNER_SOCKET_STALE_MS`/`RUNNER_CAPACITY_STALE_MS`/`RUNNER_FAILURE_HOLD_*`。
   - 客户端：保持 broker 断网不杀任务语义（`docs/runner-devices.md:28`），补充在重连后立即补报容量与租约心跳。
4. **#93 终止建议（仅建议，不操作）**：#93 无实时执行体在运行时，建议由任务中心负责人将其标记/释放而非继续等待（旧 claim 冲突已致进度未回写）；任何 runner 槽位回收应由 dashboard 完成并先停止注册（不杀主机进程）。
