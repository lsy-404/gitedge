import picomatch from "picomatch";
import { z } from "zod";
import type { BranchProtectionRule } from "../../../packages/contracts/src/repository-controls";
interface RuleRow {
  id: string;
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
  createdAt: number;
  updatedAt: number;
}
export async function branchRules(
  db: D1Database,
  repositoryId: string
): Promise<BranchProtectionRule[]> {
  const rows = await db
    .prepare(
      "SELECT id,pattern,enabled,locked,required_approvals AS requiredApprovals,require_passing_checks AS requirePassingChecks,required_status_checks AS requiredStatusChecks,require_linear_history AS requireLinearHistory,require_signed_commits AS requireSignedCommits,require_conversation_resolution AS requireConversationResolution,require_merge_queue AS requireMergeQueue,created_at AS createdAt,updated_at AS updatedAt FROM repository_branch_rules WHERE repository_id = ? ORDER BY created_at,id LIMIT 101"
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
    requiredStatusChecks: z.array(z.string()).parse(JSON.parse(row.requiredStatusChecks)),
  }));
}
export function matchingBranchRules(
  rules: BranchProtectionRule[],
  branch: string
): BranchProtectionRule[] {
  return rules.filter(
    (rule) =>
      rule.enabled &&
      picomatch.isMatch(branch, rule.pattern, { dot: true, nonegate: true, noext: true })
  );
}
export async function protectedBranch(
  db: D1Database,
  repositoryId: string,
  branch: string
): Promise<boolean> {
  return matchingBranchRules(await branchRules(db, repositoryId), branch).length > 0;
}
