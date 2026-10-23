# Runner 资源与调度

GitEdge 与 GitHub 作业都通过标准 `runs-on` 标签数组声明主机要求。标签不区分大小写，数组中的要求全部满足后才能领取任务。

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, server, RAM-2G, CPU-2, DISK-50G]
    steps:
      - run: pnpm build
  gpu:
    runs-on: [self-hosted, windows, device, GPU-NVIDIA, VRAM-8G, RAM-16G]
    timeout-minutes: 360
    steps:
      - run: python train.py
```

## 标签

| 标签                                              | 要求                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| `self-hosted`、平台、架构及自定义标签             | runner 注册标签必须包含每一个普通标签                    |
| `RAM-2G`、`RAM-56M`                               | 当前可用内存不少于指定值                                 |
| `CPU-4`                                           | 不少于四个逻辑 CPU                                       |
| `DISK-50G`、`DISK-512M`                           | broker 与 Actions 工作目录所在盘的可用空间均不少于指定值 |
| `GPU-NVIDIA`、`GPU-AMD`、`GPU-INTEL`、`GPU-APPLE` | 实际检测到对应厂商 GPU                                   |
| `VRAM-8G`、`VRAM-512M`                            | 一张匹配 GPU 的独立显存不少于指定值                      |
| `need-tool-node`、`need-tool-docker`              | 检测到指定工具；Docker 要求守护进程可用                  |
| `need-time-45m`                                   | 本地执行截止时间，同时用于预算判断                       |

`G` 与 `M` 分别表示 GiB 与 MiB，只接受正整数。内存/显存最多 1024 GiB、逻辑 CPU 最多 512、磁盘最多 1000 TiB。重复的资源要求取最大值；互相矛盾的 GPU 厂商或无法解析的资源标签不能匹配。`need-mem-2g`、`need-cpu-4` 和 `need-disk-50g` 也由同一解析器处理。

GPU 厂商和显存必须由同一张卡满足，不能累加多张小显存卡。共享系统内存不算独立显存。只有显存要求时可匹配任意厂商的单卡。探测失败、数据未知或不满足要求时，任务保持排队。`GPU-INVIDA` 是无效标签，应使用 `GPU-NVIDIA`。

未声明内存时按 512 MiB 申请；显式 `RAM-56M` 按 56 MiB 判断。未写 `timeout-minutes` 的本机任务默认 360 分钟，最大 360 分钟；显式较短的超时和 runner 所有者的预算继续生效。一个 GitEdge workflow 的总执行时间为各作业超时之和，上限 360 分钟。签名配置中已批准的显式超时不受默认值改变影响。

`RAM-`、`CPU-`、`DISK-`、`GPU-`、`VRAM-` 与 `need-` 是资源前缀，不能作为自定义主机元数据登记。`server`、`device`、`ip-residential`、`ip-datacenter` 等普通标签由管理员按实际情况维护，不会增加主机资源，也不代表自动获得更低风控。

## 容量与领取

broker 每次领取时上报操作系统、架构、逻辑 CPU、负载、可用及总内存、工作盘可用空间、工具和 GPU。Linux 使用 MemAvailable 并受 cgroup 剩余内存限制；macOS 包含可回收页面。GPU 使用 systeminformation，在独立进程中探测，最长八秒，工具与 GPU 清单缓存十分钟。显存指标为已安装的单卡独立显存。

服务端先检查作用域、标签、单槽空闲状态、隔离状态、资源和预算；broker 启动任务前再次按本机容量检查。过期容量不会作为其它 runner 可接手的证据。未报告容量的旧实例不能满足显式资源要求。

候选任务按创建顺序合并 GitEdge 与 GitHub 队列，每次最多检查 25 项。满足硬约束的 runner 可短暂让位给更合适的空闲主机，最多等待 120 秒。更适配的判断不会放宽任何资源要求。原子领取同时核对注册标签与容量快照，避免并发更新后错误分配。

每个 broker 只有一个执行槽；运行中的任务不会因标签变更而重新分配。连续基础设施失败三次后隔离十分钟，再次失败延长隔离，最长一小时；普通工作流失败不计入隔离。

GitHub 临时 runner 可能接到同标签的另一项作业。已知 runner 执行结束并删除后，GitEdge 会核对原始作业：同一作业仍在 GitHub 排队且连接授权有效时，恢复其排队状态。未知 JIT 创建结果不会重放。

## 面板

账户设置 → Runners 显示容量、GPU 与独立显存、当前任务、预算、近期历史及等待原因。资源不足、GPU 未确认、预算用尽、主机忙或标签不匹配会显示对应原因。容量探测未完成时显示未上报容量，不推测 GPU 性能。
