import { z } from "zod";
import { GitOidSchema } from "./forge";

export const MERGE_REVIEW_LIMIT = 1000;
export const MERGE_CHECK_LIMIT = 100;

export const MergeRequirementIds = [
  "repository_open",
  "pull_open",
  "ready_for_review",
  "merge_method",
  "branch_unlocked",
  "conversations_resolved",
  "no_changes_requested",
  "approvals",
  "checks_complete",
  "passing_check",
  "required_checks",
  "merge_queue",
  "current_head",
  "linear_history",
  "signed_commits",
  "no_conflicts",
] as const;
export const MergeRequirementIdSchema = z.enum(MergeRequirementIds);
export type MergeRequirementId = z.infer<typeof MergeRequirementIdSchema>;

export const MergeRequirementStatusSchema = z
  .enum(["satisfied", "unsatisfied", "not_applicable", "checked_at_merge", "unavailable"])
  .describe(
    "`checked_at_merge` requirements are evaluated by Git when the merge runs and are never reported as satisfied beforehand."
  );
export type MergeRequirementStatus = z.infer<typeof MergeRequirementStatusSchema>;

export const MergeRequirementSchema = z.object({
  id: MergeRequirementIdSchema,
  status: MergeRequirementStatusSchema,
  detail: z.string().describe("Short English explanation of the current state."),
  actualCount: z.number().int().nonnegative().optional(),
  requiredCount: z.number().int().nonnegative().optional(),
  blockerCode: z.string().optional(),
});
export type MergeRequirement = z.infer<typeof MergeRequirementSchema>;

export const ExcludedApprovalReasonSchema = z.enum([
  "author",
  "agent_owner",
  "task_requester",
  "last_pusher",
]);
export type ExcludedApprovalReason = z.infer<typeof ExcludedApprovalReasonSchema>;

export const ExcludedApprovalSchema = z.object({
  name: z.string(),
  reason: ExcludedApprovalReasonSchema,
});
export type ExcludedApproval = z.infer<typeof ExcludedApprovalSchema>;

export const MergeRequirementsSchema = z.object({
  headOid: GitOidSchema,
  ready: z
    .boolean()
    .describe("True when no requirement is unsatisfied; Git may still refuse at merge time."),
  requirements: z.array(MergeRequirementSchema),
  excludedApprovals: z
    .array(ExcludedApprovalSchema)
    .describe("Approvals on the head that do not count toward the required approvals."),
});
export type MergeRequirements = z.infer<typeof MergeRequirementsSchema>;

export const MergeRequirementsQuerySchema = z.object({
  headOid: GitOidSchema.optional(),
  method: z.enum(["merge", "squash", "rebase"]).optional(),
});
