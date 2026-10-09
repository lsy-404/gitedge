import { z } from "zod";
import { RepositorySlugSchema } from "./repository-controls";
import { ActorSchema, GitBranchSchema, GitOidSchema, type Actor, type Assignee } from "./forge";

export const AGENT_MODE_VERSION = "v0.2.2";

const markdown = z.string().max(200_000);

export const TaskTypeSchema = z.string().regex(/^[A-Za-z]{2,24}$/);
export const TaskStatusSchema = z.enum(["pending", "in_progress", "done", "abandoned"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TaskDocumentKindSchema = z.enum(["plan", "findings", "progress"]);
export type TaskDocumentKind = z.infer<typeof TaskDocumentKindSchema>;
export const TaskLinkKindSchema = z.enum(["issue", "pull_request"]);
export type TaskLinkKind = z.infer<typeof TaskLinkKindSchema>;
export const TaskCommitSourceSchema = z.enum(["manual", "pull_request_merge"]);
export type TaskCommitSource = z.infer<typeof TaskCommitSourceSchema>;
export const AssignmentRoleSchema = z.enum(["assignee", "reviewer"]);
export type AssignmentRole = z.infer<typeof AssignmentRoleSchema>;
export const MemoryVisibilitySchema = z.enum(["members", "public"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibilitySchema>;
export const AgentAssignmentPolicySchema = z.enum(["owner", "members"]);
export type AgentAssignmentPolicy = z.infer<typeof AgentAssignmentPolicySchema>;

/** Writer of a memory or task document revision; `system` marks entries appended by the platform. */
export const RevisionActorSchema = z.union([
  ActorSchema,
  z.object({ kind: z.literal("system"), id: z.string().min(1), name: z.string().min(1) }),
]);
export type RevisionActor = z.infer<typeof RevisionActorSchema>;

export const SYSTEM_ACTOR: RevisionActor = { kind: "system", id: "gitedge", name: "GitEdge" };

/** A human user or an agent that can be assigned to work. */
export const AssigneeRefSchema = ActorSchema.pick({ kind: true, id: true });
export type AssigneeRef = z.infer<typeof AssigneeRefSchema>;
export interface AssigneeCandidate extends Assignee {
  /** Identifier of the agent's owner; absent for human users. */
  ownerName?: string;
}

export interface MemoryIndex {
  content: string;
  guidelineVersion: string;
  /** 0 until the first save. */
  revision: number;
  actor: RevisionActor | null;
  updatedAt: number | null;
}

export interface DocumentRevisionSummary {
  revision: number;
  actor: RevisionActor;
  size: number;
  updatedAt: number;
}

export interface TaskProgress {
  /** Linked issues and pull requests. */
  total: number;
  /** Linked issues that are closed and pull requests that are closed or merged. */
  done: number;
  /** Null when nothing is linked. */
  percent: number | null;
}

/** Time-boxed claim of a task by one agent; it expires unless heartbeats extend it. */
export interface TaskLease {
  agent: { id: string; name: string };
  claimedAt: number;
  expiresAt: number;
}

export const TASK_LEASE_DEFAULT_SECONDS = 900;
export const TASK_LEASE_MAX_SECONDS = 3_600;
/** A claim cannot be extended past this age; the agent must release and claim again. */
export const TASK_LEASE_MAX_TOTAL_MS = 8 * 3_600_000;

export interface Task {
  id: string;
  number: number;
  type: string;
  title: string;
  motivation: string;
  description: string;
  status: TaskStatus;
  assignee: Assignee | null;
  lease: TaskLease | null;
  actor: Actor;
  progress: TaskProgress;
  commitCount: number;
  createdAt: number;
  updatedAt: number;
}

/** The task an issue or pull request belongs to. */
export type TaskReference = Pick<Task, "number" | "type" | "title" | "status">;

export interface TaskDocument {
  kind: TaskDocumentKind;
  content: string;
  /** 0 until the first save. */
  revision: number;
  actor: RevisionActor;
  updatedAt: number;
}

export interface TaskLink {
  kind: TaskLinkKind;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  createdAt: number;
}

export interface TaskCommit {
  oid: string;
  ref: string;
  summary: string;
  author: string;
  boundBy: RevisionActor;
  source: TaskCommitSource;
  boundAt: number;
}

export interface TaskDetail extends Task {
  documents: Record<TaskDocumentKind, TaskDocument>;
  links: TaskLink[];
  commits: TaskCommit[];
}

export interface TaskTable {
  /** Markdown equivalent of the tasks.md table, generated from the task list. */
  markdown: string;
  guidelineVersion: string;
}

/** Present and true when agent sessions could not all be revoked after the change. */
export interface RevocationOutcome {
  revocationIncomplete?: boolean;
}

export interface CollaboratorRemoval extends RevocationOutcome {
  deleted: boolean;
}

export interface RepositorySettings {
  /** Repository display name and URL slug share one canonical value. */
  name: string;
  slug: string;
  description: string;
  visibility: "public" | "private";
  defaultBranch: string;
  archived: boolean;
  issuesEnabled: boolean;
  pullsEnabled: boolean;
  discussionsEnabled: boolean;
  wikiEnabled: boolean;
  tasksEnabled: boolean;
  agentsEnabled: boolean;
  deploymentsEnabled: boolean;
  graphEnabled: boolean;
  actionsEnabled: boolean;
  actionsNetworkEnabled: boolean;
  onlineEditingEnabled: boolean;
  allowMergeCommit: boolean;
  allowSquashMerge: boolean;
  allowRebaseMerge: boolean;
  deleteBranchOnMerge: boolean;
  requiredApprovals: number;
  requirePassingChecks: boolean;
  memoryVisibility: MemoryVisibility;
  agentAssignmentPolicy: AgentAssignmentPolicy;
  /** True when the caller may change the settings. */
  canManage: boolean;
}

export type RepositorySettingsUpdate = RepositorySettings & RevocationOutcome;

export const PutMemoryIndexInputSchema = z.object({
  content: markdown,
  guidelineVersion: z
    .string()
    .regex(/^v\d+\.\d+\.\d+$/)
    .optional(),
  expectedRevision: z.number().int().nonnegative(),
});

export const CreateTaskInputSchema = z.object({
  type: TaskTypeSchema,
  title: z.string().trim().min(1).max(200),
  motivation: z.string().max(5_000).default(""),
  description: z.string().max(20_000).default(""),
});

export const UpdateTaskInputSchema = z
  .object({
    type: TaskTypeSchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    motivation: z.string().max(5_000).optional(),
    description: z.string().max(20_000).optional(),
    status: TaskStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);

export const TaskLeaseInputSchema = z.object({
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(TASK_LEASE_MAX_SECONDS)
    .default(TASK_LEASE_DEFAULT_SECONDS),
});

export const AssignTaskInputSchema = z.object({ assignee: AssigneeRefSchema.nullable() });

export const PutTaskDocumentInputSchema = z.object({
  content: markdown,
  expectedRevision: z.number().int().nonnegative(),
});

export const AttachTaskLinkInputSchema = z.object({
  kind: TaskLinkKindSchema,
  number: z.number().int().positive(),
});

/** Moves an issue or pull request to another task, or out of its task when null. */
export const MoveTaskLinkInputSchema = z.object({ task: z.number().int().positive().nullable() });

export const BindTaskCommitInputSchema = z.object({
  oid: GitOidSchema,
  ref: GitBranchSchema,
});

export const SetAssignmentsInputSchema = z.object({
  role: AssignmentRoleSchema,
  assignees: z.array(AssigneeRefSchema).max(20),
});

export const UpdateRepositorySettingsInputSchema = z
  .object({
    name: RepositorySlugSchema.optional(),
    slug: RepositorySlugSchema.optional(),
    description: z.string().max(500).optional(),
    visibility: z.enum(["public", "private"]).optional(),
    defaultBranch: GitBranchSchema.optional(),
    archived: z.boolean().optional(),
    issuesEnabled: z.boolean().optional(),
    pullsEnabled: z.boolean().optional(),
    discussionsEnabled: z.boolean().optional(),
    wikiEnabled: z.boolean().optional(),
    tasksEnabled: z.boolean().optional(),
    agentsEnabled: z.boolean().optional(),
    deploymentsEnabled: z.boolean().optional(),
    graphEnabled: z.boolean().optional(),
    actionsEnabled: z.boolean().optional(),
    actionsNetworkEnabled: z.boolean().optional(),
    onlineEditingEnabled: z.boolean().optional(),
    allowMergeCommit: z.boolean().optional(),
    allowSquashMerge: z.boolean().optional(),
    allowRebaseMerge: z.boolean().optional(),
    deleteBranchOnMerge: z.boolean().optional(),
    requiredApprovals: z.number().int().min(0).max(5).optional(),
    requirePassingChecks: z.boolean().optional(),
    memoryVisibility: MemoryVisibilitySchema.optional(),
    agentAssignmentPolicy: AgentAssignmentPolicySchema.optional(),
  })
  .refine(
    (value) => value.name === undefined || value.slug === undefined || value.name === value.slug
  )
  .refine((value) => Object.keys(value).length > 0);

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  pending: "⏳ 待处理",
  in_progress: "🔄 进行中",
  done: "✅ 已完成",
  abandoned: "❌ 已废弃",
};

export type SetAssignmentsInput = z.infer<typeof SetAssignmentsInputSchema>;
