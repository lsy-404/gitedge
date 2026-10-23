# GitEdge
> 最后更新：2026-10-23

## 项目目标
已接入东京 Linux runner、Mac 和 Windows 普通构建 runner。每账户私有 Runner 仓库、owner-only及不可变身份、任务服务页面和UTC cron已部署。十一份生产签名profile与加密凭据已配置；iOS完整IPA验签、Windows生产签名与独立Authenticode/时间戳、macOS签名公证与独立分发检查均通过。旧入口、Cron、旧webhook已停用，IRIS-Build及两个旧签名执行仓库已归档，历史存储保留。五台broker支持账户管理的自定义标签，沿用GitHub runs-on数组AND匹配，动态标签排队到领取的真实验证通过。技术栈及边界遵循 AGENTS.md / PRODUCT.md。

## 执行依据
设计提交 5697d93。用户明确要求按此执行，稿内 D1 正向变更与旧 broker 规则均为本次已授权要求。

## 当前执行主机
Mac保留1个普通broker，Windows更新为2个独立普通broker；真实Windows任务已同时成功执行，旧普通runner注册已退役，旧Windows独立签名runner已停用并删除注册，两个通用Windows broker保留原工作流路由标签。IRIS四平台reader与ARM Core发布已通过，Core 26.1022.23及Web UI已发布。主机接入见019.md，通用签名迁移及环境修复见021.md。

## 个人主页与双向同步
- 个人主页使用 Forge 公开资料与现有协作记录，客户端与服务端共用契约，持续排除私有和系统仓库。
- GitHub 引用同步使用共同成功状态判断单边变化与删除，并在双方分歧时保留冲突供人工处理。
- 本次集成使用隔离 worktree 与独立本地 D1；原有工作目录保持不变。
