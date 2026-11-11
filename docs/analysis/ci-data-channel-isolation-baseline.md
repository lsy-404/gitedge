# CI 数据通道隔离基线(main @ 993168b4)

本文记录 GitEdge 仓库在 `main` 分支(`993168b4 Mount seed media before console login [skip ci]`)
上 CI 数据通道调度链路的隔离机制,以及修复前最后一次全量相关测试的通过/失败情况,供后续修复
(参见任务 #93「Home-1-1 间歇连接」)前后对比。

## 结论速览

- 数据通道只有一条出站 WebSocket:broker → Gateway
  `/api/actions/runner/connect`(升级后转发到 Actions Worker 的 `RunnerDispatch` Durable
  Object)。控制、数据、租约、容量上报共用这一条通道,GitEdge 任务、GitHub 作业和签名阶段在
  这一通道之上按 `kind`(gitEdge / github / signing)+ 执行槽隔离。
- 服务端隔离保证:Durable Object 每命名空间一个;offer/claim/assign 全部在同一 DO 内以 SQL
  主键(UQ + PK)约束;assign 只发到 accept 的那条 socket;断线回收 offer 并按租约回滚。
- 客户端隔离保证:执行槽池(`runner-slot-pool.mjs`,proper-lockfile 槽锁,独占任务锁满全部
  槽)+ VM/隔离桥(`runner-vm.mjs` + `isolation: "vm"` 容量标记)+ 每任务独立运行目录
  (`runner-run-root.mjs`)。
- 关键调度与保活常量集中在 `packages/contracts/src/runners.ts`(如
  `RUNNER_CAPACITY_STALE_MS` 45s、`RUNNER_SOCKET_STALE_MS` 90s、`RUNNER_OFFER_TIMEOUT_MS`
  15s、`RUNNER_FAILURE_HOLD_*`,是 Home-1-1 间歇连接问题的直接候选点)。
- 基线测试结果:本步选定 8 个隔离相关测试文件,60 个用例全部通过,无失败项。

## 数据通道隔离机制

### 服务端(worker/actions)

- `workers/actions/src/runner-dispatch.ts` — `RunnerDispatch` Durable Object:
  - 每命名空间一个 DO,持有 `offers`(`runner_id TEXT UNIQUE`,同名 runner 二连即以 4003
    superseded 关闭旧连接)与 `declines` 暂时排除表。
  - 帧协议白名单 + 严格 schema(`InboundFrameSchema`:report / accept / decline;出站
    ready / offer / assign / withdraw / error)。帧限速:每 10 秒 20 帧、16 KiB,违规以 4002
    关闭。
  - 90 秒无上报标记 stale(4008),由 30 秒定时对账清 `connected=0`,触发重新调度;凭据撤销
    或作用域失效以 4001 关闭。`RUNNER_SOCKET_STALE_MS`/`RUNNER_SOCKET_SWEEP_MS` 为阈常量。
  - accept 后 `commitOffer()` 复评候选,原子 D1 领取是唯一提交点;`assign` 只发给 accept 的
    socket,发送失败则调 `releaseUndeliveredClaim` 按租约回滚并记
    `runner-dispatch:assign-undelivered`。
  - 基础设施失败连续 3 次(`RUNNER_FAILURE_HOLD_THRESHOLD`)隔离 10 分钟,最长 1 小时。
- `workers/actions/src/runners.ts` — 作用域(`ownsScope`/owner/administrator)、runner 行读写、
  `claimSpecificCandidate`、`releaseUndeliveredClaim`、凭据哈希。
- `worker/actions/src/runner-network.ts` — runner 凭据签发与 `/api/actions/runner/connect`
  升级入口,校验 token、revoked、`u.disabled_at` 后转发到 DO。
- `workers/actions/src/device-health.ts` — 设备健康上报(Zod schema),与调度无关,仅面板用。
- `workers/actions/src/cron.ts` — 定时 `kickRunnerDispatch`:扫描 queued 任务按命名空间
  notify 对应 DO,恢复丢失的通知;不作为 broker 的轮询通道。

### 客户端(script)

- `scripts/runner-broker-socket.mjs` — 唯一数据通道客户端。固定参数:出站 ≤16 KiB、入站
  ≤2 MiB、30 秒报容量、30 秒 ping、90 秒无上报自连重置、指数退避重连(60s 上限)、4003
  superseded 直接停机(退出码 78)。协议校验错误以 4002 主动关闭。
- `scripts/runner-broker.mjs` - broker 主入口:
  - `runClaimedGitHub` / `runIsolatedClaim`(VM 任务)/ `runClaimedSigning`;三者共用同一个
    槽池与同一数据通道,隔离差异只在执行环境。
  - 租约:`leaseRequest` 续租/完成/心跳,`RUNNER_LEASE_MS=120s`(GitHub 5 分钟);租约到期
    前未完成即放弃。
  - 凭据按 profile 私有文件存放(`profileState`),`0600`/`0700`(Windows 用 ACL)。
- `scripts/runner-slot-pool.mjs` — N 槽池;独占(GitEdge workflow、签名)要求全池空闲并持有
  全部槽锁,槽锁落盘(proper-lockfile),跨进程互斥。
- `scripts/runner-vm.mjs` + `scripts/runner-vm/macos-network.sh` — QEMU/Hyper-V 作业隔离
  (独立 guest、独立桥、代理出口只指向 egress 代理),容量上报 `isolation: "vm"`。
- `scripts/runner-run-root.mjs` — 每任务独立运行目录根(Windows 短路径根 `<drive>:\ge\r`)。
- `scripts/runner-cache.mjs` / `runner-cache-store.mjs` — 共享缓存按 runner × repo × ref ×
  key × version 分键,跨任务不串。
- `scripts/runner-retention.mjs` — 1 GiB/7 天保留策略,不入活跃目录。

### 任务/凭据作用域

- runner 注册作用域:命名空间(owner)或单仓库(administrator),登录侧校验,连接侧每次
  上报/调度/领取复查;作用域丢失即 4001 断开。
- 作业凭据:`ge_job_` 前缀短时 token(`RUNNER_LEASE_MS`);GitHub 作业另发 JIT 配置(日志中
  redact)。
- GitEdge workflow 与签名独占主机;GitHub 作业并行占用槽位。

### CI 配置

- `.github/workflows/ci.yml` — 推送/PR 触发,GitHub-hosted(`ubuntu-latest`),执行
  typecheck + 单测 + workers 测试 + build + format。
- `.github/workflows/runner.yml` — `workflow_dispatch`,self-hosted
  `[self-hosted, macOS, ARM64, ci]` 标签,同一套验证命令。标签由注册 runner 决定,无
  `Home-1-1` 专属标签。
- `.github/workflows/runner-light.yml` — `workflow_dispatch`,self-hosted
  `[self-hosted, linux, x64, oci-light, ...]`,`need-time-5m`;运行 `node
test/runner-light.mjs`。
- 调度策略标签(如 `allow-limited-connect`)解析在
  `packages/contracts/runner-scheduling.mjs`,文档见 `docs/runner-scheduling.md`。

## 相关文件清单

| 文件                                       | 作用                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `workers/actions/src/runner-dispatch.ts`   | RunnerDispatch DO:offer/claim/assign/心跳/违规关闭(数据通道服务端) |
| `workers/actions/src/runners.ts`           | Runner 行、作用域检查、原子领取、租约回滚                          |
| `workers/actions/src/runner-network.ts`    | `/api/actions/runner/connect` 升级与凭据校验                       |
| `workers/actions/src/cron.ts`              | 定时对账 `kickRunnerDispatch`,恢复失联                             |
| `workers/actions/src/device-health.ts`     | 设备健康上报 schema(仅面板)                                        |
| `packages/contracts/src/runners.ts`        | 容量/租约/限速常量与 Zod schema                                    |
| `packages/contracts/runner-scheduling.mjs` | 标签解析、评分、领取参数                                           |
| `scripts/runner-broker.mjs`                | broker 主入口:槽池、租约、GitHub/签名/VM 任务执行                  |
| `scripts/runner-broker-socket.mjs`         | 唯一出站 WebSocket 客户端、保活、重连、4003 停机                   |
| `scripts/runner-slot-pool.mjs`             | 执行槽池(落盘槽锁、独占)                                           |
| `scripts/runner-vm.mjs`                    | VM 作业隔离(guest、桥、代理)                                       |
| `scripts/runner-run-root.mjs`              | 每任务独立运行目录                                                 |
| `scripts/runner-cache.mjs`                 | 共享缓存分键与配额                                                 |
| `scripts/runner-retention.mjs`             | 运行产物保留与回收                                                 |
| `docs/runner-scheduling.md`                | 调度/标签/保活/隔离文档(与代码同步)                                |
| `docs/runner-virtualization.md`            | VM 池与隔离桥文档                                                  |
| `docs/runner-cache.md`                     | 缓存隔离文档                                                       |
| `.github/workflows/ci.yml`                 | GitHub-hosted CI 验证                                              |
| `.github/workflows/runner.yml`             | self-hosted runner 验证(macOS ARM64)                               |
| `.github/workflows/runner-light.yml`       | self-hosted 轻量验证(linux oci-light)                              |

## 测试命令与基线结果

命令以 `package.json` scripts 为准;单元脚本测试走 `vitest.unit.config.ts`,Worker 走
`vitest.config.ts`(`miniflare.isolatedStorage: true` 已在配置中)。

```sh
pnpm vitest run --config vitest.unit.config.ts \
  test/actions/runner-scheduling.test.ts \
  test/actions/runner-cron.test.ts \
  test/actions/actions-service.test.ts \
  test/actions/run-do.test.ts \
  test/broker-capacity.test.ts \
  test/broker-runner-labels.test.ts

pnpm vitest run --config vitest.config.ts \
  test/actions/github-runner.worker.test.ts \
  test/actions/runner-overview.worker.test.ts
```

基线(2026-11-11,win32,Node 24,pnpm 10.34.6):

| 测试文件                                      | 用例数 | 结果             |
| --------------------------------------------- | ------ | ---------------- |
| `test/actions/runner-scheduling.test.ts`      | 20     | ✅ 通过 (8 ms)   |
| `test/actions/runner-cron.test.ts`            | 3      | ✅ 通过          |
| `test/actions/actions-service.test.ts`        | 5      | ✅ 通过 (41 ms)  |
| `test/actions/run-do.test.ts`                 | 6      | ✅ 通过          |
| `test/broker-capacity.test.ts`                | 10     | ✅ 通过 (153 ms) |
| `test/broker-runner-labels.test.ts`           | 2      | ✅ 通过 (4 ms)   |
| `test/actions/github-runner.worker.test.ts`   | 7      | ✅ 通过 (3.7 s)  |
| `test/actions/runner-overview.worker.test.ts` | 7      | ✅ 通过 (3.1 s)  |

合计:8 个文件,60 个用例全部通过,无失败项;输出中的 `runner-device-health-unavailable` 与
`actions:run-schedule-unconfirmed` 为测试桩场景内的预期 warn 日志,非失败。

## 观察与后续修复线索(不改代码)

- 间歇连接候选点集中在保活常量与重连语义:broker 侧 90 秒无上报自连重置
  (`reportStallMs`,`runner-broker-socket.mjs`),服务端 90 秒 stale(4008);两者一致的
  `RUNNER_SOCKET_STALE_MS`。`RUNNER_CAPACITY_STALE_MS=45s` 决定容量过期速度;断线时未完成
  的 offer 被收回、租约回滚。
- 网络失败改派(`allow-limited-connect`、limited-connect 设备)已实现在
  `packages/contracts/runner-scheduling.mjs` 的标签解析与 dispatch 侧改派逻辑中;受限网络
  设备默认不接单,显式允许才参与。
- 本基线未运行网络/VM 真机端到端(`test/e2e`、`test/artifacts-smoke` 等需真实账户与本地
  栈,属手动项),故不能证伪运行时连接问题;如修复涉及运行时行为,建议修复前后各跑一次
  `runner.yml` / `runner-light.yml` workflow。
- 仓库内未检索到 `Home-1-1`、`datachannel` 字样;该名称是设备/runner 注册标签(存在于部署
  侧,不在本仓库源码中)。调度按标签匹配,代码路径与 `Home-1-1` 的关联需从注册 runner 的
  标签配置入手。
