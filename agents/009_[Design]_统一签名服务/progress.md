# 操作记录

- 2026-10-21：读取 agent-mode、AGENTS.md、项目索引和任务索引；在 `codex/sign-service-planning` 的 `7d5cdda82b97eb7accf46ac96ef326e98caa1fe9` 基线上只读调查。
- 2026-10-21：核对 signing-center 的 macOS/Windows/iOS executor config、submission/snapshot/runner 校验、管理响应和请求表格；核对 signing-exec-private 三平台 workflow 当前 pin 与 host class。
- 2026-10-21：确认调用端为 IRIS-Build、Epilogue、Oblivionis 的请求脚本；检索到 IRIS/Oblivionis/Epilogue 的 request body 当前分别带 public/private selector。未读取凭据值。
- 2026-10-21：按用户定案编写 `docs/sign-executor-cutover.md` 与本审计更新，覆盖冻结/排空、private-only 配置、调用方合同、旧公开执行器退役、验证门槛和 stop criteria。
- 只读计划工作：无代码修改、无测试、无 workflow dispatch、无线上配置/secret/repo改动；已运行 `git diff --check`，只提交方案与审计文件；未运行测试（不涉及代码改动）。