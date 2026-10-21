# 操作记录

- 集成复核：父工作树已运行Prettier格式化并验证两份设计稿、设备接入稿；此前子工作树缺少Prettier的限制已解决。补充真实OS隔离与owner委托机器scope，两稿经独立只读复核无剩余实质矛盾。

- 2026-10-21：按只读方式调查 GitEdge 基线 `7d5cdda82b97eb7accf46ac96ef326e98caa1fe9`、signing-center 默认分支 `d1f97fb0635ab770851e0f69bfbce8a6fe10956c` 和已确认调用方；只记录凭据名称/职责，不读取秘密值。
- 2026-10-21：响应后续架构选择，目标改为 GitEdge Actions 拥有签名策略、请求状态、传输、凭据授权与产物验证；每账户私有 Runner 仓库承载批准的非发现签名定义，专用账户 runner 执行。最终移除独立 signing-center 和 GitHub executor。
- 2026-10-21：与 account-runner-repository 设计对齐：Runner 只跑自身 personal push/manual 工作流，既有项目 CI 保持原位；跨仓 source grant 精确审计，输入为已验证 archive；同 UID broker 不满足签名密钥隔离。
- 只读方案变更：仅编辑 `docs/sign-executor-cutover.md` 与本 `/agents` 审计目录。无源代码、服务、仓库设置、凭据、runner 注册或签名请求修改；未运行测试/dispatch/deployment；提交前运行 `git diff --check`。
