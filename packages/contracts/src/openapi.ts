import { z } from "zod";
import type { AccessTokenScope } from "./access-tokens";
import {
  CheckRunSchema,
  CommentSchema,
  CreateCommentInputSchema,
  CreateReviewInputSchema,
  GitBlameSchema,
  GitCommitDetailSchema,
  GitCommitSchema,
  GitComparisonSchema,
  GitFileListSchema,
  GitFileSchema,
  GitOidSchema,
  GitPathHistorySchema,
  GitRefSchema,
  GitTreeSchema,
  IssueSchema,
  PullRequestSchema,
  RepositorySchema,
  RenewAgentSessionInputSchema,
  RenewedAgentSessionSchema,
  ReviewSchema,
} from "./forge";
import {
  CreateIssueInputSchema,
  CreatePullRequestInputSchema,
  TrustedUserSchema,
  UpdateIssueInputSchema,
  UpdatePullRequestInputSchema,
} from "./index";
import { NotificationPageSchema, NotificationReasonSchema } from "./notifications";
import { HealthResponseSchema } from "./ops";
import {
  AGENT_FEED_MAX_PAGE,
  AGENT_FEED_MAX_WAIT_SECONDS,
  AgentFeedPageSchema,
} from "./agent-events";
import { AiSummaryStateSchema } from "./ai-summary";
import {
  AutoMergeStatusSchema,
  EnableAutoMergeInputSchema,
  MergeQueueStateSchema,
  PullMergeQueueStatusSchema,
} from "./auto-merge";
import { PagesSettingsSchema, UpdatePagesInputSchema } from "./pages";
import {
  ExplorePageSchema,
  ExploreSorts,
  ExploreTopicSchema,
  ForkRepositoryInputSchema,
  ForkSyncInputSchema,
  ForkSyncResultSchema,
  RepositorySocialSchema,
  RepositoryTopicsSchema,
  SetRepositoryTopicsInputSchema,
  SetWatchInputSchema,
  StarredPageSchema,
} from "./social";
import { CreateReviewCommentInputSchema, ReviewCommentSchema } from "./review-comments";
import {
  AssignTaskInputSchema,
  CreateTaskInputSchema,
  TaskDetailSchema,
  TaskLeaseInputSchema,
  TaskSchema,
  TaskStatusSchema,
  UpdateTaskInputSchema,
} from "./tasks";

export const OPENAPI_PATH = "/api/openapi.json";
export const MCP_PATH = "/mcp";

export type ApiService = "gateway" | "auth" | "forge" | "git";
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiQueryParameter {
  readonly name: string;
  readonly schema: z.ZodType;
  readonly description: string;
  readonly required?: boolean;
}

/** One documented public REST operation as the Gateway exposes it. */
export interface ApiOperation {
  readonly operationId: string;
  readonly method: ApiMethod;
  /** OpenAPI path template under the Gateway origin, for example `/api/forge/repositories/{repositoryId}`. */
  readonly path: string;
  readonly service: ApiService;
  readonly tag: string;
  readonly summary: string;
  /** Personal access token scope the service enforces; null when tokens need no scope. */
  readonly scope: AccessTokenScope | null;
  /** Public repositories (or the whole endpoint) can be read without credentials. */
  readonly anonymous: boolean;
  readonly query?: readonly ApiQueryParameter[];
  readonly body?: z.ZodType;
  readonly status: 200 | 201 | 202;
  /** Full JSON response body on success. */
  readonly response: z.ZodType;
}

const dataOf = (schema: z.ZodType) => z.object({ data: schema });
const boundedListOf = (schema: z.ZodType) =>
  z.object({
    data: z.array(schema),
    truncated: z.boolean().describe("More rows exist than the service returns."),
  });

const ref = (description: string) =>
  ({
    name: "ref",
    schema: z.string().max(255),
    description,
  }) satisfies ApiQueryParameter;
const path = (description: string, required = false) =>
  ({
    name: "path",
    schema: z.string().max(4096),
    description,
    required,
  }) satisfies ApiQueryParameter;

const forgeRepository = "/api/forge/repositories/{repositoryId}";
const forgePullRequest = `${forgeRepository}/pull-requests/{number}`;
const gitRepository = "/api/git/repositories/{repositoryId}";

export const API_OPERATIONS: readonly ApiOperation[] = [
  {
    operationId: "getHealth",
    method: "GET",
    path: "/api/health",
    service: "gateway",
    tag: "Service",
    summary: "Report the status of every internal service and D1.",
    scope: null,
    anonymous: true,
    status: 200,
    response: HealthResponseSchema,
  },
  {
    operationId: "getOpenApiDocument",
    method: "GET",
    path: OPENAPI_PATH,
    service: "gateway",
    tag: "Service",
    summary: "This OpenAPI 3.1 document.",
    scope: null,
    anonymous: true,
    status: 200,
    response: z.record(z.string(), z.unknown()),
  },
  {
    operationId: "getSession",
    method: "GET",
    path: "/api/auth/session",
    service: "auth",
    tag: "Identity",
    summary: "Resolve the identity of the current credential.",
    scope: null,
    anonymous: true,
    status: 200,
    response: dataOf(TrustedUserSchema.nullable()),
  },
  {
    operationId: "renewAgentSession",
    method: "POST",
    path: "/api/auth/agent-session/renew",
    service: "auth",
    tag: "Identity",
    summary:
      "Extend the calling agent session (at most 7 days after creation) and replace its Git credential.",
    scope: null,
    anonymous: false,
    body: RenewAgentSessionInputSchema,
    status: 200,
    response: dataOf(RenewedAgentSessionSchema),
  },
  {
    operationId: "exploreRepositories",
    method: "GET",
    path: "/api/forge/explore",
    service: "forge",
    tag: "Discovery",
    summary: "Search public repositories by name, description or topic.",
    scope: "repo:read",
    anonymous: true,
    query: [
      {
        name: "sort",
        schema: z.enum(ExploreSorts),
        description: "`updated` (default) or `stars`.",
      },
      { name: "q", schema: z.string().max(100), description: "Case-insensitive text search." },
      { name: "topic", schema: z.string().max(35), description: "Only this topic." },
      { name: "limit", schema: z.number().int().min(1).max(50), description: "Page size." },
      { name: "cursor", schema: z.string().max(100), description: "`nextCursor` of a page." },
    ],
    status: 200,
    response: dataOf(ExplorePageSchema),
  },
  {
    operationId: "listExploreTopics",
    method: "GET",
    path: "/api/forge/explore/topics",
    service: "forge",
    tag: "Discovery",
    summary: "The most used topics of public repositories.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(z.array(ExploreTopicSchema)),
  },
  {
    operationId: "listStarredRepositories",
    method: "GET",
    path: "/api/forge/stars",
    service: "forge",
    tag: "Discovery",
    summary: "Repositories the caller starred and can still read, newest star first.",
    scope: "repo:read",
    anonymous: false,
    query: [
      { name: "limit", schema: z.number().int().min(1).max(50), description: "Page size." },
      { name: "cursor", schema: z.string().max(100), description: "`nextCursor` of a page." },
    ],
    status: 200,
    response: dataOf(StarredPageSchema),
  },
  {
    operationId: "listForks",
    method: "GET",
    path: `${forgeRepository}/forks`,
    service: "forge",
    tag: "Forks",
    summary: "List forks the caller can read, most recently updated first (at most 100).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(RepositorySchema),
  },
  {
    operationId: "createFork",
    method: "POST",
    path: `${forgeRepository}/forks`,
    service: "forge",
    tag: "Forks",
    summary:
      "Fork the default branch into the caller's account or an organization. Private repositories fork only into the caller's account or the parent's owner.",
    scope: "repo:write",
    anonymous: false,
    body: ForkRepositoryInputSchema,
    status: 201,
    response: dataOf(RepositorySchema),
  },
  {
    operationId: "syncFork",
    method: "POST",
    path: `${gitRepository}/fork-sync`,
    service: "git",
    tag: "Forks",
    summary: "Fast-forward a fork branch to the upstream branch of the same name.",
    scope: "repo:write",
    anonymous: false,
    body: ForkSyncInputSchema,
    status: 200,
    response: dataOf(ForkSyncResultSchema),
  },
  {
    operationId: "getRepositorySocial",
    method: "GET",
    path: `${forgeRepository}/social`,
    service: "forge",
    tag: "Repositories",
    summary:
      "Star and fork counts with the caller's star and watch level. Agent sessions are refused.",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(RepositorySocialSchema),
  },
  {
    operationId: "starRepository",
    method: "PUT",
    path: `${forgeRepository}/star`,
    service: "forge",
    tag: "Repositories",
    summary: "Star a repository (idempotent).",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(RepositorySocialSchema),
  },
  {
    operationId: "unstarRepository",
    method: "DELETE",
    path: `${forgeRepository}/star`,
    service: "forge",
    tag: "Repositories",
    summary: "Remove the caller's star (idempotent).",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(RepositorySocialSchema),
  },
  {
    operationId: "setWatchLevel",
    method: "PUT",
    path: `${forgeRepository}/watch`,
    service: "forge",
    tag: "Repositories",
    summary: "Choose which activity notifies the caller: participating, all or ignore.",
    scope: "repo:read",
    anonymous: false,
    body: SetWatchInputSchema,
    status: 200,
    response: dataOf(RepositorySocialSchema),
  },
  {
    operationId: "setRepositoryTopics",
    method: "PUT",
    path: `${forgeRepository}/topics`,
    service: "forge",
    tag: "Repositories",
    summary: "Replace the repository topics (administrators).",
    scope: "admin",
    anonymous: false,
    body: SetRepositoryTopicsInputSchema,
    status: 200,
    response: dataOf(RepositoryTopicsSchema),
  },
  {
    operationId: "getPagesSettings",
    method: "GET",
    path: `${forgeRepository}/pages`,
    service: "forge",
    tag: "Repositories",
    summary: "Pages site settings, publication state and site URLs.",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(PagesSettingsSchema),
  },
  {
    operationId: "updatePagesSettings",
    method: "PUT",
    path: `${forgeRepository}/pages`,
    service: "forge",
    tag: "Repositories",
    summary: "Choose the Pages source branch, folder, 404 page and SPA fallback (administrators).",
    scope: "admin",
    anonymous: false,
    body: UpdatePagesInputSchema,
    status: 200,
    response: dataOf(PagesSettingsSchema),
  },
  {
    operationId: "listRepositories",
    method: "GET",
    path: "/api/forge/repositories",
    service: "forge",
    tag: "Repositories",
    summary: "List repositories the caller owns, belongs to or collaborates on (at most 1000).",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(z.array(RepositorySchema)),
  },
  {
    operationId: "getRepositoryByName",
    method: "GET",
    path: "/api/forge/repositories/by-name/{owner}/{repo}",
    service: "forge",
    tag: "Repositories",
    summary: "Resolve a repository by owner and name.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(RepositorySchema),
  },
  {
    operationId: "getRepository",
    method: "GET",
    path: forgeRepository,
    service: "forge",
    tag: "Repositories",
    summary: "Read a repository by id.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(RepositorySchema),
  },
  {
    operationId: "listIssues",
    method: "GET",
    path: `${forgeRepository}/issues`,
    service: "forge",
    tag: "Issues",
    summary: "List issues, newest first (at most 500).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(IssueSchema),
  },
  {
    operationId: "createIssue",
    method: "POST",
    path: `${forgeRepository}/issues`,
    service: "forge",
    tag: "Issues",
    summary: "Open an issue.",
    scope: "issues:write",
    anonymous: false,
    body: CreateIssueInputSchema,
    status: 201,
    response: dataOf(IssueSchema),
  },
  {
    operationId: "getIssue",
    method: "GET",
    path: `${forgeRepository}/issues/{number}`,
    service: "forge",
    tag: "Issues",
    summary: "Read one issue.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(IssueSchema),
  },
  {
    operationId: "updateIssue",
    method: "PATCH",
    path: `${forgeRepository}/issues/{number}`,
    service: "forge",
    tag: "Issues",
    summary: "Edit, close or reopen an issue.",
    scope: "issues:write",
    anonymous: false,
    body: UpdateIssueInputSchema,
    status: 200,
    response: dataOf(IssueSchema),
  },
  {
    operationId: "listIssueComments",
    method: "GET",
    path: `${forgeRepository}/issues/{number}/comments`,
    service: "forge",
    tag: "Issues",
    summary: "List issue comments in chronological order (the latest 500).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(CommentSchema),
  },
  {
    operationId: "createIssueComment",
    method: "POST",
    path: `${forgeRepository}/issues/{number}/comments`,
    service: "forge",
    tag: "Issues",
    summary: "Comment on an issue.",
    scope: "issues:write",
    anonymous: false,
    body: CreateCommentInputSchema,
    status: 201,
    response: dataOf(CommentSchema),
  },
  {
    operationId: "listPullRequests",
    method: "GET",
    path: `${forgeRepository}/pull-requests`,
    service: "forge",
    tag: "Pull requests",
    summary: "List pull requests, newest first (at most 500).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(PullRequestSchema),
  },
  {
    operationId: "createPullRequest",
    method: "POST",
    path: `${forgeRepository}/pull-requests`,
    service: "forge",
    tag: "Pull requests",
    summary: "Open a pull request from a branch or an agent session workspace.",
    scope: "pulls:write",
    anonymous: false,
    body: CreatePullRequestInputSchema,
    status: 201,
    response: dataOf(PullRequestSchema),
  },
  {
    operationId: "getPullRequest",
    method: "GET",
    path: `${forgeRepository}/pull-requests/{number}`,
    service: "forge",
    tag: "Pull requests",
    summary: "Read one pull request.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(PullRequestSchema),
  },
  {
    operationId: "updatePullRequest",
    method: "PATCH",
    path: `${forgeRepository}/pull-requests/{number}`,
    service: "forge",
    tag: "Pull requests",
    summary: "Edit, close, reopen or change the draft state of a pull request.",
    scope: "pulls:write",
    anonymous: false,
    body: UpdatePullRequestInputSchema,
    status: 200,
    response: dataOf(PullRequestSchema),
  },
  {
    operationId: "listPullRequestComments",
    method: "GET",
    path: `${forgeRepository}/pull-requests/{number}/comments`,
    service: "forge",
    tag: "Pull requests",
    summary: "List conversation comments in chronological order (the latest 500).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(CommentSchema),
  },
  {
    operationId: "createPullRequestComment",
    method: "POST",
    path: `${forgeRepository}/pull-requests/{number}/comments`,
    service: "forge",
    tag: "Pull requests",
    summary: "Comment on a pull request conversation.",
    scope: "pulls:write",
    anonymous: false,
    body: CreateCommentInputSchema,
    status: 201,
    response: dataOf(CommentSchema),
  },
  {
    operationId: "listReviews",
    method: "GET",
    path: `${forgeRepository}/pull-requests/{number}/reviews`,
    service: "forge",
    tag: "Pull requests",
    summary: "List reviews, each bound to the commit it reviewed.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(z.array(ReviewSchema)),
  },
  {
    operationId: "submitReview",
    method: "POST",
    path: `${forgeRepository}/pull-requests/{number}/reviews`,
    service: "forge",
    tag: "Pull requests",
    summary: "Submit a review for the current head commit and publish pending line comments.",
    scope: "pulls:write",
    anonymous: false,
    body: CreateReviewInputSchema,
    status: 201,
    response: dataOf(ReviewSchema),
  },
  {
    operationId: "listChecks",
    method: "GET",
    path: `${forgeRepository}/pull-requests/{number}/checks`,
    service: "forge",
    tag: "Pull requests",
    summary: "List CI check runs, each bound to its commit.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(z.array(CheckRunSchema)),
  },
  {
    operationId: "listReviewComments",
    method: "GET",
    path: `${forgeRepository}/pull-requests/{number}/review-comments`,
    service: "forge",
    tag: "Pull requests",
    summary: "List line comments and review threads (at most 1000).",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: boundedListOf(ReviewCommentSchema),
  },
  {
    operationId: "createReviewComment",
    method: "POST",
    path: `${forgeRepository}/pull-requests/{number}/review-comments`,
    service: "forge",
    tag: "Pull requests",
    summary: "Start a line comment thread on the current head or reply to a thread.",
    scope: "pulls:write",
    anonymous: false,
    body: CreateReviewCommentInputSchema,
    status: 201,
    response: dataOf(ReviewCommentSchema),
  },
  {
    operationId: "getAutoMerge",
    method: "GET",
    path: `${forgePullRequest}/auto-merge`,
    service: "forge",
    tag: "Pull requests",
    summary: "Auto-merge setting and what the pull request is waiting on.",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(AutoMergeStatusSchema),
  },
  {
    operationId: "enableAutoMerge",
    method: "PUT",
    path: `${forgePullRequest}/auto-merge`,
    service: "forge",
    tag: "Pull requests",
    summary:
      "Merge automatically once the merge policy is satisfied for exactly `expectedHeadOid`. Human members only.",
    scope: "pulls:write",
    anonymous: false,
    body: EnableAutoMergeInputSchema,
    status: 200,
    response: dataOf(AutoMergeStatusSchema),
  },
  {
    operationId: "disableAutoMerge",
    method: "DELETE",
    path: `${forgePullRequest}/auto-merge`,
    service: "forge",
    tag: "Pull requests",
    summary: "Turn auto-merge off.",
    scope: "pulls:write",
    anonymous: false,
    status: 200,
    response: dataOf(AutoMergeStatusSchema),
  },
  {
    operationId: "getMergeQueueStatus",
    method: "GET",
    path: `${forgePullRequest}/merge-queue`,
    service: "forge",
    tag: "Pull requests",
    summary: "Whether the base branch needs the merge queue and the pull request's position.",
    scope: "repo:read",
    anonymous: false,
    status: 200,
    response: dataOf(PullMergeQueueStatusSchema),
  },
  {
    operationId: "enqueuePullRequest",
    method: "POST",
    path: `${forgePullRequest}/merge-queue`,
    service: "forge",
    tag: "Pull requests",
    summary:
      "Add a pull request whose merge policy is satisfied for `expectedHeadOid` to its base branch merge queue.",
    scope: "pulls:write",
    anonymous: false,
    body: EnableAutoMergeInputSchema,
    status: 201,
    response: dataOf(PullMergeQueueStatusSchema),
  },
  {
    operationId: "dequeuePullRequest",
    method: "DELETE",
    path: `${forgePullRequest}/merge-queue`,
    service: "forge",
    tag: "Pull requests",
    summary: "Remove a pull request from the merge queue unless it is being merged.",
    scope: "pulls:write",
    anonymous: false,
    status: 200,
    response: dataOf(PullMergeQueueStatusSchema),
  },
  {
    operationId: "listMergeQueue",
    method: "GET",
    path: `${forgeRepository}/merge-queue`,
    service: "forge",
    tag: "Pull requests",
    summary: "The merge queue of one branch in merge order.",
    scope: "repo:read",
    anonymous: false,
    query: [
      { name: "branch", schema: z.string().max(255), description: "Default branch if omitted." },
    ],
    status: 200,
    response: dataOf(MergeQueueStateSchema),
  },
  {
    operationId: "getAiSummary",
    method: "GET",
    path: `${forgePullRequest}/ai-summary`,
    service: "forge",
    tag: "Pull requests",
    summary:
      "The AI summary of the pull request and its job state. Summaries are informational and never count as reviews or checks.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(AiSummaryStateSchema),
  },
  {
    operationId: "regenerateAiSummary",
    method: "POST",
    path: `${forgePullRequest}/ai-summary`,
    service: "forge",
    tag: "Pull requests",
    summary: "Queue a new summary of the current head (human repository writers; rate limited).",
    scope: "pulls:write",
    anonymous: false,
    status: 202,
    response: dataOf(AiSummaryStateSchema),
  },
  {
    operationId: "listTasks",
    method: "GET",
    path: `${forgeRepository}/tasks`,
    service: "forge",
    tag: "Tasks",
    summary: "List repository tasks, newest first.",
    scope: "repo:read",
    anonymous: true,
    query: [
      {
        name: "status",
        schema: TaskStatusSchema,
        description: "Only tasks with this status.",
      },
    ],
    status: 200,
    response: dataOf(z.array(TaskSchema)),
  },
  {
    operationId: "createTask",
    method: "POST",
    path: `${forgeRepository}/tasks`,
    service: "forge",
    tag: "Tasks",
    summary: "Create a task.",
    scope: "issues:write",
    anonymous: false,
    body: CreateTaskInputSchema,
    status: 201,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "getTask",
    method: "GET",
    path: `${forgeRepository}/tasks/{number}`,
    service: "forge",
    tag: "Tasks",
    summary: "Read a task with its documents, links and commits.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "updateTask",
    method: "PATCH",
    path: `${forgeRepository}/tasks/{number}`,
    service: "forge",
    tag: "Tasks",
    summary: "Change a task's type, title, motivation, description or status.",
    scope: "issues:write",
    anonymous: false,
    body: UpdateTaskInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "assignTask",
    method: "PUT",
    path: `${forgeRepository}/tasks/{number}/assignee`,
    service: "forge",
    tag: "Tasks",
    summary: "Assign a task to a user or agent, or clear the assignee with null.",
    scope: "issues:write",
    anonymous: false,
    body: AssignTaskInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "claimTask",
    method: "POST",
    path: `${forgeRepository}/tasks/{number}/claim`,
    service: "forge",
    tag: "Tasks",
    summary:
      "Claim a pending task with a time-boxed lease (agent sessions only); the task becomes in progress.",
    scope: "issues:write",
    anonymous: false,
    body: TaskLeaseInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "heartbeatTask",
    method: "POST",
    path: `${forgeRepository}/tasks/{number}/heartbeat`,
    service: "forge",
    tag: "Tasks",
    summary: "Extend the caller's task lease (never beyond 8 hours after the claim).",
    scope: "issues:write",
    anonymous: false,
    body: TaskLeaseInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "releaseTask",
    method: "POST",
    path: `${forgeRepository}/tasks/{number}/release`,
    service: "forge",
    tag: "Tasks",
    summary: "Release a claim; the task returns to pending.",
    scope: "issues:write",
    anonymous: false,
    body: TaskLeaseInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "completeTask",
    method: "POST",
    path: `${forgeRepository}/tasks/{number}/complete`,
    service: "forge",
    tag: "Tasks",
    summary: "Mark a claimed or open task done (the claiming agent or a human writer).",
    scope: "issues:write",
    anonymous: false,
    body: TaskLeaseInputSchema,
    status: 200,
    response: dataOf(TaskDetailSchema),
  },
  {
    operationId: "pollAgentEvents",
    method: "GET",
    path: `${forgeRepository}/agent-events`,
    service: "forge",
    tag: "Agents",
    summary:
      "Read the calling agent session's event feed after `cursor`, waiting up to `wait` seconds (pull delivery only).",
    scope: "repo:read",
    anonymous: false,
    query: [
      { name: "cursor", schema: z.number().int().min(0), description: "Last cursor received." },
      {
        name: "limit",
        schema: z.number().int().min(1).max(AGENT_FEED_MAX_PAGE),
        description: "Page size.",
      },
      {
        name: "wait",
        schema: z.number().int().min(0).max(AGENT_FEED_MAX_WAIT_SECONDS),
        description: "Long-poll seconds.",
      },
    ],
    status: 200,
    response: dataOf(AgentFeedPageSchema),
  },
  {
    operationId: "listNotifications",
    method: "GET",
    path: "/api/forge/notifications",
    service: "forge",
    tag: "Notifications",
    summary: "List the caller's notifications, newest first. Agent sessions are refused.",
    scope: "repo:read",
    anonymous: false,
    query: [
      {
        name: "unread",
        schema: z.enum(["true", "false"]),
        description: "Only unread items.",
      },
      { name: "repositoryId", schema: z.string().max(64), description: "Only this repository." },
      { name: "reason", schema: NotificationReasonSchema, description: "Only this reason." },
      {
        name: "limit",
        schema: z.number().int().min(1).max(50),
        description: "Page size (default 25).",
      },
      { name: "before", schema: z.string(), description: "`nextCursor` of the previous page." },
    ],
    status: 200,
    response: dataOf(NotificationPageSchema),
  },
  {
    operationId: "listFiles",
    method: "GET",
    path: `${gitRepository}/files`,
    service: "git",
    tag: "Git",
    summary: "List every file path of a commit (at most 20,000; `truncated` reports more).",
    scope: "repo:read",
    anonymous: true,
    query: [ref("Branch, tag or commit id; defaults to the default branch.")],
    status: 200,
    response: dataOf(GitFileListSchema),
  },
  {
    operationId: "getTree",
    method: "GET",
    path: `${gitRepository}/tree`,
    service: "git",
    tag: "Git",
    summary: "List one directory.",
    scope: "repo:read",
    anonymous: true,
    query: [
      ref("Branch, tag or commit id; defaults to the default branch."),
      path("Directory path; empty for the root."),
    ],
    status: 200,
    response: dataOf(GitTreeSchema),
  },
  {
    operationId: "getFile",
    method: "GET",
    path: `${gitRepository}/file`,
    service: "git",
    tag: "Git",
    summary: "Read one file; text up to 2 MiB is returned as `content`.",
    scope: "repo:read",
    anonymous: true,
    query: [
      ref("Branch, tag or commit id; defaults to the default branch."),
      path("File path.", true),
    ],
    status: 200,
    response: dataOf(GitFileSchema),
  },
  {
    operationId: "listCommits",
    method: "GET",
    path: `${gitRepository}/commits`,
    service: "git",
    tag: "Git",
    summary: "List commits reachable from a ref, newest first.",
    scope: "repo:read",
    anonymous: true,
    query: [
      ref("Branch, tag or commit id; defaults to the default branch."),
      { name: "limit", schema: z.number().int().min(1).max(100), description: "Page size." },
      { name: "offset", schema: z.number().int().min(0).max(10_000), description: "Skip." },
    ],
    status: 200,
    response: dataOf(z.array(GitCommitSchema)),
  },
  {
    operationId: "listRefs",
    method: "GET",
    path: `${gitRepository}/refs`,
    service: "git",
    tag: "Git",
    summary: "List branches and tags with their commit ids.",
    scope: "repo:read",
    anonymous: true,
    status: 200,
    response: dataOf(z.array(GitRefSchema)),
  },
  {
    operationId: "getPathHistory",
    method: "GET",
    path: `${gitRepository}/history`,
    service: "git",
    tag: "Git",
    summary:
      "First-parent commits that changed a file or directory (200 inspected and 30 matches per request).",
    scope: "repo:read",
    anonymous: true,
    query: [
      ref("Branch, tag or commit id; defaults to the default branch."),
      path("File or directory path.", true),
      { name: "cursor", schema: GitOidSchema, description: "`nextCursor` of the previous page." },
    ],
    status: 200,
    response: dataOf(GitPathHistorySchema),
  },
  {
    operationId: "getBlame",
    method: "GET",
    path: `${gitRepository}/blame`,
    service: "git",
    tag: "Git",
    summary: "Attribute each line of a text file to a commit; `partial` reports a bounded walk.",
    scope: "repo:read",
    anonymous: true,
    query: [
      ref("Branch, tag or commit id; defaults to the default branch."),
      path("File path.", true),
    ],
    status: 200,
    response: dataOf(GitBlameSchema),
  },
  {
    operationId: "getCommitDiff",
    method: "GET",
    path: `${gitRepository}/commit-diff`,
    service: "git",
    tag: "Git",
    summary: "A commit against its first parent (200 files and 2 MB of patches at most).",
    scope: "repo:read",
    anonymous: true,
    query: [{ name: "oid", schema: GitOidSchema, description: "Commit id.", required: true }],
    status: 200,
    response: dataOf(GitCommitDetailSchema),
  },
  {
    operationId: "compareRefs",
    method: "GET",
    path: `${gitRepository}/compare`,
    service: "git",
    tag: "Git",
    summary: "Compare two refs (250 commits per side, 200 files).",
    scope: "repo:read",
    anonymous: true,
    query: [
      { name: "base", schema: z.string().max(255), description: "Base ref (default branch)." },
      { name: "head", schema: z.string().max(255), description: "Head ref (HEAD)." },
      {
        name: "headSessionId",
        schema: z.string().max(64),
        description: "Agent session whose workspace holds the head ref.",
      },
      {
        name: "headRepositoryId",
        schema: z.string().max(64),
        description: "Fork of this repository that holds the head; excludes headSessionId.",
      },
    ],
    status: 200,
    response: dataOf(GitComparisonSchema),
  },
  {
    operationId: "getPullRequestHead",
    method: "GET",
    path: `${gitRepository}/pull-head`,
    service: "git",
    tag: "Git",
    summary: "Resolve the commit a pull request head ref points at.",
    scope: "repo:read",
    anonymous: true,
    query: [
      { name: "head", schema: z.string().max(255), description: "Head branch.", required: true },
      {
        name: "headSessionId",
        schema: z.string().max(64),
        description: "Agent session whose workspace holds the head branch.",
      },
      {
        name: "headRepositoryId",
        schema: z.string().max(64),
        description: "Fork of this repository that holds the head; excludes headSessionId.",
      },
    ],
    status: 200,
    response: dataOf(z.object({ oid: z.string() })),
  },
];

const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

type JsonSchema = z.core.JSONSchema.JSONSchema;

interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

interface OpenApiOperationObject {
  operationId: string;
  summary: string;
  tags: string[];
  security: Record<string, string[]>[];
  parameters: OpenApiParameter[];
  requestBody?: { required: true; content: { "application/json": { schema: JsonSchema } } };
  responses: Record<string, { description: string; content?: Record<string, { schema: unknown }> }>;
  "x-gitedge-service": ApiService;
  "x-gitedge-scope": AccessTokenScope | null;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  components: {
    securitySchemes: Record<string, { type: "http"; scheme: "bearer"; description: string }>;
    schemas: Record<string, JsonSchema>;
  };
  paths: Record<string, Partial<Record<Lowercase<ApiMethod>, OpenApiOperationObject>>>;
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  // OpenAPI 3.1 already declares the 2020-12 dialect, so the per-schema marker is dropped.
  const { $schema, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    target: "draft-2020-12",
  });
  return rest;
}

export const OPENAPI_METHOD_KEYS: Readonly<Record<ApiMethod, Lowercase<ApiMethod>>> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
};

const pathParameterDescriptions: Readonly<Record<string, string>> = {
  repositoryId: "Repository id.",
  owner: "Repository owner (user or organization).",
  repo: "Repository name.",
  number: "Issue, pull request or task number.",
};

/** Builds the OpenAPI 3.1 description of the documented public REST API. */
export function buildOpenApiDocument(origin: string): OpenApiDocument {
  const paths: OpenApiDocument["paths"] = {};
  for (const operation of API_OPERATIONS) {
    const parameters: OpenApiParameter[] = [];
    for (const match of operation.path.matchAll(/\{([A-Za-z]+)\}/g))
      parameters.push({
        name: match[1],
        in: "path",
        required: true,
        description: pathParameterDescriptions[match[1]],
        schema:
          match[1] === "number"
            ? jsonSchema(z.number().int().positive(), "input")
            : jsonSchema(z.string(), "input"),
      });
    for (const query of operation.query ?? [])
      parameters.push({
        name: query.name,
        in: "query",
        required: query.required ?? false,
        description: query.description,
        schema: jsonSchema(query.schema, "input"),
      });
    const entry: OpenApiOperationObject = {
      operationId: operation.operationId,
      summary: operation.summary,
      tags: [operation.tag],
      security: operation.anonymous ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }],
      parameters,
      responses: {
        [String(operation.status)]: {
          description: "Success.",
          content: { "application/json": { schema: jsonSchema(operation.response, "output") } },
        },
        default: {
          description: "Error.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
      "x-gitedge-service": operation.service,
      "x-gitedge-scope": operation.scope,
    };
    if (operation.body)
      entry.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchema(operation.body, "input") } },
      };
    const methods = (paths[operation.path] ??= {});
    methods[OPENAPI_METHOD_KEYS[operation.method]] = entry;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "GitEdge API",
      version: "1",
      description:
        'Responses use `{ "data": ... }`; failures use `{ "error": { "code", "message" } }`. Send a personal access token (`gep_...`) or an agent session token as `Authorization: Bearer <token>`. `x-gitedge-scope` names the token scope an operation needs. Private repositories answer 404 to callers without access.',
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Personal access token or agent session token.",
        },
      },
      schemas: { Error: jsonSchema(ErrorResponseSchema, "output") },
    },
    paths,
  };
}
