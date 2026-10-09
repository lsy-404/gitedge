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

export interface AutoMergeBlocker {
  code: string;
  message: string;
}

export interface AutoMergeStatus {
  enabled: boolean;
  method: MergeMethod | null;
  enabledBy: string | null;
  enabledAt: number | null;
  expectedHeadOid: string | null;
  /** Why the pull request has not merged yet; null while the policy is satisfied or not evaluated. */
  waitingOn: AutoMergeBlocker | null;
}

export const MERGE_QUEUE_LIMIT = 50;
export const MERGE_QUEUE_LEASE_MS = 300_000;
export const MERGE_QUEUE_MAX_ATTEMPTS = 3;

export interface MergeQueueEntry {
  pullRequestNumber: number;
  method: MergeMethod;
  enqueuedBy: string;
  enqueuedAt: number;
  processing: boolean;
}

export interface MergeQueueState {
  baseRef: string;
  entries: MergeQueueEntry[];
}

export interface PullMergeQueueStatus {
  required: boolean;
  /** One-based place in the queue of the pull request's base branch; null when not queued. */
  position: number | null;
  length: number;
  processing: boolean;
}
