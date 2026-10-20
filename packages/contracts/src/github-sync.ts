import { z } from "zod";
import { GitOidSchema, GitRefNameSchema } from "./forge";

export const GitHubSyncEvents = [
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;
export type GitHubSyncEvent = (typeof GitHubSyncEvents)[number];
export const GitHubSyncInputSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    repository: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_.-]{1,100}$/)
      .refine((s) => s !== "." && s !== ".."),
    token: z.string().min(20).max(512),
    allowVisibilityMismatch: z.boolean().default(false),
  })
  .strict();
export type GitHubSyncInput = z.input<typeof GitHubSyncInputSchema>;
export const GitHubSyncEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const GitHubSyncStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "conflict",
  "failed",
  "ignored",
]);
export type GitHubSyncStatus = z.infer<typeof GitHubSyncStatusSchema>;
export const GitHubSyncJobSchema = z.object({
  id: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  event: z.string(),
  status: GitHubSyncStatusSchema,
  errorCode: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
});
export type GitHubSyncJob = z.infer<typeof GitHubSyncJobSchema>;
export const GitHubSyncConnectionSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repository: z.string(),
  githubRepositoryId: z.number().int().positive(),
  githubUrl: z.url(),
  enabled: z.boolean(),
  runnerEnabled: z.boolean(),
  webhookReady: z.boolean(),
  errorCode: z.string().nullable(),
  lastSyncedAt: z.number().nullable(),
  pending: z.number().int(),
  conflicts: z.number().int(),
  failed: z.number().int(),
  createdAt: z.number(),
});
export type GitHubSyncConnection = z.infer<typeof GitHubSyncConnectionSchema>;
export const GitHubSyncStateSchema = z.object({
  connection: GitHubSyncConnectionSchema.nullable(),
  jobs: z.array(GitHubSyncJobSchema).max(50),
});
export type GitHubSyncState = z.infer<typeof GitHubSyncStateSchema>;

export const GitHubSyncTransferSchema = z
  .object({
    connectionId: z.uuid(),
    jobId: z.string().min(1),
    lease: z.uuid(),
    token: z.string().min(1).max(512),
    direction: z.enum(["inbound", "outbound"]),
    ref: z
      .string()
      .max(512)
      .refine(
        (v) =>
          /^(refs\/(heads|tags)\/|refs\/pull\/\d+\/head$)/.test(v) &&
          GitRefNameSchema.safeParse(v).success
      ),
    targetRef: z
      .string()
      .max(512)
      .refine((v) => /^refs\/(heads|tags)\//.test(v) && GitRefNameSchema.safeParse(v).success),
    before: GitOidSchema.nullable(),
    after: GitOidSchema,
    pullRequestId: z.string().optional(),
  })
  .strict();
export type GitHubSyncTransfer = z.infer<typeof GitHubSyncTransferSchema>;
export interface GitHubSyncTransferResult {
  status: "synced" | "unchanged" | "stale";
  ref: string;
  before: string;
  after: string;
}
