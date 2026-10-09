/** Merge-policy error codes Forge reports that have a `mergeError_<code>` message. */
export const mergePolicyCodes = [
  "changes_requested",
  "approvals_required",
  "checks_incomplete",
  "checks_required",
  "required_checks_missing",
  "threads_unresolved",
  "protected_branch",
  "repository_readonly",
  "merge_method_disabled",
] as const;
export type MergePolicyCode = (typeof mergePolicyCodes)[number];

export function mergePolicyCode(code: string | null | undefined): MergePolicyCode | null {
  return mergePolicyCodes.find((candidate) => candidate === code) ?? null;
}
