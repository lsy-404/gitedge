import { z } from "zod";

export function isActionWorkflowPath(path: string): boolean {
  return /^(?:\.github|\.gitedge)\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(path);
}

const actionPath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Path must stay inside the workspace."
  );

export const ActionCacheSchema = z
  .object({
    keyFiles: z.array(actionPath).min(1).max(16),
    paths: z.array(actionPath).min(1).max(16),
  })
  .strict();
export type ActionCache = z.infer<typeof ActionCacheSchema>;

export const ActionArtifactSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/)
      .refine((name) => name !== "cache"),
    paths: z.array(actionPath).min(1).max(16),
  })
  .strict();
export type ActionArtifact = z.infer<typeof ActionArtifactSchema>;

export const ActionEventTypeSchema = z.enum([
  "push",
  "workflow_dispatch",
  "pull_request",
  "merge_group",
  "schedule",
]);
export type ActionEventType = z.infer<typeof ActionEventTypeSchema>;

const branchPattern = z
  .string()
  .min(1)
  .max(256)
  .refine((pattern) => pattern !== "!", "Branch exclusion needs a pattern.");

export const ActionTriggerFilterSchema = z
  .object({
    branches: z.array(branchPattern).max(32).optional(),
    branchesIgnore: z.array(branchPattern).max(32).optional(),
  })
  .strict();
export type ActionTriggerFilters = Partial<
  Record<ActionEventType, z.infer<typeof ActionTriggerFilterSchema>>
>;

export const ActionStepSchema = z.object({
  name: z.string().min(1).max(100),
  run: z.string().min(1).max(16_384),
  shell: z.enum(["sh", "bash"]),
  workingDirectory: z.string().nullable(),
  env: z.record(z.string(), z.string()),
});
export type ActionStep = z.infer<typeof ActionStepSchema>;

export const ActionJobSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  steps: z.array(ActionStepSchema).min(1).max(10),
  artifacts: z.array(ActionArtifactSchema).max(10).optional(),
});
export type ActionJob = z.infer<typeof ActionJobSchema>;

export const ActionDispatchInputSchema = z
  .object({
    description: z.string().max(1000).optional(),
    required: z.boolean().optional(),
    default: z.union([z.string().max(2000), z.boolean(), z.number()]).optional(),
    type: z.enum(["string", "boolean", "number", "choice"]).optional(),
    options: z.array(z.string().max(2000)).min(1).max(100).optional(),
  })
  .strict()
  .refine((input) => {
    const type = input.type ?? "string";
    if (type === "choice" && !input.options) return false;
    if (input.default === undefined) return true;
    if (type === "boolean") return typeof input.default === "boolean";
    if (type === "number") return typeof input.default === "number";
    return (
      typeof input.default === "string" &&
      (type !== "choice" || input.options?.includes(input.default) === true)
    );
  }, "Dispatch input options or default do not match its type.");
export type ActionDispatchInput = z.infer<typeof ActionDispatchInputSchema>;

export const ActionWorkflowSchema = z.object({
  executor: z.enum(["container", "runner"]).optional(),
  dispatchInputs: z.record(z.string(), ActionDispatchInputSchema).optional(),
  path: z.string().min(1),
  name: z.string().min(1).max(100),
  triggers: z.array(ActionEventTypeSchema).min(1),
  schedules: z.array(z.string().min(1).max(128)).max(5).optional(),
  triggerFilters: z.partialRecord(ActionEventTypeSchema, ActionTriggerFilterSchema).optional(),
  jobs: z.array(ActionJobSchema).max(16),
  cache: ActionCacheSchema.optional(),
  supported: z.boolean().optional(),
  unsupportedReason: z.string().optional(),
});
export type ActionWorkflow = z.infer<typeof ActionWorkflowSchema>;

export type ActionWorkflowFile = ActionWorkflow & {
  readonly supported: boolean;
  readonly unsupportedReason?: string;
};

export type ActionRunStatus = "queued" | "running" | "completed";
export type ActionRunConclusion = "success" | "failure" | "cancelled" | null;

export interface ActionRunStep {
  readonly name: string;
  readonly status: "queued" | "running" | "completed";
  readonly conclusion: ActionRunConclusion;
  readonly exitCode: number | null;
  readonly log: string;
  readonly outputTruncated: boolean;
}

export interface ActionRunJob {
  readonly id: string;
  readonly name: string;
  readonly status: "queued" | "running" | "completed";
  readonly conclusion: ActionRunConclusion;
  readonly steps: readonly ActionRunStep[];
}

export interface ActionRun {
  readonly executor?: "container" | "runner";
  readonly id: string;
  readonly repositoryId: string;
  readonly commitOid: string;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly ref: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly status: ActionRunStatus;
  readonly conclusion: ActionRunConclusion;
  readonly outputTruncated: boolean;
  readonly eventType: ActionEventType;
  readonly cacheOutcome: ActionCacheOutcome;
  readonly artifacts: readonly ActionRunArtifact[];
  readonly artifactOutcomes: readonly ActionArtifactOutcome[];
  readonly jobs: readonly ActionRunJob[];
}

export type ActionCacheOutcome = "disabled" | "miss" | "hit" | "saved" | "failed";

export interface ActionRunArtifact {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly downloadUrl: string;
  readonly createdAt: number;
}

export interface ActionArtifactOutcome {
  readonly name: string;
  readonly status: "pending" | "ready" | "failed" | "skipped";
  readonly message: string | null;
}

export interface CreateActionRunInput {
  readonly inputs?: Readonly<Record<string, string | number | boolean>>;
  readonly workflowPath: string;
  readonly ref: string;
  readonly expectedOid: string;
}

export interface ActionRunSummary {
  readonly executor?: "container" | "runner";
  readonly id: string;
  readonly commitOid: string;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly ref: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly status: ActionRunStatus;
  readonly conclusion: ActionRunConclusion;
  readonly cacheOutcome: ActionCacheOutcome;
  readonly artifactCount: number;
}
