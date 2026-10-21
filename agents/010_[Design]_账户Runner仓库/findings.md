# 调查结论

- 账户由 `users.id` 标识；个人 namespace 有稳定 ID，但 slug 会随用户名变化。特殊仓库应以账户/namespace/repository ID 绑定，不能依赖用户名路径。
- repositories 当前只有 public/private 可见性，namespace 内 slug 唯一。`repository_paths` 保留改名前的路径，因此旧 `runner` 路径可能继续冲突。
- Forge 创建仓库负责数据库与 Git 存储；普通设置、协作者、转移、fork、软删除入口都必须识别并锁定特殊仓库。private 本身仍允许 namespace 成员和协作者，因此必须改共享授权解析为 owner-only。
- Actions 当前从运行仓库自身读取 workflow，运行记录的 repository/commit 是同一身份。首期仅运行 Runner 自身 push/manual workflow；其他个人仓库现有工作流保持原位，不做隐式 fanout 或替换。
- Actions job token 当前按单一 repository 授权，同仓作业继续沿用。只有显式授权的跨仓任务才需记录 workflow/source 仓库与 immutable commit，并获可审计的精确资源/操作 scope；签名源使用已校验归档，不执行不可信 source workflow。
- Runner broker 的 label 不能作为签名权限。签名 profile 绑定不可变 workflow revision，并由服务端指定的独立 account runner 执行。专用受信进程按需短期取得材料，在临时 keychain/文件供平台签名工具使用并清理；不承诺 Apple key 不会到达 runner host，也不保留外部 signing service。
- 同名现有仓库或保留路由必须拒绝接管。仅改名不能释放保留路由；必须由所有者显式授权释放对应 alias，同时保留原仓库数据。
- 签名调查确认原生 GitEdge job/run/lease 是执行及 callback 身份。当前缺少可信 profile 感知的入队与隔离 callback 接口，是后续实现的明确跨模块缺口。
