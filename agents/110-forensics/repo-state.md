# GitEdge #110 仓库侧取证报告

- **执行时间**：2026-11-24 12:03–12:05（UTC-05:00）
- **所在工作树**：`C:\Users\User\development\lsy-404@gitedge__worktrees\72660943-d62b-41e5-9ae3-491b2aaec54c-task-2425`（分支 `iris/72660943-d62b-41e5-9ae3-491b2aaec54c/2425`，基于 `main`）
- **任务背景**：IRIS 任务 git/github.com/lsy-404/gitedge#110「Colab 由 Actions Worker 直接通过 Colab 会话后端分配运行时，去掉桌面 waker」状态 running、24 小时无更新，被标记 stale_running。本报告只读取证：改动是否已做出来、只是没回写任务状态。

## 仓库侧判定（结论先行）

**是 —— 存在看似完成的 #110 改动，且已并入主干。**

依据：
1. 提交 `c4b69e76e7f171d1afaaca3c7cc7fa1b9ff8e714`（2026-11-23 12:14:38 -0500，作者 lsy-404，主题 *"Allocate Colab runtimes from the Actions Worker through the Colab session backend with a connected Google account, replacing the desktop waker"*）与 #110 标题逐义对应。
2. `git merge-base --is-ancestor c4b69e76 origin/main` 返回 0，且 `origin/main` 顶部的 `c92a7824` 是其后代——该改动不仅在某个残留分支上，而是**已经进了 origin/main 并随其发布**。
3. 代码现状验证：桌面 waker 实现文件已被删除（`scripts/runner-colab-waker.mjs`、`scripts/runner-colab/extension/*` 在当前工作树中 `Test-Path` 均为 `False`）；迁移 `0069_colab_server_runtimes.sql` 包含 `ALTER TABLE actions_runners DROP COLUMN colab_waker_seen_at`——"waker" 关键词在全仓库仅残留于这两份历史迁移文本中。
4. 替代实现已存在：`workers/actions/src/colab/session-backend.ts`、`colab/account.ts`、`colab/google-oauth.ts`、`colab/kernel.ts`、`colab/launch.ts`、`colab/routes.ts` 与 `workers/actions/src/colab-runners.ts`（541 行重构）；`docs/actions.md` 明确写明 *"no host or browser is involved. The Actions Worker allocates a CPU runtime for each job through the Colab session backend with that account's OAuth token"*。

**还需什么证据（超出仓库侧范围）**：
- 运行时侧：IRIS 任务记录/日志确认 #110 的执行会话即在 `c4b69e76` 上工作的会话（本仓库 `agents/` 目录不存在；任务记录实际保存在单独工作树 `.git/iris-agents/personal` 的 `agents-personal` 分支）。由并行的「运行时侧取证」任务覆盖。
- 验证侧：`c4b69e76` 的改动几乎没有配套服务端测试 —— 提交内唯一测试文件是 `test/ui/account-runners.test.ts`（仅 2 行 UI 适配）；`test/` 下没有针对 `colab/session-backend`、OAuth 交换或运行时分配的 worker 测试。是否实际执行过 `pnpm run test:workers` 等验证，以及改动是否已部署到生产，仓库内无法判定。
- 因此更准确的说法是：**代码改动完整且已合并发布，但服务端测试覆盖缺失；#110 大概率是「完成了没回写状态」**。

## 1. 工作树 / 状态 / stash

```
Get-Date -Format "yyyy-MM-dd HH:mm:ss zzz"   → 2026-11-24 12:03:27 -05:00
git worktree list
```
```
C:/Users/User/development/lsy-404@gitedge                                                            5697d930 [design/runner-scheduling]
C:/Users/User/development/lsy-404@gitedge/.git/iris-agents/personal                                  16084ab1 [agents-personal]
C:/Users/User/development/lsy-404@gitedge__worktrees/72660943-d62b-41e5-9ae3-491b2aaec54c-task-2425  c92a7824 [iris/72660943-d62b-41e5-9ae3-491b2aaec54c/2425]
C:/Users/User/development/lsy-404@gitedge__worktrees/72660943-d62b-41e5-9ae3-491b2aaec54c-task-2426  c92a7824 [iris/72660943-d62b-41e5-9ae3-491b2aaec54c/2426-iris]
```
```
git status --short   → （空输出，本工作树干净，无未提交改动）
git stash list       → 20 条，全部为历史任务的 worktree-cleanup 暂存（stash@{0}..stash@{19}），
                       无一属于 #110 / task-2425 / task-2426。摘录前 3 条：
stash@{0}: On iris/.../558-59: worktree-cleanup iris/.../558-59 (72660943-...-task-558)
stash@{1}: On iris/.../534-37: worktree-cleanup iris/.../534-37 (72660943-...-task-534)
stash@{2}: On iris/.../532-37: worktree-cleanup iris/.../532-37 (72660943-...-task-532)
```

- 主仓库检出在 `design/runner-scheduling`（`5697d930`），不在 main 上。
- 除主仓库外的 task-2425 / task-2426 两个任务工作树都在 `c92a7824`，均干净。
- `agents-personal` 工作树（`.git/iris-agents/personal`）持有 agents 记录分支；当前工作树内**不存在 `agents/` 目录**（`ls agents/` → PathNotFound），本报告在分支内新建该目录。

## 2. 分支/远端引用（按提交时间排序，前 15 条）

命令：`git for-each-ref --sort=-committerdate --format="%(refname)|%(committerdate:iso8601)|%(authorname)|%(subject)" refs/heads refs/remotes`

当前时刻 2026-11-24 12:03 -05:00，**最近 48 小时**（晚于 2026-11-22 12:03）的引用：**agents-personal、iris/.../2425、iris/.../2426-iris、origin/main、origin/HEAD**（其余均更早）。

| ref | 时间 | 作者 | 主题 |
|---|---|---|---|
| refs/heads/agents-personal | 2026-11-23 14:59:07 -0500 | IRIS | Update agents records |
| refs/heads/iris/.../2425 | 2026-11-23 14:55:40 -0500 | lsy-404 | Learn the GitHub account of an access token saved before accounts were recorded, and pad the service repository card |
| refs/heads/iris/.../2426-iris | 2026-11-23 14:55:40 -0500 | lsy-404 | （同上） |
| refs/remotes/origin/HEAD → origin/main | 2026-11-23 14:55:40 -0500 | lsy-404 | （同上） |
| refs/remotes/origin/main | 2026-11-23 14:55:40 -0500 | lsy-404 | （同上） |
| refs/heads/feat/signing-pat-batch | 2026-11-18 16:35:48 -0500 | IRIS | Support bulk GitHub source credential updates |
| refs/heads/main（本地，滞后） | 2026-11-18 16:35:48 -0500 | IRIS | Support bulk GitHub source credential updates |
| refs/heads/fix/signing-source-reason | 2026-11-16 10:14:11 -0500 | IRIS | Keep signing sources and signed outputs for 24 hours |
| refs/heads/feat/signing-runtime-server | 2026-11-15 23:01:29 -0500 | IRIS | Document the published signing runtime and failure reasons |
| refs/heads/feat/ios-extension-signing | 2026-11-14 03:54:08 -0500 | IRIS | Sign iOS apps that embed app extensions... |
| refs/heads/feat/macos-qemu-ephemeral-pool | 2026-11-11 06:40:41 -0500 | IRIS | Add offline coverage for the disposable macOS VM pool |

注：`refs/heads/main`（本地，2026-11-18）明显滞后于 `origin/main`（2026-11-23）；本文涉及 "main" 的差异比对以该滞后值为基准时会偏大，结论均以 `origin/main` 复核。

## 3. 提交日志

### 3.1 `git log --all --date=iso8601 --pretty="%h|%ad|%d|%s" -n 50`（前 20 条）

```
f0bb5887|2026-11-24 12:03:26 -0500||checkpoint 1          ← IRIS 运行时检查点，非业务提交
07d2cfa6|2026-11-24 12:03:25 -0500||checkpoint 1          ← 同上
16084ab1|2026-11-23 14:59:07 -0500| (agents-personal)|Update agents records
c92a7824|2026-11-23 14:55:40 -0500| (HEAD -> iris/.../2425, origin/main, origin/HEAD, iris/.../2426-iris)|Learn the GitHub account of an access token saved before accounts were recorded, and pad the service repository card
b2096ac3|2026-11-23 14:51:53 -0500||Order registered slots and on-demand providers separately with rented servers first, and split the services tab into repository, access and signing cards
...（"Update agents records" 若干）
c4b69e76|2026-11-23 12:14:38 -0500||Allocate Colab runtimes from the Actions Worker through the Colab session backend with a connected Google account, replacing the desktop waker   ← #110 候选
...
cfc948ef|2026-11-23 09:16:05 -0500||Document the Colab waker browser extension
8cb51fb4|2026-11-23 09:15:55 -0500||Treat GitHub's start refusal as used-up included minutes and confirm waker-opened Colab connections through a browser extension
0883047a|2026-11-23 05:09:17 -0500||Detect GitHub billing refusals of hosted runner runs and mark the GitHub tier exhausted so Colab takes over
7108a546|2026-11-23 02:52:26 -0500||Add Google Colab as the second on-demand runner tier
...
```

时间线读法：11-23 凌晨引入 Colab 层级（7108a546），早晨围绕桌面 waker/浏览器扩展（8cb51fb4、cfc948ef），中午 `c4b69e76` 用会话后端方案**替换**掉 waker，下午及晚间在 `b2096ac3`/`c92a7824` 继续润色 Runner UI 并抵达 origin/main 顶部。

### 3.2 关键词 grep

命令：`git log --all -i --grep="110" --grep="colab" --grep="waker" --grep="session backend" --date=iso8601 --pretty="%h|%ad|%s"`

```
c4b69e76|2026-11-23 12:14:38 -0500|Allocate Colab runtimes from the Actions Worker through the Colab session backend with a connected Google account, replacing the desktop waker
cfc948ef|2026-11-23 09:16:05 -0500|Document the Colab waker browser extension
8cb51fb4|2026-11-23 09:15:55 -0500|Treat GitHub's start refusal as used-up included minutes and confirm waker-opened Colab connections through a browser extension
0883047a|2026-11-23 05:09:17 -0500|Detect GitHub billing refusals of hosted runner runs and mark the GitHub tier exhausted so Colab takes over
7108a546|2026-11-23 02:52:26 -0500|Add Google Colab as the second on-demand runner tier
```

没有任何提交在主题中提及编号 "110"；与 #110 内容一一对应且时间上最晚的正是 `c4b69e76`。

## 4. 代码关键词检索：`rg -n -i "colab|desktop waker|waker|session backend|actions worker" --glob "!.git" .`（输出 120+ 行，节选归类）

**「桌面 waker」是否仍在：否，实现已被删除（仅剩历史迁移文本）。**

```
.\scripts\runner-colab-waker.mjs            → 不存在（Test-Path → False；在 c4b69e76 中被删除，原 352 行）
.\scripts\runner-colab\extension\*          → 不存在（Test-Path → False；c4b69e76 删除 content.js / manifest.json）
仅剩 waker 文本残留（均为历史迁移，描述旧 schema 及其删除）：
migrations\0067_colab_runners.sql:3   ALTER TABLE actions_runners ADD COLUMN colab_waker_seen_at INTEGER;
migrations\0067_colab_runners.sql:18  waker_runner_id TEXT REFERENCES actions_runners(id),
migrations\0069_colab_server_runtimes.sql:51  ALTER TABLE actions_runners DROP COLUMN colab_waker_seen_at;
```

**替代实现（session backend / Actions Worker 直分配）已存在：**

```
workers/actions/src/colab/session-backend.ts   (156 行，c4b69e76 新增)
workers/actions/src/colab/account.ts           (143 行)
workers/actions/src/colab/google-oauth.ts      (118 行)
workers/actions/src/colab/kernel.ts            (177 行)
workers/actions/src/colab/launch.ts            (74 行)
workers/actions/src/colab/routes.ts            (148 行)
workers/actions/src/colab-runners.ts           (541 行重构：claim→bootstrap→release 生命周期,
     错误码 colab_account_unavailable / colab_assignment_failed / colab_too_many_assignments /
     colab_launch_failed / colab_bootstrap_timeout)
scripts/runner-launcher.mjs  增加 `colab` 子命令（COLAB_PROFILE / GITEDGE_COLAB_BOOTSTRAP_TOKEN 一次性令牌交换）
migrations/0069_colab_server_runtimes.sql      新建 actions_colab_accounts / actions_colab_authorizations 表并重建 dispatches
docs/actions.md:18  "...no host or browser is involved. The Actions Worker allocates a CPU runtime
     for each job through the Colab session backend with that account's OAuth token..."
```

**是否有对应测试：服务端测试缺失。**

- `rg -i "colab" test/` 仅命中：
  - `test/ui/account-runners.test.ts:106,108`（UI 默认值夹具：`onDemandPriority`、`colab` 概览对象）
  - `test/ui/i18n-messages.test.ts:13,55,56`（i18n 键与 `COLAB_DISPATCH_STATES` 对齐）
- `rg -i "waker" test/` → 零命中。
- `test/actions/` 目录 13 个测试文件中**没有** colab 专属 worker 测试（无对 session-backend / OAuth / 分配生命周期的覆盖）。

## 5. 候选提交与差异取证

### 5.1 `git show --stat c4b69e76`（31 个文件，+1280 / -1328）

```
 apps/web/src/components/AccountRunners.vue          |  11 +-
 apps/web/src/components/runners/ColabRunnerCard.vue |  99 +++-
 apps/web/src/components/runners/RunnerOnDemandTab.vue   |   9 +-
 apps/web/src/i18n/runners.ts                       |  40 +-
 apps/web/src/lib/api.ts                            |   9 +
 docs/actions.md                                    |  17 +-
 docs/runner-scheduling.md                          |   4 +-
 docs/runner-services.md                            |  52 --
 migrations/0069_colab_server_runtimes.sql          |  51 ++    ← 新迁移
 packages/contracts/src/runners.ts                  |  25 +-
 packages/runner-kit/package.json                   |   1 -
 packages/runner-kit/pnpm-lock.yaml                 | 556 ---------------------
 scripts/runner-broker.mjs                          |  41 +-
 scripts/runner-colab-waker.mjs                      | 352 -------------  ← 桌面 waker 删除
 scripts/runner-colab/extension/content.js          |  19 -      ← 浏览器扩展删除
 scripts/runner-colab/extension/manifest.json       |  13 -      ← 同上
 scripts/runner-colab/open-browser.mjs              |  17 -      ← 同上
 scripts/runner-kit-pack.mjs                        |   2 +-
 scripts/runner-launcher.mjs                        |  57 ---
 test/ui/account-runners.test.ts                    |   2 +-    ← 唯一测试文件改动（2 行）
 workers/actions/src/colab-runners.ts               | 398 +++++++++------
 workers/actions/src/colab/{account,google-oauth,kernel,launch,routes,session-backend}.ts  ← 全部新增
 workers/actions/src/hosted-runners.ts              |   2 +-
 workers/actions/src/index.ts                       |   6 +-
 workers/actions/src/runners.ts                     |   7 +-
 workers/gateway/src/index.ts                       |   2 +-
```

改动形态：删除整套 waker（脚本 + 浏览器扩展 + 打开浏览器脚手架），在 Actions Worker 内新建 OAuth（PKCE）→ 会话后端分配 → kernel 启动 cell → 一次性 bootstrap 令牌的完整链路，前端 Colab 卡片改为连接 Google 账号。结构与「去掉桌面 waker、由 Actions Worker 直接通过会话后端分配」完全吻合。

### 5.2 合并状态

```
git branch --contains c4b69e76   → iris/.../2425, iris/.../2426-iris, origin/main（经由 origin/HEAD）
git merge-base --is-ancestor c4b69e76 origin/main   → exit 0（是其祖先）
```

### 5.3 `git diff --stat main...`（注意：本地 main 滞后于 origin/main）

与本地 `main`（2b051383, 2026-11-18）比较共 121 个文件、+10191/-2683 —— 这包含 11-18 以来整条 runner/签名/Colab 功能弧（`0063`–`0070` 全部迁移、runner-kit、远程签名等），并非 #110 单任务的差异。判断 #110 本身以 5.1 的 `c4b69e76` 单提交为准。若改与 `origin/main` 比较：当前分支位于其顶部 `c92a7824`，`git diff origin/main...` 为空。

### 5.4 相邻提交

- `cfc948ef`（waker 扩展文档）：`git show --stat` 仅 1 文件 +1 行（`docs/runner-services.md`），是 waker 时代的文档尾巴，随后在 `c4b69e76` 中 `docs/runner-services.md` 被精简（-52 行）。
- `git log --all --stat -n 3` 顶部两条 `checkpoint 1`（f0bb5887 / 07d2cfa6，2026-11-24 12:03:25–26）为 IRIS 运行时检查点，非业务提交。

## 6. 旁证与限制

- `git status --short` 全程干净，无未提交的 #110 半成品；stash 列表亦无 #110 相关项 —— 「改完了但没提交/藏在 stash 里」的情形不成立。
- 本工作树无 `agents/` 目录；IRIS 任务记录位于单独工作树 `.../gitedge/.git/iris-agents/personal`（分支 `agents-personal`，最新提交 `16084ab1` 2026-11-23 14:59:07 -0500，恰在 `c92a7824` 合入后 3 分钟）。该记录的具体内容由运行时侧取证任务核查，本报告不展开。
- 所有命令在 Windows 沙箱内执行成功；无因沙箱或网络导致的失败，无伪造输出。
