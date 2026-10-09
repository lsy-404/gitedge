import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  CheckRunSchema,
  CommentSchema,
  GitFileListSchema,
  GitFileSchema,
  GitOidSchema,
  GitTreeSchema,
  IssueSchema,
  NamespaceSlugSchema,
  NotificationPageSchema,
  NotificationReasonSchema,
  PullRequestSchema,
  RepositorySchema,
  RepositorySlugSchema,
  ReviewCommentSchema,
  ReviewSchema,
  TaskDetailSchema,
  TaskSchema,
  TaskStatusSchema,
  TrustedUserSchema,
  actorForUser,
  type Issue,
  type PullRequest,
  type Repository,
  type ReviewComment,
  type Task,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { fuzzyFilter } from "../../../packages/contracts/src/fuzzy";
import type { Logger } from "../../../src/worker/common/logger";
import { apiPath, type ApiMethod, type ApiOutcome, type ApiRequest, type GitEdgeApi } from "./api";

/** Largest serialized tool result; callers narrow with `limit`, `offset` or line ranges beyond it. */
export const MAX_TOOL_TEXT = 200_000;
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;
const MAX_FILE_LINES = 2_000;
const MAX_FUZZY_QUERY = 64;

const repository = z
  .string()
  .min(3)
  .max(200)
  .describe('Repository as "owner/name", for example "octo/website".');
const itemNumber = z.number().int().positive().max(2_147_483_647);
const ref = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe("Branch, tag or 40-character commit id. Defaults to the default branch.");
const limit = z.number().int().min(1).max(MAX_PAGE).optional().describe("Page size (default 30).");
const offset = z.number().int().min(0).max(10_000).optional().describe("Items to skip.");
const body = z.string().min(1).max(50_000);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

class ToolFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function unwrap<T>(outcome: ApiOutcome<T>): T {
  if (!outcome.ok) throw new ToolFailure(outcome.status, outcome.code, outcome.message);
  return outcome.data;
}

function textResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value);
  if (text.length > MAX_TOOL_TEXT)
    return errorResult(
      413,
      "result_too_large",
      "The result exceeds the MCP output limit. Use a smaller limit, an offset or a line range."
    );
  return { content: [{ type: "text", text }] };
}

function errorResult(status: number, code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ status, code, message }) }],
  };
}

interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  nextOffset: number | null;
  /** The service itself returned only part of the collection. */
  upstreamTruncated: boolean;
}

function page<T>(items: readonly T[], start = 0, size = DEFAULT_PAGE, truncated = false): Page<T> {
  const end = Math.min(items.length, start + size);
  return {
    items: items.slice(start, end),
    total: items.length,
    offset: start,
    nextOffset: end < items.length ? end : null,
    upstreamTruncated: truncated,
  };
}

function parseRepository(value: string): { owner: string; name: string } {
  const [owner, name, ...rest] = value.split("/");
  const parsedOwner = NamespaceSlugSchema.safeParse(owner ?? "");
  const parsedName = RepositorySlugSchema.safeParse(name ?? "");
  if (rest.length > 0 || !parsedOwner.success || !parsedName.success)
    throw new ToolFailure(400, "bad_request", 'Repository must be written as "owner/name".');
  return { owner: parsedOwner.data, name: parsedName.data };
}

function issueSummary(issue: Issue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.author,
    labels: issue.labels,
    assignees: issue.assignees.map((assignee) => assignee.name),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function pullSummary(pull: PullRequest) {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    author: pull.author,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    headSessionId: pull.headSessionId,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  };
}

function taskSummary(task: Task) {
  return {
    number: task.number,
    type: task.type,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    progress: task.progress,
    updatedAt: task.updatedAt,
  };
}

function repositorySummary(repo: Repository) {
  return {
    id: repo.id,
    fullName: `${repo.owner}/${repo.name}`,
    description: repo.description,
    visibility: repo.visibility,
    defaultBranch: repo.defaultBranch,
    archived: repo.archived,
    canWrite: repo.canWrite,
    issuesEnabled: repo.issuesEnabled,
    pullsEnabled: repo.pullsEnabled,
    tasksEnabled: repo.tasksEnabled,
  };
}

/** Groups line comments into threads: each root with its replies in order. */
function reviewThreads(comments: readonly ReviewComment[]) {
  const threads = new Map<string, { root: ReviewComment; replies: ReviewComment[] }>();
  for (const comment of comments)
    if (comment.inReplyTo === null) threads.set(comment.id, { root: comment, replies: [] });
  for (const comment of comments)
    if (comment.inReplyTo !== null) threads.get(comment.inReplyTo)?.replies.push(comment);
  return [...threads.values()].map(({ root, replies }) => ({
    id: root.id,
    path: root.path,
    side: root.side,
    line: root.line,
    startLine: root.startLine,
    commitOid: root.commitOid,
    outdated: root.outdated,
    resolved: root.resolvedAt !== null,
    comments: [root, ...replies].map((comment) => ({
      id: comment.id,
      author: comment.actor.name,
      authorKind: comment.actor.kind,
      body: comment.body,
      pending: comment.pending,
      createdAt: comment.createdAt,
    })),
  }));
}

export function createGitEdgeMcpServer(api: GitEdgeApi, logger: Logger): McpServer {
  const server = new McpServer(
    { name: "gitedge", version: "1.0.0" },
    {
      instructions:
        'GitEdge repositories, files, issues, pull requests, tasks and notifications. Name repositories as "owner/name". Every call uses your access token, so its scopes and repository limits apply. List tools page with limit and offset and report upstreamTruncated when the service returned only part of a collection.',
    }
  );

  async function readData<T>(
    method: ApiMethod,
    path: string,
    schema: z.ZodType<T>,
    request?: ApiRequest
  ): Promise<T> {
    return unwrap(await api.call(method, path, z.object({ data: schema }), request)).data;
  }

  /** Reads a bounded service list; `truncated` is true when the service cut it short. */
  async function readList<T>(
    path: string,
    schema: z.ZodType<T>
  ): Promise<{ data: T[]; truncated: boolean }> {
    return unwrap(
      await api.call(
        "GET",
        path,
        z.object({ data: z.array(schema), truncated: z.boolean().default(false) })
      )
    );
  }

  async function session(): Promise<TrustedUser> {
    return await readData("GET", apiPath("auth", "session"), TrustedUserSchema);
  }

  async function resolve(value: string): Promise<Repository> {
    const { owner, name } = parseRepository(value);
    return await readData(
      "GET",
      apiPath("forge", "repositories", "by-name", owner, name),
      RepositorySchema
    );
  }

  async function guarded(name: string, run: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      const result = textResult(await run());
      logger.info("mcp:tool-called", { tool: name, ok: !result.isError });
      return result;
    } catch (cause) {
      if (cause instanceof ToolFailure) {
        logger.info("mcp:tool-refused", { tool: name, status: cause.status, code: cause.code });
        return errorResult(cause.status, cause.code, cause.message);
      }
      logger.error("mcp:tool-failed", {
        tool: name,
        reason: cause instanceof Error ? cause.message : "unknown",
      });
      return errorResult(500, "internal_error", "The tool failed unexpectedly.");
    }
  }

  server.registerTool(
    "list_repositories",
    {
      description:
        "List repositories you can access. Agent sessions and tokens limited to repositories see only those.",
      inputSchema: { limit, offset },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("list_repositories", async () => {
        const user = await session();
        if (user.agentSession) {
          const own = await readData(
            "GET",
            apiPath("forge", "repositories", user.agentSession.repositoryId),
            RepositorySchema
          );
          return page([repositorySummary(own)]);
        }
        const allowed = user.token?.repositoryIds;
        if (allowed) {
          // Tokens limited to repositories cannot list; read each allowed one, sequentially.
          const window = page(allowed, input.offset, input.limit);
          const repositories: Repository[] = [];
          for (const id of window.items) {
            const outcome = await api.call(
              "GET",
              apiPath("forge", "repositories", id),
              z.object({ data: RepositorySchema })
            );
            if (outcome.ok) repositories.push(outcome.data.data);
            else if (outcome.status !== 404) unwrap(outcome);
          }
          return { ...window, items: repositories.map(repositorySummary) };
        }
        const rows = await readData(
          "GET",
          apiPath("forge", "repositories"),
          z.array(RepositorySchema)
        );
        return page(rows.map(repositorySummary), input.offset, input.limit);
      })
  );

  server.registerTool(
    "get_repository",
    {
      description: "Read repository details, enabled features and your write access.",
      inputSchema: { repository },
      annotations: READ_ONLY,
    },
    async (input) => guarded("get_repository", async () => resolve(input.repository))
  );

  server.registerTool(
    "read_file",
    {
      description:
        "Read a text file. Returns at most 2,000 lines per call; use startLine to continue.",
      inputSchema: {
        repository,
        path: z.string().min(1).max(4096).describe("File path from the repository root."),
        ref,
        startLine: z.number().int().min(1).optional().describe("First line to return (default 1)."),
        maxLines: z.number().int().min(1).max(MAX_FILE_LINES).optional(),
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("read_file", async () => {
        const repo = await resolve(input.repository);
        const file = await readData(
          "GET",
          apiPath("git", "repositories", repo.id, "file"),
          GitFileSchema,
          {
            query: { ref: input.ref, path: input.path },
          }
        );
        if (file.binary || file.content === null)
          return {
            path: file.path,
            oid: file.oid,
            size: file.size,
            binary: file.binary,
            content: null,
          };
        const lines = file.content.split("\n");
        const start = (input.startLine ?? 1) - 1;
        if (start >= lines.length)
          throw new ToolFailure(
            400,
            "bad_request",
            `startLine is past the end of the file (${lines.length} lines).`
          );
        const end = Math.min(lines.length, start + (input.maxLines ?? MAX_FILE_LINES));
        let content = lines.slice(start, end).join("\n");
        let lastLine = end;
        // Very long lines can still exceed the output budget, so the slice shrinks to whole lines.
        while (content.length > MAX_TOOL_TEXT / 2 && lastLine > start + 1) {
          lastLine = start + Math.max(1, Math.floor((lastLine - start) / 2));
          content = lines.slice(start, lastLine).join("\n");
        }
        if (content.length > MAX_TOOL_TEXT / 2)
          throw new ToolFailure(
            413,
            "line_too_long",
            "The requested line exceeds the output limit."
          );
        return {
          path: file.path,
          oid: file.oid,
          size: file.size,
          binary: false,
          totalLines: lines.length,
          startLine: start + 1,
          endLine: lastLine,
          nextStartLine: lastLine < lines.length ? lastLine + 1 : null,
          content,
        };
      })
  );

  server.registerTool(
    "list_tree",
    {
      description: "List one directory of a repository.",
      inputSchema: {
        repository,
        path: z.string().max(4096).optional().describe("Directory path; omit for the root."),
        ref,
        limit,
        offset,
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("list_tree", async () => {
        const repo = await resolve(input.repository);
        const tree = await readData(
          "GET",
          apiPath("git", "repositories", repo.id, "tree"),
          GitTreeSchema,
          {
            query: { ref: input.ref, path: input.path },
          }
        );
        return {
          ref: tree.ref,
          oid: tree.oid,
          path: tree.path,
          entries: page(
            tree.entries.map((entry) => ({ name: entry.name, path: entry.path, type: entry.type })),
            input.offset,
            input.limit
          ),
        };
      })
  );

  server.registerTool(
    "search_files",
    {
      description:
        "Find files by fuzzy path match, like the web file finder (searches up to 20,000 paths).",
      inputSchema: {
        repository,
        query: z.string().min(1).max(MAX_FUZZY_QUERY).describe("Characters of the path, in order."),
        ref,
        limit,
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("search_files", async () => {
        const repo = await resolve(input.repository);
        const list = await readData(
          "GET",
          apiPath("git", "repositories", repo.id, "files"),
          GitFileListSchema,
          { query: { ref: input.ref } }
        );
        return {
          oid: list.oid,
          paths: fuzzyFilter(input.query, list.paths, input.limit ?? DEFAULT_PAGE).map(
            (match) => match.path
          ),
          searched: list.paths.length,
          upstreamTruncated: list.truncated,
        };
      })
  );

  server.registerTool(
    "list_issues",
    {
      description: "List issues, newest first.",
      inputSchema: {
        repository,
        state: z.enum(["open", "closed", "all"]).optional(),
        limit,
        offset,
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("list_issues", async () => {
        const repo = await resolve(input.repository);
        const list = await readList(
          apiPath("forge", "repositories", repo.id, "issues"),
          IssueSchema
        );
        const state = input.state ?? "open";
        const rows = list.data.filter((issue) => state === "all" || issue.state === state);
        return page(rows.map(issueSummary), input.offset, input.limit, list.truncated);
      })
  );

  server.registerTool(
    "get_issue",
    {
      description: "Read an issue with its comments in chronological order.",
      inputSchema: { repository, number: itemNumber, limit, offset },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("get_issue", async () => {
        const repo = await resolve(input.repository);
        const base: readonly (string | number)[] = [
          "forge",
          "repositories",
          repo.id,
          "issues",
          input.number,
        ];
        const issue = await readData("GET", apiPath(...base), IssueSchema);
        const comments = await readList(apiPath(...base, "comments"), CommentSchema);
        return {
          ...issue,
          comments: page(
            comments.data.map((comment) => ({
              id: comment.id,
              author: comment.actor.name,
              authorKind: comment.actor.kind,
              body: comment.body,
              createdAt: comment.createdAt,
            })),
            input.offset,
            input.limit,
            comments.truncated
          ),
        };
      })
  );

  server.registerTool(
    "create_issue",
    {
      description: "Open an issue. Needs the issues:write scope.",
      inputSchema: {
        repository,
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).optional(),
        labels: z.array(z.string().min(1).max(50)).max(20).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      guarded("create_issue", async () => {
        const repo = await resolve(input.repository);
        const issue = await readData(
          "POST",
          apiPath("forge", "repositories", repo.id, "issues"),
          IssueSchema,
          { body: { title: input.title, body: input.body ?? "", labels: input.labels ?? [] } }
        );
        return issueSummary(issue);
      })
  );

  server.registerTool(
    "comment_issue",
    {
      description: "Comment on an issue. Needs the issues:write scope.",
      inputSchema: { repository, number: itemNumber, body },
      annotations: WRITE,
    },
    async (input) =>
      guarded("comment_issue", async () => {
        const repo = await resolve(input.repository);
        return await readData(
          "POST",
          apiPath("forge", "repositories", repo.id, "issues", input.number, "comments"),
          CommentSchema,
          { body: { body: input.body } }
        );
      })
  );

  server.registerTool(
    "list_pull_requests",
    {
      description: "List pull requests, newest first.",
      inputSchema: {
        repository,
        state: z.enum(["open", "closed", "merged", "all"]).optional(),
        limit,
        offset,
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("list_pull_requests", async () => {
        const repo = await resolve(input.repository);
        const list = await readList(
          apiPath("forge", "repositories", repo.id, "pull-requests"),
          PullRequestSchema
        );
        const state = input.state ?? "open";
        const rows = list.data.filter((pull) => state === "all" || pull.state === state);
        return page(rows.map(pullSummary), input.offset, input.limit, list.truncated);
      })
  );

  server.registerTool(
    "get_pull_request",
    {
      description:
        "Read a pull request with its head commit, checks, reviews and line comment threads. Reviews and checks apply to the commit they name.",
      inputSchema: { repository, number: itemNumber, limit },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("get_pull_request", async () => {
        const repo = await resolve(input.repository);
        const base: readonly (string | number)[] = [
          "forge",
          "repositories",
          repo.id,
          "pull-requests",
          input.number,
        ];
        const size = input.limit ?? DEFAULT_PAGE;
        const pull = await readData("GET", apiPath(...base), PullRequestSchema);
        let headOid: string | null = null;
        if (pull.state === "open") {
          const head = await api.call(
            "GET",
            apiPath("git", "repositories", repo.id, "pull-head"),
            z.object({ data: z.object({ oid: GitOidSchema }) }),
            { query: { head: pull.headRef, headSessionId: pull.headSessionId ?? undefined } }
          );
          headOid = head.ok ? head.data.data.oid : null;
        }
        const checks = await readData("GET", apiPath(...base, "checks"), z.array(CheckRunSchema));
        const reviews = await readData("GET", apiPath(...base, "reviews"), z.array(ReviewSchema));
        const comments = await readList(apiPath(...base, "review-comments"), ReviewCommentSchema);
        return {
          ...pull,
          headOid,
          checks: page(
            checks.map((check) => ({
              name: check.name,
              commitOid: check.commitOid,
              status: check.status,
              conclusion: check.conclusion,
              summary: check.summary,
              detailsUrl: check.detailsUrl,
              actor: check.actor.name,
              updatedAt: check.updatedAt,
            })),
            0,
            size
          ),
          reviews: page(
            reviews.map((review) => ({
              id: review.id,
              state: review.state,
              commitOid: review.commitOid,
              author: review.actor.name,
              authorKind: review.actor.kind,
              body: review.body,
              createdAt: review.createdAt,
            })),
            0,
            size
          ),
          reviewThreads: page(reviewThreads(comments.data), 0, size, comments.truncated),
        };
      })
  );

  server.registerTool(
    "create_pull_request",
    {
      description:
        "Open a pull request. Agent sessions propose from their own workspace unless headSessionId is given. Needs the pulls:write scope.",
      inputSchema: {
        repository,
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).optional(),
        baseRef: z.string().min(1).max(255).describe("Branch to merge into."),
        headRef: z.string().min(1).max(255).describe("Branch with the changes."),
        headSessionId: z.string().min(1).max(64).optional(),
        draft: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      guarded("create_pull_request", async () => {
        const repo = await resolve(input.repository);
        const headSessionId = input.headSessionId ?? (await session()).agentSession?.id ?? null;
        const pull = await readData(
          "POST",
          apiPath("forge", "repositories", repo.id, "pull-requests"),
          PullRequestSchema,
          {
            body: {
              title: input.title,
              body: input.body ?? "",
              baseRef: input.baseRef,
              headRef: input.headRef,
              headSessionId,
              draft: input.draft ?? false,
            },
          }
        );
        return pullSummary(pull);
      })
  );

  server.registerTool(
    "comment_pull_request",
    {
      description: "Comment on a pull request conversation. Needs the pulls:write scope.",
      inputSchema: { repository, number: itemNumber, body },
      annotations: WRITE,
    },
    async (input) =>
      guarded("comment_pull_request", async () => {
        const repo = await resolve(input.repository);
        return await readData(
          "POST",
          apiPath("forge", "repositories", repo.id, "pull-requests", input.number, "comments"),
          CommentSchema,
          { body: { body: input.body } }
        );
      })
  );

  server.registerTool(
    "submit_review",
    {
      description:
        "Submit a review for the commit you reviewed. commitOid must be the current head (headOid from get_pull_request); a newer head is refused so a review never covers unseen changes. Needs the pulls:write scope.",
      inputSchema: {
        repository,
        number: itemNumber,
        state: z.enum(["approved", "changes_requested", "commented"]),
        commitOid: GitOidSchema.describe("Full commit id you reviewed."),
        body: z.string().max(50_000).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      guarded("submit_review", async () => {
        const repo = await resolve(input.repository);
        return await readData(
          "POST",
          apiPath("forge", "repositories", repo.id, "pull-requests", input.number, "reviews"),
          ReviewSchema,
          { body: { state: input.state, commitOid: input.commitOid, body: input.body ?? "" } }
        );
      })
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List repository tasks, newest first.",
      inputSchema: { repository, status: TaskStatusSchema.optional(), limit, offset },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("list_tasks", async () => {
        const repo = await resolve(input.repository);
        const tasks = await readData(
          "GET",
          apiPath("forge", "repositories", repo.id, "tasks"),
          z.array(TaskSchema),
          { query: { status: input.status } }
        );
        return page(tasks.map(taskSummary), input.offset, input.limit);
      })
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Assign an unassigned task to yourself and mark a pending task in progress. Refused when someone else holds it. Needs the issues:write scope.",
      inputSchema: { repository, number: itemNumber },
      annotations: WRITE,
    },
    async (input) =>
      guarded("claim_task", async () => {
        const repo = await resolve(input.repository);
        const actor = actorForUser(await session());
        const path = apiPath("forge", "repositories", repo.id, "tasks", input.number);
        const task = await readData("GET", path, TaskDetailSchema);
        if (task.assignee && (task.assignee.kind !== actor.kind || task.assignee.id !== actor.id))
          throw new ToolFailure(
            409,
            "task_claimed",
            `Task #${task.number} is assigned to ${task.assignee.name}.`
          );
        let claimed = task.assignee
          ? task
          : await readData("PUT", `${path}/assignee`, TaskDetailSchema, {
              body: { assignee: { kind: actor.kind, id: actor.id } },
            });
        if (claimed.status === "pending")
          claimed = await readData("PATCH", path, TaskDetailSchema, {
            body: { status: "in_progress" },
          });
        return taskSummary(claimed);
      })
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Change a task's status, title, motivation or description. Needs the issues:write scope.",
      inputSchema: {
        repository,
        number: itemNumber,
        status: TaskStatusSchema.optional(),
        title: z.string().min(1).max(200).optional(),
        motivation: z.string().max(5_000).optional(),
        description: z.string().max(20_000).optional(),
      },
      annotations: WRITE,
    },
    async (input) =>
      guarded("update_task", async () => {
        const { repository: name, number, ...changes } = input;
        if (Object.values(changes).every((value) => value === undefined))
          throw new ToolFailure(400, "bad_request", "Provide at least one field to change.");
        const repo = await resolve(name);
        return taskSummary(
          await readData(
            "PATCH",
            apiPath("forge", "repositories", repo.id, "tasks", number),
            TaskDetailSchema,
            { body: changes }
          )
        );
      })
  );

  server.registerTool(
    "get_notifications",
    {
      description:
        "List your notifications, newest first. Agent sessions have no inbox and are refused.",
      inputSchema: {
        unread: z.boolean().optional().describe("Only unread notifications."),
        repository: repository.optional(),
        reason: NotificationReasonSchema.optional(),
        limit: z.number().int().min(1).max(50).optional(),
        before: z.string().max(100).optional().describe("nextCursor from the previous page."),
      },
      annotations: READ_ONLY,
    },
    async (input) =>
      guarded("get_notifications", async () => {
        const repositoryId = input.repository ? (await resolve(input.repository)).id : undefined;
        return await readData("GET", apiPath("forge", "notifications"), NotificationPageSchema, {
          query: {
            unread: input.unread ? "true" : undefined,
            repositoryId,
            reason: input.reason,
            limit: input.limit,
            before: input.before,
          },
        });
      })
  );

  return server;
}
