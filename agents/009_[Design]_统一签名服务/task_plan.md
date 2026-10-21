# 统一私有执行仓切换计划

- [x] 依据用户定案确定目标为保留 signing-center API，统一到 `lsy-404/signing-exec-private`。
- [x] 只读核对 signing-center 当前 public/private executor 配置、校验逻辑、三平台 workflow 和真实调用方。
- [x] 编写逐仓/逐文件切换计划、验证命令及 stop criteria；不修改代码、不执行线上切换。
- [x] 提交文档与审计记录供父任务审阅。