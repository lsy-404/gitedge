# Runner 申领分配算法与查看面板 — 设计稿

> 状态：已实现，部署验证中 · 2026-10-21

## 1. 现状

- 拉取式：broker 每 5–120 s 调 `POST /api/actions/runner/claim`，请求体 `{}` 被服务端读取后丢弃（`workers/actions/src/runners.ts` `claim()`）。
- 服务端一条 `UPDATE … WHERE run_id=(SELECT … ORDER BY created_at LIMIT 1)` 选择**最早**、作用域匹配、`labels ⊆ runner.labels` 的 GitEdge 作业；没有则走 `claimGithubRunner()` 用同样规则选 GitHub 作业。
- 每个 runner 只有一个执行槽（两张作业表都检查 `busy.status='running'`）。
- 不考虑：内存、CPU、磁盘、工具链、负载、预算；不比较其它 runner 是否更合适；runner 连续启动失败也会继续领到作业。
- 历史只能从 `actions_runner_runs` / `actions_github_runner_jobs` 的 `runner_id, started_at, completed_at, conclusion` 推出；没有负载记录，也没有 Web 界面（只有 CLI `runner-broker list` 和 `GET /api/actions/runners`）。

## 2. 目标与原则

1. **按申领来**（Claim 语义，参照 K8s PVC“申领”）：作业声明它需要什么（申领单），runner 申领作业时报告它有什么（容量报告）；只有满足申领的 runner 才能绑定作业。
2. **宁可等待，不分配不能用的 runner**：任何硬约束不满足、或无法确认满足（容量未知、报告过期、runner 被隔离），作业保持 `queued`，绝不“先给了再说”。等待原因要能在面板中看到。
3. 保持拉取模型和现有安全边界：不新增服务端推送通道，不改变租约/JIT/凭据流程；单槽不变。
4. 可用的 runner 不止一个时，**最合适者优先**（轻任务给小机器如 AMD 630 MB 节点，重任务留给大机器），但要有老化机制避免饿死。

## 3. 作业申领单（Job Claim）

唯一同时适用于 GitEdge workflow 与 GitHub webhook 作业的通道是 `runs-on` 标签，因此用**保留前缀标签**表达申领，其余标签仍按原规则做子集匹配。

| 标签                                                                   | 含义                                                        | 判定                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- |
| `self-hosted`、`linux`、`x64`、`arm64`、`macos`、`windows`、自定义标签 | 普通标签（系统、架构、用途）                                | 必须 ⊆ runner 标签（不变）             |
| `need-mem-<n>g` / `need-mem-<n>m`                                      | 最少**可用**内存                                            | `capacity.memFreeMb ≥ n`               |
| `need-cpu-<n>`                                                         | 最少逻辑核                                                  | `capacity.cpus ≥ n`                    |
| `need-disk-<n>g`                                                       | 工作目录所在盘最少可用空间                                  | `capacity.diskFreeMb ≥ n`              |
| `need-tool-<name>`                                                     | 工具链，如 `docker`、`node`、`pnpm`、`python`、`go`、`rust` | `name ∈ capacity.tools`                |
| `need-time-<n>m`                                                       | 预计最长耗时（预算用），GitHub 作业也可声明                 | 参见预算约束；同时作为本地执行截止时间 |

- 解析为纯函数 `parseJobClaim(labels) → { labels, memMb, cpus, diskMb, tools, minutes }`；无法解析的 `need-*` 标签视为**不可满足**（作业等待并显示“无法识别的申领”），不静默忽略。
- 默认值：未声明内存时按 `512 MB` 申领（低于此的节点视为不可用）；未声明时间时 GitEdge 用 workflow 的 `timeoutMinutes`，GitHub 作业用 360。
- GitHub JIT runner 的 labels 就是作业的完整标签（`workers/forge/src/github-runners.ts`），所以 `need-*` 也会挂到临时 runner 上，GitHub 端路由不受影响。
- 现有 SQL 子集判定改为跳过 `need-%` 前缀：`… WHERE lower(required.value) NOT IN (…) AND lower(required.value) NOT LIKE 'need-%'`。

## 4. Runner 容量报告（申领请求体）

broker 每次 `claim` 时上报（新增 `RunnerClaimInputSchema`，全部可选以兼容旧 broker）：

```jsonc
{
  "capacity": {
    "os": "linux",
    "arch": "x64",
    "cpus": 4,
    "load1": 0.42, // os.loadavg()[0]，Windows 为 null
    "memTotalMb": 3900,
    "memFreeMb": 630, // os.freemem()（Linux 读 MemAvailable）
    "diskFreeMb": 18000, // statfs(工作目录)
    "tools": ["node", "pnpm", "docker"], // 启动时探测 + 每 10 分钟刷新
    "slots": 1,
    "busy": 0,
  },
  "budget": {
    // 来自 broker profile 配置，可选
    "maxJobMinutes": 60, // 单作业上限
    "dailyMinutes": 240, // 滚动 24 小时累计执行上限
    "cost": 10, // 相对成本 0–100，越低越优先
  },
}
```

- 服务端写入 `actions_runners.capacity_json / budget_json / capacity_reported_at`，并按“每 runner 每分钟最多一条”写入负载采样表。
- 预算由 runner 所有者在 broker 侧声明，只约束该 runner 自身，因此可信任上报值；服务端仍做范围校验。
- 旧 broker（无 capacity）：容量视为**未知**，只能领取**没有 `need-*` 申领且无默认内存要求之外约束**的作业；面板标记“未上报容量”。

## 5. 分配算法

### 5.1 硬约束（可用性判定 `usable(runner, job)`）——任一不满足即“不能用”

1. 作用域：`namespace_id` 相同，且 runner 为 owner 级或 `repository_id` 相同（不变）。
2. 普通标签 ⊆ runner 标签（不变）。
3. runner 空闲：两张作业表都没有该 runner 的 `running` 记录（不变）。
4. runner 未撤销、未被隔离：`revoked_at IS NULL AND (held_until IS NULL OR held_until ≤ now)`。
5. 容量已知且满足申领：内存、CPU、磁盘、工具链逐项判定；容量未知时仅允许无申领作业。
6. 预算：
   - `job.minutes ≤ budget.maxJobMinutes`（如设置）；
   - `used24h + job.minutes ≤ budget.dailyMinutes`（如设置；`used24h` 由两张作业表在 24 h 内的 `MIN(completed_at, now) − started_at` 汇总）。
7. 负载闸门：`load1 / cpus ≤ 1.5`（主机已被其它进程压满时不接新作业）。

每条不满足产生一个**原因码**：`scope`、`label:<x>`、`busy`、`held`、`mem`、`cpu`、`disk`、`tool:<x>`、`budget-job`、`budget-daily`、`load`、`capacity-unknown`、`claim-invalid`。

### 5.2 申领流程（runner R 调 claim 时）

```
1. 校验并保存 R 的容量报告与预算；按分钟写采样。
2. 若 R 忙 / 被隔离 → 返回 {run:null, pollAfterSeconds}。
3. 取候选：两张表中作用域与普通标签都匹配 R 的 queued 作业，
   按 created_at 升序合并，最多 25 条（有界，作业申领顺序 = 先到先得）。
4. 对每个候选 J（按申领顺序）：
   a. 若 !usable(R, J) → 跳过（J 继续等待）。
   b. 计算 R 的适配分 score(R, J)。
   c. 取“同作用域、空闲、未隔离、容量报告 ≤ 45 s 内”的同伴 runner P，
      若存在 usable(P, J) 且 score(P, J) < score(R, J) − 5，
      并且 J 等待时间 < 老化阈值 (120 s) → 跳过（留给更合适者，R 看下一个）。
   d. 否则用现有原子 UPDATE（WHERE id=J AND status='queued' AND R 空闲）绑定。
      成功 → 返回租约；竞争失败 → 继续下一个候选。
5. 都没绑定 → 返回 {run:null, pollAfterSeconds: 5}。
```

- **顺序公平**：作业按申领（创建）顺序考虑；R 只有在“更早的作业它用不了或有人更合适”时才会拿到更晚的作业，这不会让更早作业被“不能用的 runner”抢走。
- **宁可等待**：步骤 4a 是硬过滤，不存在降级分配；4c 的让位只针对“能用但不是最优”，并受老化阈值限制，超过阈值后任何**能用**的 runner 都可接手。
- 同伴判断只读 D1 中最近的容量快照，不跨服务调用，满足 Workers 有界子请求要求。
- 原子性沿用单条 `UPDATE … RETURNING`；同伴快照可能略旧，最坏情况是一次次优分配，绝不会是不可用分配（硬约束总是基于申领者**本次**上报的容量）。

### 5.3 适配分（越低越合适）

```
score = 40 × memSurplus + 25 × cpuSurplus + 20 × loadRatio + 10 × budgetUsedRatio + cost/10
memSurplus  = (memFreeMb − job.memMb) / memTotalMb        // 最佳适配：剩余越少越好
cpuSurplus  = (cpus − job.cpus) / cpus
loadRatio   = min(load1 / cpus, 1.5) / 1.5
budgetUsedRatio = used24h / dailyMinutes（未设置为 0）
```

效果：无申领的轻任务 → AMD 630 MB 节点 memSurplus 小，优先；`need-mem-4g` 的任务 → AMD 不可用，只能大机器；大机器忙时轻任务也不会因为“大机器更空”被拿走。

### 5.4 故障隔离

- 基础设施失败计入 `consecutive_failures`：GitHub JIT 启动失败、作业凭据签发失败、租约过期（`expireRunnerRuns` / `expireGithubRunners`）。工作流自身的 `failure` 结论**不计入**。
- runner 正常 `complete` 任意结论 → 清零。
- 达到 3 次 → `held_until = now + 10 min × 2^(k−1)`（上限 1 h），期间不分配；面板显示原因与解除时间。

### 5.5 broker 侧配合

- 新增 profile 选项 `--max-job-minutes`、`--daily-minutes`、`--cost`；`claimGitEdge` 发送容量 + 预算。
- 本地再校验一次申领单（防御性，与 `eligible()` 并列）；GitHub 作业以 `need-time` 或 360 min 作为本地截止。
- 工具探测：`docker info`、`node -v`、`pnpm -v`、`python3 --version` 等，有超时、结果缓存 10 分钟。

## 6. 数据模型（迁移 `0047_runner_scheduling.sql`）

```sql
ALTER TABLE actions_runners ADD COLUMN capacity_json TEXT;
ALTER TABLE actions_runners ADD COLUMN budget_json TEXT;
ALTER TABLE actions_runners ADD COLUMN capacity_reported_at INTEGER;
ALTER TABLE actions_runners ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actions_runners ADD COLUMN held_until INTEGER;

CREATE TABLE actions_runner_samples (
  runner_id TEXT NOT NULL REFERENCES actions_runners(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,              -- floor(at / 60000)
  load1 REAL, mem_free_mb INTEGER, busy INTEGER NOT NULL,
  PRIMARY KEY (runner_id, minute)
);
-- 每分钟 cron 删除 24 h 前的采样，每次最多 500 行

CREATE TABLE actions_runner_deferrals (  -- 作业等待原因快照（每作业一行，覆盖写）
  job_kind TEXT NOT NULL CHECK (job_kind IN ('gitedge','github')),
  job_id TEXT NOT NULL,
  reasons_json TEXT NOT NULL,           -- {runnerId: [reason…]}
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_kind, job_id)
);
```

- 采样写入使用 `INSERT OR IGNORE`（主键去重），不增加 claim 的写放大。
- `deferrals` 只在 claim 跳过作业时 upsert，作业完成后由 cron 清理；面板也可实时计算，表只用于展示“最近一次被谁、因为什么跳过”。

## 7. 查看面板

### 7.1 位置与权限

- 账户设置新增分区 **Runners**（`/settings/account?section=runners`，`SettingsSidebar` 增加一项，组件 `AccountRunners.vue`）。
- 可见范围：本人创建的 runner，加上本人为 owner 的 namespace 下的 runner；与现有 `runnerManagement` 的 `registrationScopeAllowed` 一致；job token、agent session、无 admin 权限的 token 一律 403。
- 只读；撤销沿用现有 `DELETE /api/actions/runners/:id`（可在面板放撤销按钮，复用 `ConfirmButton`）。

### 7.2 API（Actions worker，Gateway 现有 `/api/actions` 路由透传）

`GET /api/actions/runners/overview` →

```ts
interface RunnerOverview {
  generatedAt: number;
  runners: Array<
    RegisteredRunner & {
      state: "idle" | "busy" | "held" | "offline" | "revoked"; // offline: lastSeen > 60 s
      capacity: RunnerCapacity | null;
      capacityReportedAt: number | null;
      budget: RunnerBudget | null;
      usedMinutes24h: number;
      heldUntil: number | null;
      consecutiveFailures: number;
      current: {
        kind: "gitedge" | "github";
        id: string;
        repository: string;
        startedAt: number;
      } | null;
      stats24h: { success: number; failure: number; cancelled: number; busyMinutes: number };
      samples: Array<{
        minute: number;
        load1: number | null;
        memFreeMb: number | null;
        busy: boolean;
      }>; // ≤ 96 点（15 min 聚合）
    }
  >;
  github: Array<{
    connectionId: string;
    repository: string;
    remote: string; // owner/name
    enabled: boolean;
    runnerEnabled: boolean;
    errorCode: string | null;
    failureCount: number;
    lastSyncedAt: number | null;
    queued: number;
    oldestQueuedAt: number | null;
    pendingCleanup: number;
    lastJobAt: number | null;
  }>;
  queue: Array<{
    kind;
    id;
    repository;
    labels: string[];
    claim: JobClaim;
    createdAt: number;
    blockedBy: Record<string /*runnerId*/, string[] /*reason codes*/>;
  }>;
  truncated: boolean;
}
```

`GET /api/actions/runners/history?runner=<id>&before=<startedAt>&limit=50` → 两张作业表按 `started_at` 倒序合并，返回 `{kind, id, runnerId, repository, labels, startedAt, completedAt, conclusion, durationMs}` 与 `nextBefore`。

有界：runner ≤ 100、连接 ≤ 50、队列 ≤ 50、采样 ≤ 96 × runner；超出返回 `truncated: true`，不假装完整。

### 7.3 界面结构

1. **概览条**：在线 / 忙碌 / 隔离 / 离线 数量；排队作业数与最久等待时间。
2. **Runner 列表**（每行一个 runner，可展开）：
   - 名称、作用域、标签（系统/架构/自定义分色）、状态徽章（复用 `StatusBadge`）。
   - 负载：CPU `load1/cpus` 与可用内存 `memFree/memTotal` 进度条；24 h 负载迷你折线（内联 SVG，遵守 `docs/design-tokens.md`）。
   - 预算：`usedMinutes24h / dailyMinutes` 进度条，单作业上限。
   - 当前作业：类型（GitEdge/GitHub）、仓库、已运行时长。
   - 隔离提示：原因与 `heldUntil` 倒计时。
   - 展开后显示该 runner 的历史（分页，调用 history API）。
3. **GitHub 连接**：每个开启 runner 路由的连接一行：启用状态、同步错误码、失败次数、最近同步、排队数、待清理 JIT 数；有错误时链接到仓库 GitHub 同步设置。
4. **等待队列**：每个排队作业显示申领单（内存/CPU/工具/时间）和“为什么还没分配”——按 runner 列出原因码的本地化文案，例如“AMD-01：可用内存 630 MB < 申领 4 GB”。
5. 刷新：手动刷新 + 页面可见时每 15 s 自动刷新。

i18n：新增 `apps/web/src/i18n/runners.ts`（zh-CN / en），原因码一一对应文案。

## 8. 测试计划（全部放在 `/test`）

- `test/actions/runner-scheduler.test.ts`（单元）：申领单解析、各硬约束原因码、适配分排序、老化阈值、容量未知兼容。
- `test/actions/runner-scheduling.worker.test.ts`（D1）：
  - 630 MB 节点不会领到 `need-mem-4g`，作业保持 queued，大节点上线后被领取；
  - 两个可用 runner，轻任务给适配分低者；更合适者 120 s 内未申领则由另一个接手；
  - 预算用尽 / 隔离期间不分配；完成后清零；
  - 旧 broker 空请求体仍可领取无申领作业。
- `test/actions/runner-overview.worker.test.ts`：权限（非 owner 404/403、job token 403）、有界与 `truncated`、历史分页。
- `test:web`：`AccountRunners.vue` 渲染状态、原因文案、空态。

## 9. 已确认决策（2026-10-21）

1. 申领标签使用 `need-*` 前缀。
2. 未声明内存时默认申领 512 MB。
3. 预算由 broker profile 声明（`--max-job-minutes`、`--daily-minutes`、`--cost`），随 claim 上报；面板只读，不新增 PATCH 接口。
4. 让位分差 5、老化 120 s、隔离 3 次 / 10 min 起翻倍（上限 1 h）暂不开放配置，作为常量定义在 `packages/contracts/src/runners.ts`。
5. 面板只放在账户设置的 Runners 分区；组织页 namespace 视图留待以后。
