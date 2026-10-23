# GitEdge 任务追踪
> 准则版本: v0.2.3
| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |
| :--: | :-- | :-- | :-- | :-- |
| 001 | [Design] runner分配与查看面板 | 已确认设计提交 5697d93 | 用户确认执行稿 | ✅ 已完成 |
| 002 | [Feature] Runner申领调度 | 集成设计并部署轻量节点 | 用户要求按执行稿落地 | ✅ 已完成 |
| 003 | [Feature] 调度后端 | 申领契约、D1、筛选、预算与隔离 | 缺少资源约束与适配选择 | ✅ 已完成 |
| 004 | [Feature] Broker容量报告 | 容量探测、预算、截止时间与 Linux 服务 | 接入 Ubuntu 节点 | ✅ 已完成 |
| 005 | [Feature] Runner查看面板 | 概览、历史、队列原因与 GitHub 连接 | 缺少运行状态可见性 | ✅ 已完成 |
| 006 | [Ops] 东京Runner维护 | swap、低优先级空闲负载、日志及解除预算 | 全职runner与免费节点维护 | ✅ 已完成 |
| 007 | [Feature] Runner日志清理 | 默认清理已结束执行目录与日志 | 防止常驻节点磁盘增长 | ✅ 已完成 |
| 008 | [Docs] 设备接入指令 | IONOS、Windows与Mac接入执行指令 | 其余设备自行执行配置 | ✅ 已完成 |
| 009 | [Design] 统一签名服务 | 签名完全迁移GitEdge账户Runner | 用户要求统一签名执行 | ✅ 已完成 |
| 010 | [Design] 账户Runner仓库 | 每账户特殊私有Runner仓库与权限 | 用户要求个人工作流入口 | ✅ 已完成 |
| 011 | [Feature] 账户Runner核心 | 特殊仓库模型与幂等创建 | 开始落实设计 | ✅ 已完成 |
| 012 | [Feature] Runner私有权限 | owner-only和不可变身份 | 完全私有服务中心 | ✅ 已完成 |
| 013 | [Feature] Runner服务入口 | 创建、配置与执行界面 | 支持个人服务配置 | ✅ 已完成 |
| 014 | [Feature] Runner中心集成 | 最小闭环、签名迁移及交付 | 按用户顺序执行 | 🔄 进行中 |
| 015 | [Feature] Runner定时任务 | UTC cron与真实节点执行 | 支持定时任务服务 | ✅ 已完成 |
| 016 | [Feature] 原生签名编排 | 来源权限、平台策略、公证与产物 | 签名整体迁入Actions | ✅ 已完成 |
| 017 | [Feature] 专用签名执行 | 节点审批、租约与工作流隔离 | 保护签名身份和凭据 | ✅ 已完成 |
| 018 | [Feature] 签名SDK | 平台工具与真实服务集成测试 | 使用account runner执行签名 | ✅ 已完成 |
| 019 | [Ops] Mac与Windows Runner替换 | Mac保持1个、Windows接入2个并发broker并替换旧注册 | 用户要求更新主机、凭据存入1Password并扩大Windows容量 | ✅ 已完成 |
| 020 | [Feature] 东京空闲任务主动退避 | 为已选出的受限公益计算任务提供可恢复的空闲资源调度 | 空闲负载需让出资源给runner及其他主机服务，并支持断点续跑 | 🔄 进行中 |
| 021 | [Refactor] 通用Runner签名 | 统一通用调度、任务级secret和凭据清理并更新主机 | 用户明确要求原生签名也不依赖专用runner | ✅ 已完成 |
| 022 | [Ops] 生产签名迁移 | 迁移凭据、主机和调用方并验证真实签名后退役旧仓库 | 用户明确要求完整切换且不中断在途任务 | 🔄 进行中 |
| 023 | [Ops] 签名工具链核验 | 核验 Windows/macOS 通信、签名工具、runner 活跃状态和任务级凭据清理 | 为生产签名真实验证确认通用主机能力与清理边界 | 🔄 进行中 |
| 024 | [Ops] 签名凭据迁移准备 | 盘点旧签名凭据并准备IRIS Runner profile策略候选 | 统一GitEdge生产签名入口并保留凭据授权边界 | 🔄 进行中 |
| 026 | [Fix] iOS Python runtime selection | Use the standard Python executable when `PYTHON` is unset | Align iOS SDK behavior with macOS native signer and allow host PATH provisioning | ✅ 已完成 |
| 027 | [BugFix] PAT仓库选择包含账户Runner | 在owner token仓库范围选项中列出已存在的账户Runner仓库并去重 | CI凭据必须精确授权给账户Runner仓库 | ✅ 已完成 |
| 028 | [Feature] Native signing workflow jobs | Run approved native signing through the standard one-job Runner.Server workflow and append the trusted SDK step | Preserve setup-action environment while keeping signing credentials protected | ✅ 已完成 |
| 029 | [Fix] executor-specific run limits | Container actions retain their hourly cap while self-hosted and native signing admission do not share it | The current shared cap blocks legitimate self-hosted signing and runner workloads | ✅ 已完成 |
| 030 | [Feature] Windows signing credential form | Add transient native inputs for Windows signing credentials with reauthentication retry | Allow owner-authorized credential installation without writing secrets to a local file | ✅ 已完成 |
| 031 | [BugFix] iOS signing submit 503 | Locate and fix the source submission failure without bypassing GitHub source attestation | The first production iOS native-signing canary failed before source acceptance | 🔄 进行中 |
| 032 | [Ops] Legacy signing retirement audit | Verify active callers, runs, preserved state and retirement prerequisites | Retire the old signing service without interrupting work or losing history | ✅ Complete |
| 033 | [BugFix] Safe native signing diagnostics | Preserve only allowlisted Mac, DMG, and Windows failure phases in SDK stderr and honor approved run timeout budgets | The native client currently replaces useful fixed phases with a generic signing error, and setup workflow timeout can truncate the appended signer | ✅ Complete |
| 034 | [BugFix] Native signing timeout propagation | Apply the approved signing timeout consistently to queue labels, trusted workflow, scheduler claim, and CLI | Readiness labels otherwise cap approved signing runs at the shorter setup-job budget | ✅ Complete |
| 035 | [Ops] Windows broker runtime recovery | Under the existing idle slot, replace only the exact old broker processes and verify both fresh runtimes | Updated checkout did not replace the old live Node processes | ✅ 已完成 |
| 037 | [BugFix] Native signing credential lease snapshot | Bind credential grant expiry validation to the server lease snapshot used to issue that grant | Parent broker renewal can advance the server lease beyond the SDK heartbeat snapshot | 🔄 进行中 |
| 038 | [BugFix] Windows signing context ACL | Make the context ACL checker parse in Windows PowerShell 5.1 and retain safe context error codes | A production Windows signer rejected its context before SDK startup | 🔄 进行中 |
| 039 | [Ops] Windows native signing failure probe | Read fixed allowlisted diagnostics for one terminal Windows native run | Identify the exact failure phase without exposing raw host logs | 🔄 进行中 |
| 040 | [BugFix] Signing context error propagation | Preserve allowlisted context errors through the native signing SDK | runSigning wraps context-reader errors and hides the fixed cause needed for safe diagnostics | ✅ 已完成 |
