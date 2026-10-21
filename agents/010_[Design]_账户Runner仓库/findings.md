# 调查结论

- 账户由 `users.id` 标识；个人 namespace 有稳定 ID，但 slug 会随用户名变化。特殊仓库应以账户/namespace/repository ID 绑定，不能依赖用户名路径。
- repositories 当前只有 public/private 可见性，namespace 内 slug 唯一。`repository_paths` 保留改名前的路径，因此旧 `runner` 路径可能继续冲突。
- Forge 创建仓库负责数据库与 Git 存储；普通设置、协作者、转移、fork、软删除入口都必须识别并锁定特殊仓库。private 本身仍允许 namespace 成员和协作者，因此必须改共享授权解析为 owner-only。
- Actions 目前从运行仓库自身读取 workflow，运行记录的 repository/commit 是同一个身份。Runner 工作流触发个人源仓库时需独立保存 workflow repository/commit，并将 source/check 身份留在原字段。
- Actions job token 当前按单一 repository 授权。跨仓库只需 Runner 与源仓库的精确只读权限，不应扩为 namespace token；签名 job 不应获得源仓库写权限。
- Runner broker 的 label 不能作为签名权限。签名配置必须由签名服务信任不可变 workflow revision，并由服务端指定的独立执行 profile 运行；密钥留在签名服务。
- 同名现有仓库或保留路由必须拒绝接管。仅改名不能释放保留路由；必须由所有者显式授权释放对应 alias，同时保留原仓库数据。
- 签名调查确认原生 GitEdge job/run/lease 是执行及 callback 身份。当前缺少可信 profile 感知的入队与隔离 callback 接口，是后续实现的明确跨模块缺口。
