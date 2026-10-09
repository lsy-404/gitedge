import { z } from "zod";

export const ActorSchema = z.object({
  kind: z.enum(["user", "agent", "ci"]),
  id: z.string().min(1),
  name: z.string().min(1),
  sessionId: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const AgentSessionIdentitySchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  repositoryId: z.string().min(1),
  workspaceName: z.string().min(1),
  permission: z.enum(["read", "write"]),
});
export type AgentSessionIdentity = z.infer<typeof AgentSessionIdentitySchema>;

export const RepositoryRoleSchema = z.enum(["read", "write", "admin"]);
export type RepositoryRole = z.infer<typeof RepositoryRoleSchema>;

export const AssigneeSchema = z.object({
  kind: z.enum(["user", "agent"]),
  id: z.string().min(1),
  name: z.string().min(1),
});
/** A human user or an agent assigned to an issue, pull request or task. */
export type Assignee = z.infer<typeof AssigneeSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  namespaceId: z.string(),
  owner: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "private"]),
  defaultBranch: z.string(),
  archived: z.boolean(),
  issuesEnabled: z.boolean(),
  pullsEnabled: z.boolean(),
  discussionsEnabled: z.boolean(),
  wikiEnabled: z.boolean(),
  tasksEnabled: z.boolean(),
  agentsEnabled: z.boolean(),
  deploymentsEnabled: z.boolean(),
  graphEnabled: z.boolean(),
  actionsEnabled: z.boolean(),
  actionsNetworkEnabled: z.boolean(),
  onlineEditingEnabled: z.boolean(),
  allowMergeCommit: z.boolean(),
  allowSquashMerge: z.boolean(),
  allowRebaseMerge: z.boolean(),
  deleteBranchOnMerge: z.boolean(),
  requiredApprovals: z.number(),
  requirePassingChecks: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
  viewerRole: RepositoryRoleSchema.nullable().describe(
    "The viewer's effective role, null when unknown or anonymous."
  ),
  canWrite: z.boolean(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const IssueSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  author: z.string(),
  actor: ActorSchema,
  labels: z.array(z.string()),
  assignees: z.array(AssigneeSchema),
  reviewers: z.array(AssigneeSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const PullRequestSchema = z.object({
  id: z.string(),
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  author: z.string(),
  actor: ActorSchema,
  baseRef: z.string(),
  headRef: z.string(),
  headSessionId: z.string().nullable(),
  draft: z.boolean(),
  mergedOid: z.string().nullable(),
  assignees: z.array(AssigneeSchema),
  reviewers: z.array(AssigneeSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  actor: ActorSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Comment = z.infer<typeof CommentSchema>;

export interface Discussion {
  id: string;
  number: number;
  title: string;
  body: string;
  category: "general" | "ideas" | "q-and-a" | "announcements";
  state: "open" | "closed";
  actor: Actor;
  answerCommentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageSummary {
  slug: string;
  title: string;
  revision: number;
  updatedBy: string;
  updatedAt: number;
}

export interface WikiPage extends WikiPageSummary {
  content: string;
}

export interface ListPage<T> {
  items: T[];
  truncated: boolean;
}

export interface IssueLinkedPullRequest {
  number: number;
  title: string;
  state: PullRequest["state"];
  /** The pull request uses a closing keyword for this issue. */
  closes: boolean;
}

export interface IssueEvent {
  id: string;
  kind: "closed_by_pull_request";
  pullRequestNumber: number;
  actor: Actor;
  createdAt: number;
}

export interface IssueReferences {
  pullRequests: IssueLinkedPullRequest[];
  events: IssueEvent[];
  /** More than the returned pull requests or events exist. */
  truncated: boolean;
}

export const ReviewSchema = z.object({
  id: z.string(),
  body: z.string(),
  state: z.enum(["commented", "approved", "changes_requested"]),
  commitOid: z.string(),
  actor: ActorSchema,
  createdAt: z.number(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const CheckRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  commitOid: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "neutral", "cancelled"]).nullable(),
  summary: z.string(),
  detailsUrl: z.string().nullable(),
  actor: ActorSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export type { Agent } from "./agents";

export interface AgentSession {
  id: string;
  agentId: string;
  agentName: string;
  repositoryId: string;
  workspaceName: string;
  remote: string;
  baseRef: string;
  baseOid: string | null;
  permission: "read" | "write";
  status: "active" | "completed" | "revoked";
  createdAt: number;
  expiresAt: number;
}

export interface CreatedAgentSession extends AgentSession {
  token: string;
  gitToken: string;
  instructions: string | null;
}

export const GitRefSchema = z.object({
  name: z.string(),
  oid: z.string(),
  peeledOid: z.string().optional(),
});
export type GitRef = z.infer<typeof GitRefSchema>;
export const GitCommitSchema = z.object({
  oid: z.string(),
  tree: z.string(),
  parents: z.array(z.string()),
  message: z.string(),
  author: z.object({ name: z.string(), email: z.string(), timestamp: z.number() }),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;
export const GitTreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  oid: z.string(),
  mode: z.string(),
  type: z.enum(["tree", "blob", "commit"]),
});
export type GitTreeEntry = z.infer<typeof GitTreeEntrySchema>;
export const GitTreeSchema = z.object({
  ref: z.string(),
  oid: z.string().nullable(),
  path: z.string(),
  entries: z.array(GitTreeEntrySchema),
});
export type GitTree = z.infer<typeof GitTreeSchema>;
export const GitFileSchema = z.object({
  path: z.string(),
  oid: z.string(),
  size: z.number(),
  binary: z.boolean(),
  content: z.string().nullable().describe("UTF-8 text, null for binary or oversized files."),
});
export type GitFile = z.infer<typeof GitFileSchema>;
export interface GitGraph {
  commits: GitCommit[];
  refs: GitRef[];
  sessions: AgentSession[];
  truncated: boolean;
}
export const GitDiffFileSchema = z.object({
  path: z.string(),
  type: z.enum(["added", "deleted", "modified"]),
  oldOid: z.string().nullable(),
  newOid: z.string().nullable(),
  patch: z.string().nullable(),
  binary: z.boolean(),
});
export type GitDiffFile = z.infer<typeof GitDiffFileSchema>;
export const GitComparisonSchema = z.object({
  baseOid: z.string(),
  headOid: z.string(),
  mergeBaseOid: z.string().nullable(),
  commits: z.array(GitCommitSchema),
  files: z.array(GitDiffFileSchema),
  truncated: z.boolean(),
});
export type GitComparison = z.infer<typeof GitComparisonSchema>;
export const GitFileListSchema = z
  .object({ oid: z.string(), paths: z.array(z.string()), truncated: z.boolean() })
  .describe(
    "Every blob path of a commit tree; `truncated` when the entry or directory budget was reached."
  );
export type GitFileList = z.infer<typeof GitFileListSchema>;
export const GitPathHistorySchema = z
  .object({
    commits: z.array(GitCommitSchema),
    inspected: z.number(),
    truncated: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .describe("First-parent commits that changed a path; `nextCursor` resumes an interrupted walk.");
export type GitPathHistory = z.infer<typeof GitPathHistorySchema>;
export const GitBlameCommitSchema = z.object({
  oid: z.string(),
  summary: z.string(),
  author: z.object({ name: z.string(), timestamp: z.number() }),
});
export type GitBlameCommit = z.infer<typeof GitBlameCommitSchema>;
export const GitBlameHunkSchema = z
  .object({ startLine: z.number(), lineCount: z.number(), commitOid: z.string().nullable() })
  .describe("`commitOid` is null for lines older than the inspected history.");
export type GitBlameHunk = z.infer<typeof GitBlameHunkSchema>;
export const GitBlameSchema = z.object({
  oid: z.string(),
  path: z.string(),
  blobOid: z.string(),
  lineCount: z.number(),
  hunks: z.array(GitBlameHunkSchema),
  commits: z.array(GitBlameCommitSchema),
  inspected: z.number(),
  partial: z.boolean(),
});
export type GitBlame = z.infer<typeof GitBlameSchema>;
export const GitCommitDetailSchema = z.object({
  commit: GitCommitSchema,
  files: z.array(GitDiffFileSchema),
  truncated: z.boolean(),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetailSchema>;

const title = z.string().trim().min(1).max(200);
const body = z.string().max(50_000);
export const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const GitRefNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !/(\.\.|@\{|[\s~^:?*\[\\\x00-\x1f\x7f])/.test(value) &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      value
        .split("/")
        .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    "Invalid Git ref name"
  );
export const GitBranchSchema = GitRefNameSchema.refine(
  (value) =>
    value !== "@" && value !== "HEAD" && !value.startsWith("-") && !value.startsWith("refs/"),
  "Expected a branch name, not a symbolic or fully qualified ref"
);
export const CreateCommentInputSchema = z.object({ body: body.min(1) });
export const CreateDiscussionInputSchema = z.object({
  title,
  body: body.default(""),
  category: z.enum(["general", "ideas", "q-and-a", "announcements"]).default("general"),
});
export const UpdateDiscussionInputSchema = z
  .object({
    title: title.optional(),
    body: body.optional(),
    state: z.enum(["open", "closed"]).optional(),
    answerCommentId: z.string().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export const CreateReviewInputSchema = z.object({
  body: body.default(""),
  state: z.enum(["commented", "approved", "changes_requested"]),
  commitOid: GitOidSchema,
});
export const PutCheckRunInputSchema = z
  .object({
    name: title,
    commitOid: GitOidSchema,
    status: z.enum(["queued", "in_progress", "completed"]),
    conclusion: z.enum(["success", "failure", "neutral", "cancelled"]).nullable().default(null),
    summary: body.default(""),
    detailsUrl: z
      .url()
      .refine((value) => new URL(value).protocol === "https:")
      .nullable()
      .default(null),
  })
  .refine((value) =>
    value.status === "completed" ? value.conclusion !== null : value.conclusion === null
  );
export { CreateAgentInputSchema } from "./agents";
export const CreateAgentSessionInputSchema = z.object({
  repositoryId: z.string().min(1),
  baseRef: GitBranchSchema.default("main"),
  permission: z.enum(["read", "write"]).default("write"),
  ttlSeconds: z.number().int().min(300).max(86_400).default(3_600),
});
export const GitMergeInputSchema = z.object({
  pullRequestId: z.string().optional(),
  leaseAt: z.number().optional(),
  method: z.enum(["merge", "squash", "rebase"]).default("merge"),
  baseRef: GitBranchSchema,
  headRef: GitBranchSchema,
  headSessionId: z.string().nullable().optional(),
  expectedBaseOid: GitOidSchema,
  expectedHeadOid: GitOidSchema,
  author: z.object({ name: z.string().min(1).max(100), email: z.string().min(1).max(200) }),
  message: z.string().min(1).max(50_000),
});
export type GitMergeInput = z.infer<typeof GitMergeInputSchema>;
export const MergeAuthorizationInputSchema = GitMergeInputSchema.extend({
  repositoryId: z.string().min(1),
  pullRequestId: z.string().min(1),
  leaseAt: z.number(),
});
export const MergePullRequestInputSchema = z.object({
  method: z.enum(["merge", "squash", "rebase"]).default("merge"),
  expectedBaseOid: GitOidSchema,
  expectedHeadOid: GitOidSchema,
});
