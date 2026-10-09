import { z } from "zod";
import { GitOidSchema } from "./forge";

export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

export const EnableAutoMergeInputSchema = z
  .object({ method: MergeMethodSchema, expectedHeadOid: GitOidSchema })
  .strict();
export type EnableAutoMergeInput = z.infer<typeof EnableAutoMergeInputSchema>;

export const AutoMergeDisabledReasons = [
  "head_changed",
  "permission_lost",
  "method_disabled",
  "merge_failed",
  "manual",
] as const;
export type AutoMergeDisabledReason = (typeof AutoMergeDisabledReasons)[number];

export const AutoMergeBlockerSchema = z.object({ code: z.string(), message: z.string() });
export type AutoMergeBlocker = z.infer<typeof AutoMergeBlockerSchema>;

export const AutoMergeStatusSchema = z.object({
  enabled: z.boolean(),
  method: MergeMethodSchema.nullable(),
  enabledBy: z.string().nullable(),
  enabledAt: z.number().nullable(),
  expectedHeadOid: z.string().nullable(),
  waitingOn: AutoMergeBlockerSchema.nullable().describe(
    "Why the pull request has not merged yet; null while the policy is satisfied or not evaluated."
  ),
});
export type AutoMergeStatus = z.infer<typeof AutoMergeStatusSchema>;

export const MERGE_QUEUE_LIMIT = 50;
export const MERGE_QUEUE_LEASE_MS = 300_000;
export const MERGE_QUEUE_MAX_ATTEMPTS = 3;

export const MergeQueueEntrySchema = z.object({
  pullRequestNumber: z.number(),
  method: MergeMethodSchema,
  enqueuedBy: z.string(),
  enqueuedAt: z.number(),
  processing: z.boolean(),
});
export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>;

export const MergeQueueStateSchema = z.object({
  baseRef: z.string(),
  entries: z.array(MergeQueueEntrySchema),
});
export type MergeQueueState = z.infer<typeof MergeQueueStateSchema>;

export const PullMergeQueueStatusSchema = z.object({
  required: z.boolean(),
  position: z
    .number()
    .nullable()
    .describe(
      "One-based place in the queue of the pull request's base branch; null when not queued."
    ),
  length: z.number(),
  processing: z.boolean(),
});
export type PullMergeQueueStatus = z.infer<typeof PullMergeQueueStatusSchema>;
