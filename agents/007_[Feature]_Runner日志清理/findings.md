# 调研记录

- 仓库规则要求测试放在 `/test`，运行日志和决策记录放在 `/agents`。
- Broker 的全局 `active.lock` 在 `serve` 生命周期内持有；执行 slot 通过 `work/actions/active.lock` 与直接 CLI 互斥。
- 本机 GitHub runner 临时工作目录位于 profile 的 `runs/`，失败诊断位于 profile 的 `logs/`；GitEdge runner 数据位于 broker state 的 `runs/`；直接 actions CLI 日志和产物位于 `work/actions/runs/`。
- 直接 actions CLI 获得自己的 `active.lock` 后可在启动工作流前清理；broker 在其执行 slot 内已持有相同锁，可在每个轮询空闲边界清理。
- 配置/凭证在 profile 目录根部，运行时在 `work/actions/runtime/`，均不属于目标。
- 真实清理路径由 broker 的 `active.lock` 与共享 actions `active.lock` 串行化；直接 CLI 也必须持有后者才能清理和启动工作流。过期目录不会与正在执行的 broker 或直接 CLI 工作流并发删除。
- 目标根目录及每个候选项均以 `lstat` 验证；候选只允许根目录的直接子项，递归容量统计跳过符号链接，删除不跟随链接目标。
- 初次运行时依赖 junction 尚未就绪，Vitest 无法启动；依赖就绪后同一针对性套件通过（4 项）。
