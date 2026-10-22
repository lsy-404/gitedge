# GitEdge
> 最后更新：2026-10-22

## 项目目标
已接入东京 Linux x64 runner、主机维护和设备接入指令。每账户私有 Runner 仓库、owner-only及不可变身份、任务服务页面和UTC cron已部署，真实手动/定时任务均通过东京节点执行。原生签名的审批profile、来源授权、通用runner任务级secret和平台租约流程已部署；生产profile仍为空，尚无真实证书签名回执。GitHub签名工作流继续通过通用runner及其环境secret运行。技术栈及边界遵循 AGENTS.md / PRODUCT.md。

## 执行依据
设计提交 5697d93。用户明确要求按此执行，稿内 D1 正向变更与旧 broker 规则均为本次已授权要求。

## 当前执行主机
Mac保留1个普通broker，Windows更新为2个独立普通broker；真实Windows任务已同时成功执行，旧普通runner注册已退役，旧Windows独立签名runner已停用并删除注册，两个通用Windows broker保留原工作流路由标签。主机接入见019.md，通用签名迁移及环境修复见021.md。
