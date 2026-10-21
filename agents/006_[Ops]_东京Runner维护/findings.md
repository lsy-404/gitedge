# Findings
- 用户确认专职runner为tokyo-amd64-02；01未安装runner。两台均Ubuntu24.04Minimal、954MiB内存、48GiB磁盘，操作前无swap，现均8GiB。
- 02 profile budget为maxJobMinutes60/dailyMinutes240/cost10。清除时限并保留cost10，可通过下次完整budget上报替换服务端JSON，不需要扩大API或绕过注册。
- OCI官方当前空闲规则为七天窗口CPU95分位低于20%、网络低于20%，A1另有内存低于20%；主动负载只能降低当前规则下的空闲风险，不承诺永久不回收。
- 用户确认签名完全迁移GitEdge account runner，并设计每账户唯一、身份与私有属性锁定的Runner仓库；当前输出设计，不删除仍在使用的签名凭据或仓库。
- `runner-host-setup.sh` 保留现有至少8GiB swap；不足时检查12GiB可用后新增8GiB文件，权限0600并写fstab。默认journald持久128MiB/运行32MiB/7天。
- 东京专用空闲负载每小时8分钟，CPUQuota60%单CPU、Nice19/CPUWeight1/32MiB上限；执行槽锁存在时暂停openssl进程。远程验证先TN暂停，释放锁后RN恢复。网络申领期间同样暂停。
- 02已安全取得共享执行槽、停broker、更新受限profile为budget cost10、安装客户端后重启；D1实时查询确认budget_json只有cost10，heartbeat新鲜，服务active且NRestarts0。
- 日志清理覆盖broker/profile/shared-actions已结束目录，7天/合计1GiB，每小时扫描且持有共享执行锁；保留credentials/runtime。修复自定义state与祖先symlink路径，6项新增测试及相关44项测试通过。
- 官方来源：https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm 。空闲策略不能保证不回收；swap不计入物理内存容量。
