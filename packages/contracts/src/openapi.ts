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
import { CreateReviewCommentInputSchema, ReviewCommentSchema } from "./review-comments";
import {
  AssignTaskInputSchema,
  CreateTaskInputSchema,
  TaskDetailSchema,
  TaskSchema,
  TaskStatusSchema,
  UpdateTaskInputSchema,
} from "./tasks";

export const OPENAPI_PATH = "/api/openapi.json";
export const MCP_PATH = "/mcp";

export type ApiService = "gateway" | "auth" | "forge" | "git";
export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH";

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
  readonly status: 200 | 201;
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
