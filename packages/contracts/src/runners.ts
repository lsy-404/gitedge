import { z } from "zod";
import { NamespaceSlugSchema } from "./account";
import { RepositorySlugSchema } from "./repository-controls";

export const RUNNER_TOKEN_PREFIX = "ge_runner_";
export const ACTION_JOB_TOKEN_PREFIX = "ge_job_";
export const RUNNER_LEASE_MS = 120_000;
export const RUNNER_LOG_BYTES = 16_384;
export const RUNNER_CAPACITY_STALE_MS = 45_000;
export const RUNNER_OFFLINE_MS = 60_000;
export const RUNNER_PEER_SCORE_MARGIN = 5;
export const RUNNER_DEFERRAL_AGE_MS = 120_000;
export const RUNNER_FAILURE_HOLD_THRESHOLD = 3;
export const RUNNER_FAILURE_HOLD_BASE_MS = 10 * 60_000;
export const RUNNER_FAILURE_HOLD_MAX_MS = 60 * 60_000;
export const RUNNER_SAMPLE_RETENTION_MS = 24 * 60 * 60_000;
export const RUNNER_CLAIM_CANDIDATE_LIMIT = 25;
export const RUNNER_SAMPLE_CLEANUP_LIMIT = 500;

export const RunnerCapacitySchema = z
  .object({
    os: z.enum(["linux", "macos", "windows"]),
    arch: z.enum(["x64", "arm64"]),
    cpus: z.number().int().min(1).max(512),
    load1: z.number().finite().nonnegative().nullable(),
    memTotalMb: z.number().int().positive().max(1_048_576),
    memFreeMb: z.number().int().nonnegative().max(1_048_576),
    diskFreeMb: z.number().int().nonnegative().max(1_048_576_000),
    tools: z.array(z.string().trim().min(1).max(100)).max(128),
    slots: z.literal(1),
    busy: z.union([z.literal(0), z.literal(1)]),
  })
  .strict()
  .refine((capacity) => capacity.memFreeMb <= capacity.memTotalMb);
export type RunnerCapacity = z.infer<typeof RunnerCapacitySchema>;

export const RunnerBudgetSchema = z
  .object({
    maxJobMinutes: z.number().int().min(1).max(360).optional(),
    dailyMinutes: z.number().int().min(1).max(1440).optional(),
    cost: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type RunnerBudget = z.infer<typeof RunnerBudgetSchema>;

export interface JobClaim {
  labels: string[];
  memMb: number;
  cpus: number;
  diskMb: number;
  tools: string[];
  minutes: number;
  valid: boolean;
}

export const RunnerClaimInputSchema = z
  .object({
    capacity: RunnerCapacitySchema.optional(),
    budget: RunnerBudgetSchema.optional(),
  })
  .strict();
export type RunnerClaimInput = z.infer<typeof RunnerClaimInputSchema>;

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
export function isRunnerSystemLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return (
    normalized === "self-hosted" ||
    ["linux", "macos", "windows", "x64", "arm", "arm64", "amd64", "x86_64", "aarch64"].includes(
      normalized
    ) ||
    normalized.startsWith("need-")
  );
}
export const RunnerCustomLabelsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_. -]+$/)
  )
  .max(40)
  .refine((labels) => new Set(labels.map((label) => label.toLowerCase())).size === labels.length)
  .refine((labels) => labels.every((label) => !isRunnerSystemLabel(label)));
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
export type RunnerJobKind = "gitedge" | "github";
export type RunnerJobConclusion = "success" | "failure" | "cancelled" | null;
export interface RunnerOverviewRunner extends RegisteredRunner {
  state: "idle" | "busy" | "held" | "offline" | "revoked";
  capacity: RunnerCapacity | null;
  capacityReportedAt: number | null;
  budget: RunnerBudget | null;
  usedMinutes24h: number;
  heldUntil: number | null;
  consecutiveFailures: number;
  current: {
    kind: RunnerJobKind;
    id: string;
    repository: string;
    startedAt: number;
  } | null;
  stats24h: {
    success: number;
    failure: number;
    cancelled: number;
    busyMinutes: number;
  };
  samples: Array<{
    minute: number;
    load1: number | null;
    memFreeMb: number | null;
    busy: boolean;
  }>;
}
export interface RunnerOverviewGithubConnection {
  connectionId: string;
  repository: string;
  remote: string;
  enabled: boolean;
  runnerEnabled: boolean;
  errorCode: string | null;
  failureCount: number;
  lastSyncedAt: number | null;
  queued: number;
  oldestQueuedAt: number | null;
  pendingCleanup: number;
  lastJobAt: number | null;
}
export interface RunnerOverviewQueueItem {
  kind: RunnerJobKind;
  id: string;
  repository: string;
  labels: string[];
  claim: JobClaim;
  createdAt: number;
  blockedBy: Record<string, string[]>;
}
export interface RunnerOverview {
  generatedAt: number;
  runners: RunnerOverviewRunner[];
  github: RunnerOverviewGithubConnection[];
  queue: RunnerOverviewQueueItem[];
  truncated: boolean;
}
export interface RunnerHistoryItem {
  kind: RunnerJobKind;
  id: string;
  runnerId: string | null;
  repository: string;
  labels: string[];
  startedAt: number | null;
  completedAt: number | null;
  conclusion: RunnerJobConclusion;
  durationMs: number | null;
}
export interface RunnerHistory {
  items: RunnerHistoryItem[];
  nextBefore: string | null;
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
