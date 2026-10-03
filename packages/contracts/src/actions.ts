import { z } from "zod";

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
});
export type ActionJob = z.infer<typeof ActionJobSchema>;

export const ActionWorkflowSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(100),
  triggers: z.array(z.enum(["workflow_dispatch", "push"])).min(1),
  jobs: z.array(ActionJobSchema).min(1).max(3),
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
  readonly jobs: readonly ActionRunJob[];
}

export interface CreateActionRunInput {
  readonly workflowPath: string;
  readonly ref: string;
  readonly expectedOid: string;
}

export interface ActionRunSummary {
  readonly id: string;
  readonly commitOid: string;
  readonly workflowPath: string;
  readonly workflowName: string;
  readonly ref: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly status: ActionRunStatus;
  readonly conclusion: ActionRunConclusion;
}
