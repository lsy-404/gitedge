import picomatch from "picomatch";
import { z } from "zod";
import type { BranchProtectionRule } from "../../../packages/contracts/src/repository-controls";
interface RuleRow {
  id: string;
  target: BranchProtectionRule["target"];
  pattern: string;
  enabled: number;
  locked: number;
  requiredApprovals: number;
  requirePassingChecks: number;
  requiredStatusChecks: string;
  requireLinearHistory: number;
  requireSignedCommits: number;
  requireConversationResolution: number;
  requireMergeQueue: number;
  requireIndependentApproval: number;
  forbidTagUpdate: number;
  forbidTagDeletion: number;
  createdAt: number;
  updatedAt: number;
}
export async function branchRules(
  db: D1Database,
  repositoryId: string
): Promise<BranchProtectionRule[]> {
  const rows = await db
    .prepare(
      "SELECT id,target,pattern,enabled,locked,required_approvals AS requiredApprovals,require_passing_checks AS requirePassingChecks,required_status_checks AS requiredStatusChecks,require_linear_history AS requireLinearHistory,require_signed_commits AS requireSignedCommits,require_conversation_resolution AS requireConversationResolution,require_merge_queue AS requireMergeQueue,require_independent_approval AS requireIndependentApproval,forbid_tag_update AS forbidTagUpdate,forbid_tag_deletion AS forbidTagDeletion,created_at AS createdAt,updated_at AS updatedAt FROM repository_branch_rules WHERE repository_id = ? ORDER BY created_at,id LIMIT 101"
    )
    .bind(repositoryId)
    .all<RuleRow>();
  if (rows.results.length > 100) throw new Error("Branch rule limit exceeded.");
  return rows.results.map((row) => ({
    ...row,
    enabled: row.enabled === 1,
    locked: row.locked === 1,
    requirePassingChecks: row.requirePassingChecks === 1,
    requireLinearHistory: row.requireLinearHistory === 1,
    requireSignedCommits: row.requireSignedCommits === 1,
    requireConversationResolution: row.requireConversationResolution === 1,
    requireMergeQueue: row.requireMergeQueue === 1,
    requireIndependentApproval: row.requireIndependentApproval === 1,
    forbidTagUpdate: row.forbidTagUpdate === 1,
    forbidTagDeletion: row.forbidTagDeletion === 1,
    requiredStatusChecks: z.array(z.string()).parse(JSON.parse(row.requiredStatusChecks)),
  }));
}
function matchingRules(
  rules: BranchProtectionRule[],
  target: BranchProtectionRule["target"],
  name: string
): BranchProtectionRule[] {
  return rules.filter(
    (rule) =>
      rule.enabled &&
      rule.target === target &&
      picomatch.isMatch(name, rule.pattern, { dot: true, nonegate: true, noext: true })
  );
}
export function matchingBranchRules(
  rules: BranchProtectionRule[],
  branch: string
): BranchProtectionRule[] {
  return matchingRules(rules, "branch", branch);
}
export function matchingTagRules(
  rules: BranchProtectionRule[],
  tag: string
): BranchProtectionRule[] {
  return matchingRules(rules, "tag", tag);
}
/** Whether a protected tag rule forbids moving (`update`) or removing (`delete`) the tag. */
export function tagChangeForbidden(
  rules: BranchProtectionRule[],
  tag: string,
  change: "update" | "delete"
): boolean {
  return matchingTagRules(rules, tag).some((rule) =>
    change === "update" ? rule.forbidTagUpdate : rule.forbidTagDeletion
  );
}
/** Refs under this prefix belong to the server and are never writable by clients. */
export const RESERVED_REF_PREFIX = "refs/gitedge/";
export function reservedRef(ref: string): boolean {
  return ref.startsWith(RESERVED_REF_PREFIX);
}
export async function protectedBranch(
  db: D1Database,
  repositoryId: string,
  branch: string
): Promise<boolean> {
  return matchingBranchRules(await branchRules(db, repositoryId), branch).length > 0;
}
