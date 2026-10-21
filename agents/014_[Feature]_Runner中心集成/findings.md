# Findings

- 用户已明确授权实现，顺序为特殊 Runner 仓库闭环，再签名迁移；新增定位为完全私有中心服务处理器，允许配置各种服务。
- 首期复用现有 Actions push/manual 工作流作为服务执行，不让 Runner 隐式接管其他项目 CI。
- 已创建核心、权限、界面独立工作树；签名中心源码已克隆至专属 worktree 以便复用现有成熟平台实现。
- 当前签名执行依赖 GitHub 数字 run ID、OIDC 和 executor lane；原生迁移必须删除这些执行身份依赖，保留来源证明验证。
- 常驻 HTTP/后台服务影响生命周期实现，已提前异步确认；仓库与短任务实现不依赖答案。
- 首次查询不存在的历史文件路径无改动；已按 rg --files 发现真实 common/repositories 和 forge controls 等模块。
