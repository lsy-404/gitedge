import { z } from "zod";
import { NamespaceSlugSchema } from "./account";
import { RepositorySlugSchema } from "./repository-controls";

export const RUNNER_TOKEN_PREFIX = "ge_runner_";
export const ACTION_JOB_TOKEN_PREFIX = "ge_job_";
export const RUNNER_LEASE_MS = 120_000;
export const RUNNER_LOG_BYTES = 16_384;

export const RunnerScopeSchema = z
  .object({
    owner: NamespaceSlugSchema,
    repository: RepositorySlugSchema.optional(),
  })
  .strict();
export const RunnerLabelsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_. -]+$/)
  )
  .min(1)
  .max(40)
  .refine((labels) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length);
export const RegisterRunnerInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scope: RunnerScopeSchema,
    labels: RunnerLabelsSchema,
  })
  .strict();
export type RegisterRunnerInput = z.infer<typeof RegisterRunnerInputSchema>;
export type RunnerScope = z.infer<typeof RunnerScopeSchema>;
export interface RegisteredRunner {
  id: string;
  name: string;
  scope: RunnerScope;
  labels: string[];
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}
export const ActionJobIdentitySchema = z.object({
  runId: z.string().min(1),
  repositoryId: z.string().min(1),
  commitOid: z.string().regex(/^[0-9a-f]{40}$/),
});
export type ActionJobIdentity = z.infer<typeof ActionJobIdentitySchema>;
export const RunnerLeaseInputSchema = z
  .object({
    runId: z.string().uuid(),
    leaseToken: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const RunnerCompleteInputSchema = RunnerLeaseInputSchema.extend({
  conclusion: z.enum(["success", "failure", "cancelled"]),
  log: z.string().max(RUNNER_LOG_BYTES),
}).strict();

export const GitHubRunnerWebhookSchema = z.object({
  action: z.enum(["queued", "in_progress", "completed"]),
  workflow_job: z.object({
    id: z.number().int().positive(),
    run_id: z.number().int().positive(),
    head_sha: z.string().regex(/^[0-9a-f]{40}$/),
    labels: z.array(z.string().min(1).max(100)).max(40),
  }),
});
export const GitHubRunnerDemandSchema = GitHubRunnerWebhookSchema.extend({
  connectionId: z.uuid(),
});
export const GitHubRunnerOperationSchema = z
  .object({
    operation: z.enum(["start", "status", "cleanup"]),
    id: z.uuid(),
  })
  .strict();

export interface GitHubRunnerJobRecord {
  id: string;
  connection_id: string;
  github_job_id: number;
  github_run_id: number;
  head_oid: string;
  labels_json: string;
  status: "queued" | "running" | "completed";
  runner_id: string | null;
  github_runner_id: number | null;
  lease_hash: string | null;
  lease_expires_at: number | null;
  assigned: number;
  cleanup_pending: number;
  conclusion: "success" | "failure" | "cancelled" | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}
