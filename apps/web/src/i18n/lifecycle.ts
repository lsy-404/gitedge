export default {
  "zh-CN": {
    typeToConfirmPrompt: "输入 {name} 以确认",
    lifecycleTransferTitle: "转移仓库",
    lifecycleTransferHint:
      "把仓库转移到你拥有的账户或组织。旧地址与 Git 远端会自动跳转；原归属的成员将失去继承的访问权，智能体会话会被撤销。",
    lifecycleTransferTarget: "新所有者",
    lifecycleTransferNoTargets: "没有可转移的目标：你需要另一个拥有所有者权限的账户或组织。",
    lifecycleTransferAction: "转移…",
    lifecycleTransferConfirm: "转移到 {owner}",
    lifecycleTransferForbidden: "只有当前所有者可以转移仓库，且目标必须是你拥有的账户或组织。",
    lifecycleTransferConflict: "目标已有同名仓库或保留了该名称，无法转移。",
    lifecycleDeleteTitle: "删除仓库",
    lifecycleDeleteHint:
      "仓库会立即不可访问，并在 7 天内保留于“最近删除”，期间可恢复；之后将永久清除代码、协作记录与凭证。",
    lifecycleDeleteAction: "删除此仓库",
    lifecycleDeletedTitle: "最近删除",
    lifecycleDeletedHint: "宽限期内可恢复已删除的仓库，到期后将被永久清除。",
    lifecycleDeletedUntil: "可恢复至 {date}",
    lifecycleDeletedPurging: "正在永久清除，已无法恢复",
    lifecycleRestore: "恢复",
    lifecycleRestorePrompt: "确定恢复此仓库？",
    lifecyclePurgeNow: "立即永久删除",
    lifecycleRestoreConflict: "无法恢复：同名仓库已存在，或恢复期已结束。",
    organizationDeleteHint:
      "删除组织会移除所有成员关系。组织下不能有任何仓库，已删除的仓库需等待清除（或在“最近删除”中立即清除）。",
    organizationDeleteAction: "删除此组织",
    organizationDeleteBlocked: "组织下仍有仓库。请先转移或删除所有仓库，并等待已删除的仓库被清除。",
  },
  en: {
    typeToConfirmPrompt: "Type {name} to confirm",
    lifecycleTransferTitle: "Transfer repository",
    lifecycleTransferHint:
      "Move the repository to an account or organization you own. Old URLs and Git remotes redirect automatically; members of the previous owner lose inherited access and agent sessions are revoked.",
    lifecycleTransferTarget: "New owner",
    lifecycleTransferNoTargets:
      "No transfer target is available: you need another account or organization you own.",
    lifecycleTransferAction: "Transfer…",
    lifecycleTransferConfirm: "Transfer to {owner}",
    lifecycleTransferForbidden:
      "Only the current owner can transfer a repository, and the target must be an account or organization you own.",
    lifecycleTransferConflict:
      "The target already has a repository with this name or has reserved it.",
    lifecycleDeleteTitle: "Delete repository",
    lifecycleDeleteHint:
      "The repository becomes unavailable immediately and stays restorable under Recently deleted for 7 days. After that its code, collaboration records and credentials are permanently removed.",
    lifecycleDeleteAction: "Delete this repository",
    lifecycleDeletedTitle: "Recently deleted",
    lifecycleDeletedHint:
      "Restore a deleted repository during its grace period; afterwards it is permanently purged.",
    lifecycleDeletedUntil: "Restorable until {date}",
    lifecycleDeletedPurging: "Being permanently purged; it can no longer be restored",
    lifecycleRestore: "Restore",
    lifecycleRestorePrompt: "Restore this repository?",
    lifecyclePurgeNow: "Delete permanently now",
    lifecycleRestoreConflict:
      "Cannot restore: another repository uses this name, or the restore window has closed.",
    organizationDeleteHint:
      "Deleting an organization removes all memberships. It must hold no repositories; deleted repositories must be purged first (or purged now under Recently deleted).",
    organizationDeleteAction: "Delete this organization",
    organizationDeleteBlocked:
      "The organization still has repositories. Transfer or delete them all and wait for deleted repositories to be purged.",
  },
};
