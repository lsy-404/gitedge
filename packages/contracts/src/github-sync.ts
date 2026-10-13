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
export const GitHubSyncInputSchema = z.object({
  owner: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
  repository: z.string().trim().regex(/^[a-zA-Z0-9_.-]{1,100}$/).refine((s) => s !== "." && s !== ".."),
  token: z.string().min(20).max(512),
  allowVisibilityMismatch: z.boolean().default(false),
}).strict();
export type GitHubSyncInput = z.input<typeof GitHubSyncInputSchema>;
export const GitHubSyncEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export type GitHubSyncStatus = "pending" | "running" | "success" | "conflict" | "failed" | "ignored";
export interface GitHubSyncJob {
  id: string;
  direction: "inbound" | "outbound";
  event: string;
  status: GitHubSyncStatus;
  errorCode: string | null;
  attempts: number;
  createdAt: number;
  completedAt: number | null;
}
export interface GitHubSyncConnection {
  id: string;
  owner: string;
  repository: string;
  githubRepositoryId: number;
  githubUrl: string;
  enabled: boolean;
  webhookReady: boolean;
  lastSyncedAt: number | null;
  pending: number;
  conflicts: number;
  failed: number;
  createdAt: number;
}
export interface GitHubSyncState {
  connection: GitHubSyncConnection | null;
  jobs: GitHubSyncJob[];
}

export const GitHubSyncTransferSchema = z.object({
  connectionId: z.uuid(),
  jobId: z.string().min(1),
  lease: z.uuid(),
  token: z.string().min(1).max(512),
  direction: z.enum(["inbound", "outbound"]),
  ref: z.string().max(512).refine((v) => /^(refs\/(heads|tags)\/|refs\/pull\/\d+\/head$)/.test(v) && GitRefNameSchema.safeParse(v).success),
  targetRef: z.string().max(512).refine((v) => /^refs\/(heads|tags)\//.test(v) && GitRefNameSchema.safeParse(v).success),
  before: GitOidSchema.nullable(),
  after: GitOidSchema,
  pullRequestId: z.string().optional(),
}).strict();
export type GitHubSyncTransfer = z.infer<typeof GitHubSyncTransferSchema>;
export interface GitHubSyncTransferResult {
  status: "synced" | "unchanged" | "stale";
  ref: string;
  before: string;
  after: string;
}
