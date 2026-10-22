# GitEdge
> 最后更新：2026-10-22

## 项目目标
已接入东京 Linux x64 runner、主机维护和设备接入指令。每账户私有 Runner 仓库、owner-only及不可变身份、任务服务页面和UTC cron已部署，真实手动/定时任务均通过东京节点执行。正在实现签名完全迁移 Actions：审批profile、来源授权、专用签名节点、平台工具及原生租约流程；生产凭据、主机隔离与平台canary未完成前不切断现有签名服务。技术栈及边界遵循 AGENTS.md / PRODUCT.md。

## 执行依据
设计提交 5697d93。用户明确要求按此执行，稿内 D1 正向变更与旧 broker 规则均为本次已授权要求。

## 当前执行主机
Mac保留1个普通broker，Windows更新为2个独立普通broker；真实Windows任务已同时成功执行，旧普通runner注册已退役，原有Windows签名runner保持在线。主机详情与验证回执见019.md。
