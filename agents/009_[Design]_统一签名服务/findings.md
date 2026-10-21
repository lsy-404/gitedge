# 发现

## 当前结构与入口

- GitEdge 源码中的 `workers/auth/src/signing-keys.ts` 管理用户登记的 OpenPGP/SSH 公钥；`workers/git/src/signatures.ts` 和 `workers/git/src/api.ts` 验证 Git commit/tag 签名。这与桌面应用发布签名中心不是同一执行路径，不应因名字相同一起迁移。
- 当前桌面应用签名中心是 `lsy-404/signing-center`，默认分支内容在 commit `d1f97fb0635ab770851e0f69bfbce8a6fe10956c`。关键协调逻辑在 `src/native.ts`；请求策略/API 契约在 `src/policy.ts` 与 README 的 CI 部分。
- `src/native.ts` 的 `snapshot()` 解析 macOS/Windows 的 `public|private` lane，并从对应 executor config 固化 executor 与 policy digest；iOS 只允许 `private`。`allowed()` 再校验策略 digest、GitHub principal、build/source 仓库管理员关系、成功且精确匹配的源 workflow run；`executorRepository()` 强制 GitHub 仓库隐私属性与 snapshot lane 一致。runner 回调另校验 request generation、一次性 nonce、runner token、Actions run id、actor、workflow/ref/SHA、lease 和策略状态。
- macOS 执行器工作流：公开与私有执行器均可使用 `runner/workflow.yml`（公开镜像 `.github/workflows/macos-sign.yml`）；Windows 执行器另有 `.github/workflows/windows-sign.yml`。iOS 在私有仓的 `runner/ios-workflow.yml`。这些 workflow_dispatch 只传 request id、generation、nonce；执行客户端向中心请求输入并回传签名产物，不把输出作为 Actions artifact 发布。各工作流设置只读内容权限；Windows 另开 OIDC `id-token: write` 用于 Azure workload identity。

## 真实调用方与当前意图字段

- `lsy-404/IRIS-Build`：`scripts/submit-macos.mjs`、`scripts/import-macos.mjs` 和 `scripts/submit-windows.mjs` 都提交给 signing-center 并显式选择 `execution_visibility: 'public'`。服务端 project policy 配 source run、digest/size 和幂等键。
- `lsy-404/epilogue`：`scripts/release-signing.mjs` 显式选 `public`；服务端搜索结果显示 Epilogue Windows release 项目允许 `public_execution_allowed:false`，绑定 tag release/必需 job。
- `lsy-404/oblivionis`：`scripts/import-macos.mjs` 和 `scripts/release-signing.mjs` 显式选 `private`；桌面发布来源与签名输入走中心 API。
- 其他消费者：`SynthVCopilot/synthv-toolbox` 的 `agents_memory` 研究记录指向 signing-center 项目接入，但本次未直接核验其当前默认分支调用代码，故不列为当前已证实的生产调用路径。
- `signing-center/README.md` 说明 `execution_visibility` 支持 `auto|public|private`；`auto` 默认跟随源仓库 visibility；private source 强制检查 `public_execution_allowed` 才允许 public execution。`source_transfer` 的 `push|pull` 是独立策略：IRIS-Build 的大包已采用 push 上传到中心，Oblivionis 导入仍走 artifact pull。统一执行器并不自动意味着统一输入传输方式。

## 身份、密钥与信任边界（只记录名称/职责，不记录值）

- 中心持有 `GITHUB_TOKEN`，用以回查 run/repository 和 dispatch executor；runner workflow 使用对应仓的环境密钥 `SIGNING_RUNNER_TOKEN`。Windows 使用单独的 `SIGNING_WINDOWS_RUNNER_TOKEN`，另以 Azure OIDC 访问批准的证书 profile。Mac/iOS 的 Apple 凭据保存在中心绑定 `APPLE_CREDENTIALS`，密钥加密绑定 `APPLE_CREDENTIAL_ENCRYPTION_KEY`；iOS 凭据单独存放。密钥/证书值不读取、不复制。
- executor 配置（`src/macos-executors.json`, `src/windows-executors.json`, `src/ios-executors.json`）固定允许的 repository id、workflow 路径/ref、提交 SHA 和 token hash；macOS/Windows 分别保存 public/private 配置；iOS 仅 private。policy digest 将 executor 与产品策略绑定在 request snapshot，运行中配置更改会终止未完成请求。
- 服务对 public source 的 public execution 与 private source 的获批 public execution 分别建模；private source 默认不能送到 public executor。中心在来源运行和执行器运行的多个阶段复验仓库、run、ref、SHA、actor 和策略。改成一个 executor repo 时，需决定它的 GitHub privacy、环境保护、runner 承载方式和允许的源仓/产品集合；不能单纯删除 lane 选择并绕开 fail-closed 校验。

## 用户定案与切换决策

用户已明确选择：保留现有 signing-center，不创建新 API/服务；执行统一迁到一个独立私有仓库 `lsy-404/signing-exec-private`。公开 source workflow 仍可提交，但执行一定落在该私有仓库。macOS、Windows、iOS 继续使用各自 workflow 和 runner 主机条件。

执行选择字段没有必要保留为 caller 输入。切换完成的 API 直接移除 `execution_visibility`，并从所有真实调用脚本删除；`public_execution_allowed` 也因没有公开 executor 而删除。admin `resolved_execution_visibility` 可作为已存请求的只读历史字段，绝不可参与路由。处理旧请求 body 的历史读取时只保留管理页面所需字段，不接受旧 selector 作为 API 兼容路径。

现有 private 配置已含三平台候选 immutable refs：macOS `runner-token-2026-10-15-3`、Windows `windows-runner-2026-10-15-14`、iOS `ios-runner-2026-10-21-3`。切换前仍需在线确认 tag->SHA、workflow路径和 runner readiness。先冻结并清空所有以 public executor snapshot 运行的非终态请求，再部署单 private center 配置；旧 public token/工作流仅在 drain 与三平台验收通过后退役。不删除旧仓库。

**重要**：`signing-center` Durable Object 内已有请求会持久保存 submit body 与 execution snapshot。不要通过破坏性清空来简化模式更换；以全量非终态请求归零作为移除旧 pins 的条件，并保留历史 status 查询语义。

**调查局限更新**：前文记录的 `F:\Development\lsy-404` 路径仍不可访问；这次由 GitHub connector 查询 signing-center 与调用仓库。未改源代码/服务/远端状态，未派发签名任务。
## 来源与限制

以下 GitHub 文件通过已连接 GitHub connector 只读查询，SHA 为 connector 返回 blob SHA 或 commit ref；没有访问或读取秘密值。

- GitEdge 基线 `7d5cdda82b97eb7accf46ac96ef326e98caa1fe9`：`workers/auth/src/signing-keys.ts`, `workers/git/src/signatures.ts`, `workers/git/src/api.ts`。
- signing-center `d1f97fb0635ab770851e0f69bfbce8a6fe10956c`：[`src/native.ts`](https://github.com/lsy-404/signing-center/blob/d1f97fb0635ab770851e0f69bfbce8a6fe10956c/src/native.ts), [`src/policy.ts`](https://github.com/lsy-404/signing-center/blob/d1f97fb0635ab770851e0f69bfbce8a6fe10956c/src/policy.ts), [`src/macos-executors.json`](https://github.com/lsy-404/signing-center/blob/d1f97fb0635ab770851e0f69bfbce8a6fe10956c/src/macos-executors.json), [`src/windows-executors.json`](https://github.com/lsy-404/signing-center/blob/d1f97fb0635ab770851e0f69bfbce8a6fe10956c/src/windows-executors.json), [`README.md`](https://github.com/lsy-404/signing-center/blob/d1f97fb0635ab770851e0f69bfbce8a6fe10956c/README.md).
- signing-exec-private files: [`runner/workflow.yml`](https://github.com/lsy-404/signing-exec-private/blob/main/runner/workflow.yml) SHA `254cdd9ede7caf8c02f36dbb932a391f201e6df0`; [`runner/ios-workflow.yml`](https://github.com/lsy-404/signing-exec-private/blob/main/runner/ios-workflow.yml) SHA `ae943fc8f2ccfa4b6b4ac875ba84b20db8694fe6`; [`.github/workflows/windows-sign.yml`](https://github.com/lsy-404/signing-exec-private/blob/main/.github/workflows/windows-sign.yml) SHA `6bdce04cf4ad639f7b8668dfdf8ee3de42bf015c`.
- Caller evidence: [`IRIS-Build/scripts/submit-macos.mjs`](https://github.com/lsy-404/IRIS-Build/blob/73f9991e1ef2ed750abe6d1fde2091f0bf3cb368/scripts/submit-macos.mjs), [`scripts/import-macos.mjs`](https://github.com/lsy-404/IRIS-Build/blob/73f9991e1ef2ed750abe6d1fde2091f0bf3cb368/scripts/import-macos.mjs), [`scripts/submit-windows.mjs`](https://github.com/lsy-404/IRIS-Build/blob/73f9991e1ef2ed750abe6d1fde2091f0bf3cb368/scripts/submit-windows.mjs); [`epilogue/scripts/release-signing.mjs`](https://github.com/lsy-404/epilogue/blob/e5bf108b9d3e8a7547e3e45bc8372fe0e00e4b6c/scripts/release-signing.mjs); [`oblivionis/scripts/release-signing.mjs`](https://github.com/lsy-404/oblivionis/blob/5bdd356c6ca3aecb1152a51b5dec950ccce35140/scripts/release-signing.mjs), [`scripts/import-macos.mjs`](https://github.com/lsy-404/oblivionis/blob/5bdd356c6ca3aecb1152a51b5dec950ccce35140/scripts/import-macos.mjs).
- `F:\Development\lsy-404` does not exist in this environment; local sibling repositories were not inspected. GitHub connector code search was used instead. One repository search hit GitHub API rate limiting; no conclusion depends on that failed query.