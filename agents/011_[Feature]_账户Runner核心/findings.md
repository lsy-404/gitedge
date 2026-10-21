# Findings

- 设计要求每个个人 namespace 最多一个私有 `runner`，稳定身份由账户、namespace 和 repository ID 构成；历史 `repository_paths` slug 保留，不能被覆盖。
- GET/POST contract 暂定 GET `{ repository: Repository | null }`，POST 成功直接返回 `Repository`，与现有 repository 创建 API 实体响应保持一致；已向主线程建议确认。
- `RepositorySchema` 当前是共享契约；`repoResponse` 是实体序列化集中点。`RepositoryRow` SQL 查询普遍使用 `r.*`，kind 字段可选以兼容特殊查询。
- Cloudflare D1 写入采用 prepared statements；可用 batch 原子执行数据库语句。D1 不包含 Artifact/Git side effects，因此跨服务失败边界需保留 pending 并显式返回 503，不能清理其他请求创建的资源。
- Migration 0048 加 partial unique index 与 insert/update triggers，固定 Runner 的 owner、personal namespace、slug、private visibility；history path 保留表与活跃 import 表分别参与拒绝接管，并以触发器封住 import/provision 双向竞态。
- Actions workflow 仅 `workflow_dispatch`，用 `self-hosted`, `need-tool-node`, `need-time-5m` 通用标签；模板由运行时 `parseRunnerWorkflow` 解析通过。
- Git 文件初始化先读取 main ref 并以其当前 OID 作 compare-and-swap；并发重复请求只在文件已存在时接受 Git 409，避免重复提交和无头覆盖。
- 首轮测试暴露空 POST 体被误当作 JSON null（400），改为区分空体与非空 JSON；另修复测试 Git 服务对 `/repositories/:id/...` 路径段的解析。最终针对性 Worker suite 通过。
