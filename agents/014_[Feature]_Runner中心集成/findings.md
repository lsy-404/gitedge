# Findings

- 用户已明确授权实现，顺序为特殊 Runner 仓库闭环，再签名迁移；新增定位为完全私有中心服务处理器，允许配置各种服务。
- 首期复用现有 Actions push/manual 工作流作为服务执行，不让 Runner 隐式接管其他项目 CI。
- 已创建核心、权限、界面独立工作树；签名中心源码已克隆至专属 worktree 以便复用现有成熟平台实现。
- 当前签名执行依赖 GitHub 数字 run ID、OIDC 和 executor lane；原生迁移必须删除这些执行身份依赖，保留来源证明验证。
- 常驻 HTTP/后台服务影响生命周期实现，已提前异步确认；仓库与短任务实现不依赖答案。
- 用户确认先仅按需工作流并追加cron；服务配置即私有Runner内的workflow定义。签名迁移后续采用相同account runner执行，但保持批准配置/机器用途/凭据隔离。
- 本地unit整体新增4项失败来自旧SQL mock精确匹配CASE WHEN m.role，真实D1权限测试通过；更新fixture识别稳定role投影后5个Actions service测试均通过，不削弱断言。剩余Git transfer截断上游测试为既有Windows基线。
- 一次Cloudflare D1查询7403，经whoami核实正确账户与scope，后续相同只读查询成功；不需要新增权限或替换凭据。
- 首次查询不存在的历史文件路径无改动；已按 rg --files 发现真实 common/repositories 和 forge controls 等模块。

- Existing ordinary broker configuration can be explicitly updated to executionClass=ordinary after verifying its server registration. This adds no signing authority and avoids revoking a valid ordinary identity merely to add local configuration; missing fields still fail closed at runtime. Production strict checks remain gated on all existing brokers being upgraded.
