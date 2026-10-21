# 账户 Runner 仓库设计

## 目标

定义每账户唯一、锁定身份的私有 Runner 仓库，覆盖仓库生命周期、个人工作流触发、跨仓库授权与签名信任边界。

## 步骤

- [x] 审查账号/namespace/repository 数据模型与生命周期。
- [x] 审查 Actions 工作流来源、runner broker、job token 与可见性。
- [x] 对齐签名服务的原生 job/run/lease 身份及可信执行边界。
- [x] 写入设计文档与验收条件，提交本地分支。
