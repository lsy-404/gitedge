import { z } from "zod";
import type { RepositoryRole } from "./repository-controls";

export const ActorSchema = z.object({
  kind: z.enum(["user", "agent", "ci"]),
  id: z.string().min(1),
  name: z.string().min(1),
  sessionId: z.string().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;
/** A human user or an agent assigned to an issue, pull request or task. */
export type Assignee = Omit<Actor, "sessionId" | "kind"> & { kind: "user" | "agent" };

export const AgentSessionIdentitySchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  repositoryId: z.string().min(1),
  workspaceName: z.string().min(1),
  permission: z.enum(["read", "write"]),
});
export type AgentSessionIdentity = z.infer<typeof AgentSessionIdentitySchema>;

export interface Repository {
  id: string;
  namespaceId: string;
  owner: string;
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
  createdAt: number;
  updatedAt: number;
  /** The viewer's effective role, null when unknown or anonymous. */
  viewerRole: RepositoryRole | null;
  canWrite: boolean;
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string;
  actor: Actor;
  labels: string[];
  assignees: Assignee[];
  reviewers: Assignee[];
  createdAt: number;
  updatedAt: number;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  author: string;
  actor: Actor;
  baseRef: string;
  headRef: string;
  headSessionId: string | null;
  draft: boolean;
  mergedOid: string | null;
  assignees: Assignee[];
  reviewers: Assignee[];
  createdAt: number;
  updatedAt: number;
}

export interface Comment {
  id: string;
  body: string;
  actor: Actor;
  createdAt: number;
  updatedAt: number;
}

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

export interface Review {
  id: string;
  body: string;
  state: "commented" | "approved" | "changes_requested";
  commitOid: string;
  actor: Actor;
  createdAt: number;
}

export interface CheckRun {
  id: string;
  name: string;
  commitOid: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | null;
  summary: string;
  detailsUrl: string | null;
  actor: Actor;
  createdAt: number;
  updatedAt: number;
}

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

export interface GitRef {
  name: string;
  oid: string;
  peeledOid?: string;
}
export interface GitCommit {
  oid: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; timestamp: number };
}
export interface GitTreeEntry {
  name: string;
  path: string;
  oid: string;
  mode: string;
  type: "tree" | "blob" | "commit";
}
export interface GitTree {
  ref: string;
  oid: string | null;
  path: string;
  entries: GitTreeEntry[];
}
export interface GitFile {
  path: string;
  oid: string;
  size: number;
  binary: boolean;
  content: string | null;
}
export interface GitGraph {
  commits: GitCommit[];
  refs: GitRef[];
  sessions: AgentSession[];
  truncated: boolean;
}
export interface GitDiffFile {
  path: string;
  type: "added" | "deleted" | "modified";
  oldOid: string | null;
  newOid: string | null;
  patch: string | null;
  binary: boolean;
}
export interface GitComparison {
  baseOid: string;
  headOid: string;
  mergeBaseOid: string | null;
  commits: GitCommit[];
  files: GitDiffFile[];
  truncated: boolean;
}
/** Every blob path of a commit tree; `truncated` when the entry or directory budget was reached. */
export interface GitFileList {
  oid: string;
  paths: string[];
  truncated: boolean;
}
/** First-parent commits that changed a path; `nextCursor` resumes an interrupted walk. */
export interface GitPathHistory {
  commits: GitCommit[];
  inspected: number;
  truncated: boolean;
  nextCursor: string | null;
}
export interface GitBlameCommit {
  oid: string;
  summary: string;
  author: { name: string; timestamp: number };
}
/** `commitOid` is null for lines older than the inspected history. */
export interface GitBlameHunk {
  startLine: number;
  lineCount: number;
  commitOid: string | null;
}
export interface GitBlame {
  oid: string;
  path: string;
  blobOid: string;
  lineCount: number;
  hunks: GitBlameHunk[];
  commits: GitBlameCommit[];
  inspected: number;
  partial: boolean;
}
export interface GitCommitDetail {
  commit: GitCommit;
  files: GitDiffFile[];
  truncated: boolean;
}

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
