import {
  repositoryAccessDenied,
  repositoryNotFound,
} from "../../../src/worker/common/repository-response";
import { actionsCheck, attachActionChecks } from "./actions-checks";
import { authorizeMerge } from "./merge-policy";
import { mentionAgents, pullRequestEvent, revokeAgentSessions } from "./agent-events";
import { publicProfile } from "./profiles";
import {
  repositoryRole,
  resolveRepositoryPath,
  writableRole,
} from "../../../src/worker/common/repositories";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { repositoryControls } from "./controls";
import {
  deleteOrganization,
  deletedRepositories,
  purgeDueRepositories,
  repositoryLifecycle,
} from "./lifecycle";
import {
  AddOrganizationMemberInputSchema,
  CreateOrganizationInputSchema,
  CreateIssueInputSchema,
  CreatePullRequestInputSchema,
  CreateRepositoryInputSchema,
  PutWikiPageInputSchema,
  SetAssignmentsInputSchema,
  UpdateIssueInputSchema,
  UpdatePullRequestInputSchema,
  parseUserGroupLimits,
  type TrustedUser,
  type Usage,
  type UserGroupLimits,
  CreateCommentInputSchema,
  CreateDiscussionInputSchema,
  CreateReviewInputSchema,
  PutCheckRunInputSchema,
  UpdateDiscussionInputSchema,
  MergeAuthorizationInputSchema,
  MergePullRequestInputSchema,
  type Actor,
  type Repository,
  type WikiPageSummary,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { assignmentsColumn, parseAssignments, replaceAssignments } from "./assignments";
import {
  canWriteSession,
  repoResponse,
  isMember,
  nextNumber,
  parseActor,
  parseJson,
  type ForgeEnv,
  type RepositoryRow,
} from "./common";
import {
  mergeBindingStatements,
  memoryTaskRequest,
  targetStateProgressStatements,
  type Viewer,
} from "./tasks";
import {
  actorForUser,
  readTrustedUser,
  trustedHeaders,
} from "../../../packages/contracts/src/trust";
import {
  dataResponse,
  errorResponse,
  jsonResponse,
  quotaExceededResponse,
} from "../../../src/worker/common/http";

type NamespaceKind = "personal" | "organization";
type OrganizationRole = "owner" | "member";
type NamespaceAccessRow = {
  id: string;
  slug: string;
  kind: NamespaceKind;
  display_name: string;
  description: string;
  created_by: string;
  created_at: number;
  role: OrganizationRole | null;
};
type OrganizationMemberRow = {
  identifier: string;
  role: OrganizationRole;
  createdAt: number;
};

const ANONYMOUS_VIEWER: Viewer = {
  user: null,
  member: false,
  writeAllowed: false,
  isOwner: async () => false,
};

type ForgeTable = "forge_issues" | "forge_pull_requests" | "forge_discussions";

/** Extra select column carrying the assignee and reviewer sets of issues and pull requests. */
function assignmentsSelect(table: ForgeTable, alias: string): string {
  if (table === "forge_issues") return `, ${assignmentsColumn("issue", alias)}`;
  if (table === "forge_pull_requests") return `, ${assignmentsColumn("pull_request", alias)}`;
  return "";
}

function trustedUser(request: Request): TrustedUser | null {
  return readTrustedUser(request);
}

function actorFor(user: TrustedUser): Actor {
  return actorForUser(user);
}

function actorKey(actor: Actor): string {
  return `${actor.kind}:${actor.id}:${actor.sessionId ?? ""}`;
}

async function repositoryById(env: ForgeEnv, repositoryId: string): Promise<RepositoryRow | null> {
  return env.DB.prepare(
    "SELECT repositories.*, namespaces.slug AS owner FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE repositories.id = ? AND repositories.deleted_at IS NULL"
  )
    .bind(repositoryId)
    .first<RepositoryRow>();
}

function hasActiveMergeLease(resource: Record<string, unknown>): boolean {
  return (
    typeof resource.merge_started_at === "number" &&
    resource.merge_started_at >= Date.now() - 300_000
  );
}

type AgentSessionRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  user_id: string;
  repository_id: string;
  workspace_name: string;
  permission: "read" | "write";
  status: string;
  expires_at: number;
  disabled_at: number | null;
};

async function activeAgentSession(env: ForgeEnv, user: TrustedUser): Promise<Response | null> {
  const identity = user.agentSession;
  if (!identity) return null;
  const row = await env.DB.prepare(
    "SELECT auth_agent_sessions.id, auth_agent_sessions.agent_id, auth_agents.name AS agent_name, auth_agent_sessions.user_id, auth_agent_sessions.repository_id, auth_agent_sessions.workspace_name, auth_agent_sessions.permission, auth_agent_sessions.status, auth_agent_sessions.expires_at, auth_agents.disabled_at FROM auth_agent_sessions JOIN auth_agents ON auth_agents.id = auth_agent_sessions.agent_id WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ?"
  )
    .bind(identity.id, user.id)
    .first<AgentSessionRow>();
  const role = row ? await repositoryRole(env.DB, row.repository_id, user.id) : null;
  const enabled = row
    ? await env.DB.prepare("SELECT agents_enabled FROM repositories WHERE id=?")
        .bind(row.repository_id)
        .first<{ agents_enabled: number }>()
    : null;
  if (
    !role ||
    enabled?.agents_enabled !== 1 ||
    (identity.permission === "write" && !writableRole(role)) ||
    !row ||
    row.status !== "active" ||
    row.expires_at <= Date.now() ||
    row.disabled_at !== null ||
    row.agent_id !== identity.agentId ||
    row.agent_name !== identity.agentName ||
    row.repository_id !== identity.repositoryId ||
    row.workspace_name !== identity.workspaceName ||
    row.permission !== identity.permission
  )
    return errorResponse(401, "unauthorized", "Agent session is invalid or expired.");
  return null;
}

async function authorizeRepository(
  env: ForgeEnv,
  user: TrustedUser,
  repository: RepositoryRow,
  options: { member?: boolean; write?: boolean } = {}
): Promise<Response | null> {
  if (user.agentSession && user.agentSession.repositoryId !== repository.id)
    return errorResponse(403, "forbidden", "Agent session is limited to another repository.");
  if (options.write && !canWriteSession(user, repository.id))
    return errorResponse(403, "forbidden", "Read-only agent session cannot write.");
  const member = await isMember(env, repository.id, user.id);
  if (options.member && !member)
    return errorResponse(403, "forbidden", "Repository membership is required.");
  if (
    repository.visibility === "private" &&
    (await repositoryRole(env.DB, repository.id, user.id)) === null
  )
    return repositoryAccessDenied();
  return null;
}

async function publicRepositoryForOwnerAndSlug(
  env: ForgeEnv,
  owner: string,
  slug: string
): Promise<RepositoryRow | Response | null> {
  const resolved = await resolveRepositoryPath(env.DB, owner, slug);
  if (resolved?.visibility === "private") return repositoryAccessDenied();
  return resolved ? repositoryById(env, resolved.id) : null;
}

const MAX_LIST_ROWS = 500;

function boundedList<T>(
  rows: T[],
  present: (row: T) => unknown = (row) => row,
  chronological = false
): Response {
  const kept = rows.slice(0, MAX_LIST_ROWS);
  return jsonResponse({
    data: (chronological ? kept.reverse() : kept).map(present),
    truncated: rows.length > MAX_LIST_ROWS,
  });
}

function compareRequest(
  requestUrl: string,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser
): Request {
  const merged = pull.state === "merged";
  const gitUrl = new URL(`/repositories/${repository.id}/compare`, requestUrl);
  gitUrl.searchParams.set("base", String(merged ? pull.merge_base_oid : pull.base_ref));
  gitUrl.searchParams.set("head", String(merged ? pull.merge_head_oid : pull.head_ref));
  if (pull.head_session_id) gitUrl.searchParams.set("headSessionId", String(pull.head_session_id));
  return new Request(gitUrl, { headers: trustedHeaders(user) });
}

async function pullRequestHeadOid(
  env: ForgeEnv,
  requestUrl: string,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser
): Promise<string | Response> {
  const gitUrl = new URL(`/repositories/${repository.id}/pull-head`, requestUrl);
  gitUrl.searchParams.set("head", String(pull.head_ref));
  if (pull.head_session_id) gitUrl.searchParams.set("headSessionId", String(pull.head_session_id));
  const response = await env.GIT.fetch(new Request(gitUrl, { headers: trustedHeaders(user) }));
  if (response.status === 404)
    return errorResponse(409, "stale_commit", "The pull request head is no longer available.");
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  const data = body && typeof body === "object" && "data" in body ? body.data : null;
  const headOid =
    data && typeof data === "object" && "oid" in data && typeof data.oid === "string"
      ? data.oid
      : null;
  if (!headOid) {
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("forge:pull-request-head-unresolved", {
      repositoryId: repository.id,
      pullRequestId: pull.id,
      status: response.status,
    });
    return errorResponse(502, "git_unavailable", "The pull request head could not be resolved.");
  }
  return headOid;
}

function mergeResultOid(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = value.data;
  if (!data || typeof data !== "object" || !("oid" in data) || typeof data.oid !== "string")
    return null;
  return /^[0-9a-f]{40}$/.test(data.oid) ? data.oid : null;
}

function gitFailureMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    value.error &&
    typeof value.error === "object" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  )
    return value.error.message.slice(0, 500);
  return "Git merge failed.";
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function presentForgeRow(resource: string, row: Record<string, unknown>): Record<string, unknown> {
  const actor = "actor_json" in row ? parseActor(row.actor_json, row.author_id) : null;
  const createdAt = row.created_at ?? row.createdAt;
  const updatedAt = row.updated_at ?? row.updatedAt;
  const author = typeof row.author === "string" ? row.author : (actor?.name ?? row.author_id);
  if (resource === "issues") {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state,
      author,
      actor,
      labels: parseJsonArray(row.labels_json),
      ...parseAssignments(row.assignments_json),
      createdAt,
      updatedAt,
    };
  }
  if (resource === "pull-requests") {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state,
      author,
      actor,
      baseRef: row.base_ref ?? row.baseRef,
      headRef: row.head_ref ?? row.headRef,
      headSessionId: row.head_session_id ?? row.headSessionId ?? null,
      draft: row.draft === 1 || row.draft === true,
      mergedOid: row.merged_oid ?? row.mergedOid ?? null,
      ...parseAssignments(row.assignments_json),
      createdAt,
      updatedAt,
    };
  }
  if (resource === "discussions") {
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      category: row.category,
      state: row.state,
      actor,
      answerCommentId: row.answer_comment_id ?? row.answerCommentId ?? null,
      createdAt,
      updatedAt,
    };
  }
  if (resource === "comments") return { id: row.id, body: row.body, actor, createdAt, updatedAt };
  if (resource === "reviews")
    return {
      id: row.id,
      body: row.body,
      state: row.state,
      commitOid: row.commit_oid,
      actor,
      createdAt,
    };
  if (resource === "checks")
    return {
      id: row.id,
      name: row.name,
      commitOid: row.commit_oid,
      status: row.status,
      conclusion: row.conclusion,
      summary: row.summary,
      detailsUrl: row.details_url,
      actor,
      createdAt,
      updatedAt,
    };
  return {
    slug: row.slug,
    title: row.title,
    content: row.content,
    revision: row.revision,
    updatedBy: row.updatedBy ?? row.updated_by,
    actor,
    updatedAt,
  };
}

function organizationResponse(row: NamespaceAccessRow) {
  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    createdAt: row.created_at,
    role: row.role,
  };
}

async function namespaceForUser(
  env: ForgeEnv,
  userId: string,
  slug: string
): Promise<NamespaceAccessRow | null> {
  return env.DB.prepare(
    "SELECT namespaces.id, namespaces.slug, namespaces.kind, namespaces.display_name, namespaces.description, namespaces.created_by, namespaces.created_at, namespace_memberships.role FROM namespaces LEFT JOIN namespace_memberships ON namespace_memberships.namespace_id = namespaces.id AND namespace_memberships.user_id = ? WHERE namespaces.slug = ?"
  )
    .bind(userId, slug)
    .first<NamespaceAccessRow>();
}

function organizationOwner(namespace: NamespaceAccessRow): boolean {
  return namespace.kind === "organization" && namespace.role === "owner";
}

function canCreateRepository(namespace: NamespaceAccessRow, userId: string): boolean {
  if (namespace.kind === "organization") return organizationOwner(namespace);
  return namespace.created_by === userId;
}

async function publicRepositoryRead(
  env: ForgeEnv,
  repository: RepositoryRow,
  suffix: string[],
  request: Request
): Promise<Response> {
  const parts = ["public", "repositories", repository.owner, repository.slug, ...suffix];
  if (!repository.artifact_name || !repository.remote)
    return errorResponse(503, "internal_error", "Repository storage is unavailable.");
  if (parts.length === 4) return dataResponse(repoResponse(repository));

  const resource = parts[4];
  const disabled =
    resource === "issues" && repository.issues_enabled === 0
      ? "issues"
      : resource === "pull-requests" && repository.pulls_enabled === 0
        ? "pull requests"
        : resource === "discussions" && repository.discussions_enabled === 0
          ? "discussions"
          : resource === "wiki" && repository.wiki_enabled === 0
            ? "wiki"
            : null;
  if (disabled)
    return errorResponse(404, "feature_disabled", `Repository ${disabled} are disabled.`);
  if (repository.archived === 1 && request.method !== "GET")
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  if (resource === "issues" && parts.length === 5) {
    const rows = await env.DB.prepare(
      `SELECT forge_issues.*, users.identifier AS author${assignmentsSelect("forge_issues", "forge_issues")} FROM forge_issues JOIN users ON users.id = forge_issues.author_id WHERE forge_issues.repository_id = ? ORDER BY forge_issues.number DESC LIMIT ?`
    )
      .bind(repository.id, MAX_LIST_ROWS + 1)
      .all<Record<string, unknown>>();
    return boundedList(rows.results, (row) => presentForgeRow("issues", row));
  }
  if (resource === "pull-requests" && parts.length === 5) {
    const rows = await env.DB.prepare(
      `SELECT forge_pull_requests.*, users.identifier AS author${assignmentsSelect("forge_pull_requests", "forge_pull_requests")} FROM forge_pull_requests JOIN users ON users.id = forge_pull_requests.author_id WHERE forge_pull_requests.repository_id = ? ORDER BY forge_pull_requests.number DESC LIMIT ?`
    )
      .bind(repository.id, MAX_LIST_ROWS + 1)
      .all<Record<string, unknown>>();
    return boundedList(rows.results, (row) => presentForgeRow("pull-requests", row));
  }
  if (resource === "wiki" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT slug, title, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? ORDER BY slug ASC LIMIT ?"
    )
      .bind(repository.id, MAX_LIST_ROWS + 1)
      .all();
    return boundedList(rows.results);
  }
  if (resource === "wiki" && parts.length === 6) {
    const page = await env.DB.prepare(
      "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? AND slug = ?"
    )
      .bind(repository.id, parts[5])
      .first();
    return page ? dataResponse(page) : errorResponse(404, "not_found", "Wiki page was not found.");
  }
  if (resource === "wiki" && parts[5] && parts[6] === "history" && parts.length === 7) {
    const rows = await env.DB.prepare(
      "SELECT slug, title, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? ORDER BY revision DESC LIMIT ?"
    )
      .bind(repository.id, parts[5], MAX_LIST_ROWS + 1)
      .all();
    return boundedList(rows.results);
  }
  if (resource === "wiki" && parts[6] === "revisions" && parts.length === 8) {
    const page = await env.DB.prepare(
      "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? AND revision = ?"
    )
      .bind(repository.id, parts[5], Number(parts[7]))
      .first();
    return page
      ? dataResponse(page)
      : errorResponse(404, "not_found", "Wiki revision was not found.");
  }
  if (
    resource === "pull-requests" &&
    parts.length === 7 &&
    ["reviews", "checks", "diff"].includes(parts[6])
  ) {
    const pull = await env.DB.prepare(
      "SELECT * FROM forge_pull_requests WHERE repository_id = ? AND number = ?"
    )
      .bind(repository.id, Number(parts[5]))
      .first<Record<string, unknown>>();
    if (!pull) return errorResponse(404, "not_found", "Pull request was not found.");
    if (parts[6] === "diff") {
      if (pull.state === "closed" && pull.head_session_id)
        return errorResponse(404, "not_found", "Pull request head was not found.");
      const gitUrl = new URL(`/repositories/${repository.id}/compare`, request.url);
      gitUrl.searchParams.set(
        "base",
        String(pull.state === "merged" ? pull.merge_base_oid : pull.base_ref)
      );
      gitUrl.searchParams.set(
        "head",
        String(pull.state === "merged" ? pull.merge_head_oid : pull.head_ref)
      );
      if (pull.head_session_id)
        gitUrl.searchParams.set("headSessionId", String(pull.head_session_id));
      createLogger(env.LOG_LEVEL, { service: "forge" }).debug("forge:public-pull-request-diff", {
        repositoryId: repository.id,
        number: parts[5],
      });
      return env.GIT.fetch(new Request(gitUrl));
    }
    const table = parts[6] === "reviews" ? "forge_reviews" : "forge_check_runs";
    const rows = await env.DB.prepare(
      `SELECT * FROM ${table} WHERE pull_request_id = ? ORDER BY created_at DESC`
    )
      .bind(String(pull.id))
      .all<Record<string, unknown>>();
    return dataResponse(rows.results.map((row) => presentForgeRow(parts[6], row)));
  }
  if (resource === "discussions" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT forge_discussions.*, users.identifier AS author FROM forge_discussions JOIN users ON users.id = forge_discussions.author_id WHERE forge_discussions.repository_id = ? ORDER BY forge_discussions.number DESC LIMIT ?"
    )
      .bind(repository.id, MAX_LIST_ROWS + 1)
      .all<Record<string, unknown>>();
    return boundedList(rows.results, (row) => presentForgeRow("discussions", row));
  }
  if (
    (resource === "issues" || resource === "pull-requests" || resource === "discussions") &&
    parts.length === 6
  ) {
    const number = Number(parts[5]);
    if (!Number.isSafeInteger(number) || number < 1)
      return errorResponse(404, "not_found", "Resource was not found.");
    const table =
      resource === "issues"
        ? "forge_issues"
        : resource === "pull-requests"
          ? "forge_pull_requests"
          : "forge_discussions";
    const row = await env.DB.prepare(
      `SELECT resource.*, users.identifier AS author${assignmentsSelect(table, "resource")} FROM ${table} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? AND resource.number = ?`
    )
      .bind(repository.id, number)
      .first<Record<string, unknown>>();
    return row
      ? dataResponse(presentForgeRow(resource, row))
      : errorResponse(404, "not_found", "Resource was not found.");
  }
  if (
    (resource === "issues" || resource === "pull-requests" || resource === "discussions") &&
    parts.length === 7 &&
    parts[6] === "comments"
  ) {
    const number = Number(parts[5]);
    const table =
      resource === "issues"
        ? "forge_issues"
        : resource === "pull-requests"
          ? "forge_pull_requests"
          : "forge_discussions";
    const targetKind =
      resource === "issues"
        ? "issue"
        : resource === "pull-requests"
          ? "pull_request"
          : "discussion";
    const target = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE repository_id = ? AND number = ?`
    )
      .bind(repository.id, number)
      .first<{ id: string }>();
    if (!target) return errorResponse(404, "not_found", "Resource was not found.");
    const rows = await env.DB.prepare(
      "SELECT * FROM forge_comments WHERE repository_id = ? AND target_kind = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?"
    )
      .bind(repository.id, targetKind, target.id, MAX_LIST_ROWS + 1)
      .all<Record<string, unknown>>();
    return boundedList(rows.results, (row) => presentForgeRow("comments", row), true);
  }
  const memory = await memoryTaskRequest(env, request, repository, ANONYMOUS_VIEWER, suffix);
  if (memory) return memory;
  return errorResponse(404, "not_found", "Endpoint was not found.");
}

async function featureRequest(
  env: ForgeEnv,
  user: TrustedUser,
  repository: RepositoryRow,
  parts: string[],
  request: Request
): Promise<Response | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const [resource, item, action, subitem] = parts.slice(2);
  const disabled =
    resource === "issues" && repository.issues_enabled === 0
      ? "issues"
      : resource === "pull-requests" && repository.pulls_enabled === 0
        ? "pull requests"
        : resource === "discussions" && repository.discussions_enabled === 0
          ? "discussions"
          : resource === "wiki" && repository.wiki_enabled === 0
            ? "wiki"
            : null;
  if (disabled)
    return errorResponse(404, "feature_disabled", `Repository ${disabled} are disabled.`);
  if (repository.archived === 1 && request.method !== "GET")
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  const actor = actorFor(user);
  const member = await isMember(env, repository.id, user.id);
  const writeAllowed = canWriteSession(user, repository.id);
  const requireWrite = (): Response | null =>
    writeAllowed ? null : errorResponse(403, "forbidden", "Read-only agent session cannot write.");
  const requireMember = (): Response | null =>
    member && writeAllowed
      ? null
      : errorResponse(
          403,
          "forbidden",
          "Repository membership and a writable session are required."
        );
  const targetTable =
    resource === "issues"
      ? "forge_issues"
      : resource === "pull-requests"
        ? "forge_pull_requests"
        : resource === "discussions"
          ? "forge_discussions"
          : null;
  const targetKind =
    resource === "issues" ? "issue" : resource === "pull-requests" ? "pull_request" : "discussion";
  if (targetTable && (request.method === "GET" || request.method === "POST") && !item) {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author${assignmentsSelect(targetTable, "resource")} FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? ORDER BY resource.number DESC LIMIT ?`
      )
        .bind(repository.id, MAX_LIST_ROWS + 1)
        .all<Record<string, unknown>>();
      return boundedList(rows.results, (row) => presentForgeRow(resource, row));
    }
    const denied = requireWrite();
    if (denied) return denied;
    if (targetTable === "forge_issues") {
      const parsed = CreateIssueInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid issue payload.");
      const number = await nextNumber(env, targetTable, repository.id),
        id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.prepare(
        "INSERT INTO forge_issues (id, repository_id, number, author_id, actor_json, title, body, state, labels_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)"
      )
        .bind(
          id,
          repository.id,
          number,
          user.id,
          JSON.stringify(actor),
          parsed.data.title,
          parsed.data.body,
          JSON.stringify(parsed.data.labels),
          now,
          now
        )
        .run();
      logger.info("forge:issue-created", {
        repositoryId: repository.id,
        issueNumber: number,
        actorKind: actor.kind,
      });
      return dataResponse(
        {
          id,
          number,
          ...parsed.data,
          state: "open",
          author: user.identifier,
          actor,
          assignees: [],
          reviewers: [],
          createdAt: now,
          updatedAt: now,
        },
        201
      );
    }
    if (targetTable === "forge_pull_requests") {
      const parsed = CreatePullRequestInputSchema.safeParse(await parseJson(request));
      if (!parsed.success)
        return errorResponse(400, "bad_request", "Invalid pull request payload.");
      if (actor.kind === "agent" && parsed.data.headSessionId !== user.agentSession?.id)
        return errorResponse(
          403,
          "forbidden",
          "An agent pull request must use its own workspace session."
        );
      if (parsed.data.headSessionId && repository.agents_enabled === 0)
        return errorResponse(404, "feature_disabled", "Repository agents are disabled.");
      if (parsed.data.headSessionId) {
        const session = await env.DB.prepare(
          "SELECT id FROM auth_agent_sessions WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ? AND auth_agent_sessions.repository_id = ? AND auth_agent_sessions.status = 'active' AND auth_agent_sessions.expires_at > ? AND EXISTS (SELECT 1 FROM auth_agents a WHERE a.id = auth_agent_sessions.agent_id AND a.disabled_at IS NULL)"
        )
          .bind(parsed.data.headSessionId, user.id, repository.id, Date.now())
          .first<{ id: string }>();
        if (!session)
          return errorResponse(
            403,
            "forbidden",
            "Pull request head session is not active for this repository."
          );
      }
      const number = await nextNumber(env, targetTable, repository.id),
        id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.prepare(
        "INSERT INTO forge_pull_requests (id, repository_id, number, author_id, actor_json, title, body, base_ref, head_ref, head_session_id, draft, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)"
      )
        .bind(
          id,
          repository.id,
          number,
          user.id,
          JSON.stringify(actor),
          parsed.data.title,
          parsed.data.body,
          parsed.data.baseRef,
          parsed.data.headRef,
          parsed.data.headSessionId,
          parsed.data.draft ? 1 : 0,
          now,
          now
        )
        .run();
      if (repository.actions_enabled === 1 && !parsed.data.headSessionId)
        await attachActionChecks(env, repository.id, id, parsed.data.headRef);
      await mentionAgents(env, repository, user, parsed.data.body, {
        targetKind: "pull_request",
        targetId: id,
        number,
      });
      await pullRequestEvent(env, repository, user, id, { number, state: "open" });
      logger.info("forge:pull-request-created", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        actorKind: actor.kind,
      });
      return dataResponse(
        {
          id,
          number,
          ...parsed.data,
          state: "open",
          author: user.identifier,
          actor,
          mergedOid: null,
          assignees: [],
          reviewers: [],
          createdAt: now,
          updatedAt: now,
        },
        201
      );
    }
    const parsed = CreateDiscussionInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid discussion payload.");
    if (parsed.data.category === "announcements") {
      const denied = requireMember();
      if (denied) return denied;
    }
    const id = crypto.randomUUID(),
      now = Date.now();
    const number = await nextNumber(env, "forge_discussions", repository.id);
    await env.DB.prepare(
      "INSERT INTO forge_discussions (id, repository_id, number, author_id, actor_json, title, body, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)"
    )
      .bind(
        id,
        repository.id,
        number,
        user.id,
        JSON.stringify(actor),
        parsed.data.title,
        parsed.data.body,
        parsed.data.category,
        now,
        now
      )
      .run();
    logger.info("forge:discussion-created", {
      repositoryId: repository.id,
      discussionNumber: number,
      actorKind: actor.kind,
    });
    return dataResponse(
      {
        id,
        number,
        ...parsed.data,
        state: "open",
        actor,
        answerCommentId: null,
        createdAt: now,
        updatedAt: now,
      },
      201
    );
  }
  if (targetTable && item) {
    const number = Number(item);
    if (!Number.isSafeInteger(number) || number < 1)
      return errorResponse(404, "not_found", "Resource was not found.");
    const current = await env.DB.prepare(
      `SELECT resource.*, users.identifier AS author${assignmentsSelect(targetTable, "resource")} FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? AND resource.number = ?`
    )
      .bind(repository.id, number)
      .first<Record<string, unknown>>();
    if (!current) return errorResponse(404, "not_found", "Resource was not found.");
    if (request.method === "GET" && !action) {
      const itemRow = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author${assignmentsSelect(targetTable, "resource")} FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return itemRow
        ? dataResponse(presentForgeRow(resource, itemRow))
        : errorResponse(404, "not_found", "Resource was not found.");
    }
    if (action === "comments" && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "GET") {
        const comments = await env.DB.prepare(
          "SELECT * FROM forge_comments WHERE repository_id = ? AND target_kind = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?"
        )
          .bind(repository.id, targetKind, String(current.id), MAX_LIST_ROWS + 1)
          .all<Record<string, unknown>>();
        return boundedList(
          comments.results,
          (comment) => presentForgeRow("comments", comment),
          true
        );
      }
      const denied = requireWrite();
      if (denied) return denied;
      const parsed = CreateCommentInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid comment payload.");
      const id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.prepare(
        "INSERT INTO forge_comments (id, repository_id, target_kind, target_id, actor_json, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          id,
          repository.id,
          targetKind,
          String(current.id),
          JSON.stringify(actor),
          user.id,
          parsed.data.body,
          now,
          now
        )
        .run();
      await mentionAgents(env, repository, user, parsed.data.body, {
        targetKind,
        targetId: String(current.id),
        commentId: id,
      });
      logger.info("forge:comment-created", {
        repositoryId: repository.id,
        targetKind,
        targetId: current.id,
        actorKind: actor.kind,
      });
      return dataResponse(
        presentForgeRow("comments", {
          id,
          actor_json: JSON.stringify(actor),
          body: parsed.data.body,
          created_at: now,
          updated_at: now,
        }),
        201
      );
    }
    if (
      (request.method === "PATCH" || request.method === "DELETE") &&
      action === "comments" &&
      subitem
    ) {
      const comment = await env.DB.prepare(
        "SELECT id, author_id, body FROM forge_comments WHERE id = ? AND repository_id = ? AND target_kind = ? AND target_id = ?"
      )
        .bind(subitem, repository.id, targetKind, String(current.id))
        .first<{ id: string; author_id: string; body: string }>();
      if (!comment) return errorResponse(404, "not_found", "Comment was not found.");
      if (comment.author_id !== user.id && !member)
        return errorResponse(
          403,
          "forbidden",
          "Only the comment author or a repository member may change it."
        );
      const denied = requireWrite();
      if (denied) return denied;
      if (request.method === "DELETE") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM forge_comments WHERE id = ?").bind(subitem),
          ...(targetKind === "discussion"
            ? [
                env.DB.prepare(
                  "UPDATE forge_discussions SET answer_comment_id = NULL, updated_at = ? WHERE id = ? AND answer_comment_id = ?"
                ).bind(Date.now(), String(current.id), subitem),
              ]
            : []),
        ]);
        return new Response(null, { status: 204 });
      }
      const parsed = CreateCommentInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid comment payload.");
      await env.DB.prepare("UPDATE forge_comments SET body = ?, updated_at = ? WHERE id = ?")
        .bind(parsed.data.body, Date.now(), subitem)
        .run();
      const updatedComment = await env.DB.prepare("SELECT * FROM forge_comments WHERE id = ?")
        .bind(subitem)
        .first<Record<string, unknown>>();
      return updatedComment
        ? dataResponse(presentForgeRow("comments", updatedComment))
        : errorResponse(404, "not_found", "Comment was not found.");
    }
    if (request.method === "PATCH" && !action) {
      const input = await parseJson(request);
      if (targetTable === "forge_issues") {
        const parsed = UpdateIssueInputSchema.safeParse(input);
        if (!parsed.success) return errorResponse(400, "bad_request", "Invalid issue update.");
        const p = parsed.data;
        const isMember = member && writeAllowed;
        const isPublicAuthor =
          repository.visibility === "public" && current.author_id === user.id && writeAllowed;
        if (!isMember && !isPublicAuthor)
          return errorResponse(
            403,
            "forbidden",
            "Only repository members or the issue author may edit this issue."
          );
        if (!isMember && p.labels !== undefined)
          return errorResponse(
            403,
            "forbidden",
            "Only repository members may change issue labels."
          );
        const now = Date.now();
        const stateChanged = p.state !== undefined && p.state !== current.state;
        // The task progress entry rides in the same batch so it only lands when the update does.
        // Non-member authors never write into task progress, which is members-only memory.
        const [changed] = await env.DB.batch([
          env.DB.prepare(
            "UPDATE forge_issues SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), labels_json = COALESCE(?, labels_json), updated_at = ? WHERE id = ?"
          ).bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.labels ? JSON.stringify(p.labels) : null,
            now,
            current.id
          ),
          ...(stateChanged && isMember
            ? targetStateProgressStatements(
                env,
                "issue",
                String(current.id),
                `Issue #${number} ${p.state === "closed" ? "closed" : "reopened"} by ${actor.name}`,
                now
              )
            : []),
        ]);
        if (changed.meta.changes !== 1)
          return errorResponse(409, "conflict", "Issue changed while it was being updated.");
      } else if (targetTable === "forge_pull_requests") {
        const denied = requireMember();
        if (denied) return denied;
        const staleMergeCutoff = Date.now() - 300_000;
        if (
          typeof current.merge_started_at === "number" &&
          current.merge_started_at >= staleMergeCutoff
        )
          return errorResponse(409, "conflict", "Pull request merge is in progress.");
        const parsed = UpdatePullRequestInputSchema.safeParse(input);
        if (!parsed.success)
          return errorResponse(400, "bad_request", "Invalid pull request update.");
        const p = parsed.data;
        const now = Date.now();
        const stateChanged = p.state !== undefined && p.state !== current.state;
        const [changed] = await env.DB.batch([
          env.DB.prepare(
            "UPDATE forge_pull_requests SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), draft = COALESCE(?, draft), updated_at = ?, merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND state != 'merged' AND (merge_started_at IS NULL OR merge_started_at < ?)"
          ).bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.draft === undefined ? null : p.draft ? 1 : 0,
            now,
            current.id,
            staleMergeCutoff
          ),
          ...(stateChanged
            ? targetStateProgressStatements(
                env,
                "pull_request",
                String(current.id),
                `Pull request #${number} ${p.state === "closed" ? "closed" : "reopened"} by ${actor.name}`,
                now
              )
            : []),
        ]);
        if (changed.meta.changes !== 1)
          return errorResponse(
            409,
            "conflict",
            "Pull request changed while it was being updated or merged."
          );
        await pullRequestEvent(env, repository, user, String(current.id), {
          number,
          state: p.state ?? current.state,
        });
      } else {
        const denied = requireMember();
        if (denied) return denied;
        const parsed = UpdateDiscussionInputSchema.safeParse(input);
        if (!parsed.success) return errorResponse(400, "bad_request", "Invalid discussion update.");
        const p = parsed.data;
        if (p.answerCommentId) {
          const answer = await env.DB.prepare(
            "SELECT id FROM forge_comments WHERE id = ? AND repository_id = ? AND target_kind = 'discussion' AND target_id = ?"
          )
            .bind(p.answerCommentId, repository.id, current.id)
            .first<{ id: string }>();
          if (!answer)
            return errorResponse(
              400,
              "bad_request",
              "Answer comment must belong to this discussion."
            );
        }
        const changed = await env.DB.prepare(
          "UPDATE forge_discussions SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), answer_comment_id = CASE WHEN ? THEN ? ELSE answer_comment_id END, updated_at = ? WHERE id = ?"
        )
          .bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.answerCommentId === null ? 1 : p.answerCommentId ? 1 : 0,
            p.answerCommentId,
            Date.now(),
            current.id
          )
          .run();
        if (changed.meta.changes !== 1)
          return errorResponse(409, "conflict", "Discussion changed while it was being updated.");
      }
      const updated = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author${assignmentsSelect(targetTable, "resource")} FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return dataResponse(updated ? presentForgeRow(resource, updated) : null);
    }
    if (
      (targetTable === "forge_issues" || targetTable === "forge_pull_requests") &&
      action === "assignees" &&
      request.method === "PUT"
    ) {
      const denied = requireMember();
      if (denied) return denied;
      const parsed = SetAssignmentsInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid assignment payload.");
      const failure = await replaceAssignments(
        env,
        repository,
        user,
        { kind: targetTable === "forge_issues" ? "issue" : "pull_request", id: String(current.id) },
        parsed.data
      );
      if (failure) return failure;
      const updated = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author${assignmentsSelect(targetTable, "resource")} FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return dataResponse(updated ? presentForgeRow(resource, updated) : null);
    }
    if (targetTable === "forge_pull_requests" && action === "reviews" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM forge_reviews WHERE pull_request_id = ? ORDER BY created_at DESC"
      )
        .bind(String(current.id))
        .all<Record<string, unknown>>();
      return dataResponse(rows.results.map((row) => presentForgeRow("reviews", row)));
    }
    if (
      targetTable === "forge_pull_requests" &&
      action === "reviews" &&
      request.method === "POST"
    ) {
      const denied = requireWrite();
      if (denied) return denied;
      if (current.state !== "open" || hasActiveMergeLease(current))
        return errorResponse(
          409,
          "conflict",
          "Reviews cannot change while this pull request is closed or merging."
        );
      const parsed = CreateReviewInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid review payload.");
      if (actor.kind === "agent" && !user.agentSession)
        return errorResponse(403, "forbidden", "Trusted agent session is required.");
      const reviewHead = await pullRequestHeadOid(env, request.url, repository, current, user);
      if (reviewHead instanceof Response) return reviewHead;
      if (parsed.data.commitOid !== reviewHead)
        return errorResponse(409, "stale_commit", "The commit is no longer the pull request head.");
      const id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.prepare(
        "INSERT INTO forge_reviews (id, repository_id, pull_request_id, actor_json, author_id, actor_key, state, body, commit_oid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          id,
          repository.id,
          String(current.id),
          JSON.stringify(actor),
          user.id,
          actorKey(actor),
          parsed.data.state,
          parsed.data.body,
          parsed.data.commitOid,
          now
        )
        .run();
      logger.info("forge:review-submitted", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        commitOid: parsed.data.commitOid,
        state: parsed.data.state,
        actorKind: actor.kind,
      });
      return dataResponse({ id, ...parsed.data, actor, createdAt: now }, 201);
    }
    if (
      targetTable === "forge_pull_requests" &&
      action === "checks" &&
      (request.method === "GET" || request.method === "POST")
    ) {
      if (request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT * FROM forge_check_runs WHERE pull_request_id = ? ORDER BY created_at DESC"
        )
          .bind(String(current.id))
          .all<Record<string, unknown>>();
        return dataResponse(rows.results.map((row) => presentForgeRow("checks", row)));
      }
      const denied = requireMember();
      if (denied) return denied;
      if (current.state !== "open" || hasActiveMergeLease(current))
        return errorResponse(
          409,
          "conflict",
          "Checks cannot change while this pull request is closed or merging."
        );
      const parsed = PutCheckRunInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid check run payload.");
      if (parsed.data.name.startsWith(".github/workflows/"))
        return errorResponse(
          403,
          "reserved_check",
          "Workflow check names are reserved for Container Actions."
        );
      const checkHead = await pullRequestHeadOid(env, request.url, repository, current, user);
      if (checkHead instanceof Response) return checkHead;
      if (parsed.data.commitOid !== checkHead)
        return errorResponse(409, "stale_commit", "The commit is no longer the pull request head.");
      const id = crypto.randomUUID(),
        now = Date.now(),
        key = actorKey(actor);
      const check = await env.DB.prepare(
        "INSERT INTO forge_check_runs (id, repository_id, pull_request_id, actor_json, actor_key, name, commit_oid, status, conclusion, summary, details_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pull_request_id, commit_oid, name, actor_key) DO UPDATE SET actor_json = excluded.actor_json, status = excluded.status, conclusion = excluded.conclusion, summary = excluded.summary, details_url = excluded.details_url, updated_at = excluded.updated_at WHERE (forge_check_runs.status = 'queued' AND excluded.status IN ('queued', 'in_progress', 'completed')) OR (forge_check_runs.status = 'in_progress' AND excluded.status IN ('in_progress', 'completed')) OR (forge_check_runs.status = 'completed' AND excluded.status = 'completed') RETURNING *"
      )
        .bind(
          id,
          repository.id,
          String(current.id),
          JSON.stringify(actor),
          key,
          parsed.data.name,
          parsed.data.commitOid,
          parsed.data.status,
          parsed.data.conclusion,
          parsed.data.summary,
          parsed.data.detailsUrl,
          now,
          now
        )
        .first<Record<string, unknown>>();
      if (!check)
        return errorResponse(
          409,
          "conflict",
          "Check run cannot move backwards from its current status."
        );
      logger.info("forge:check-run-recorded", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        checkName: parsed.data.name,
        commitOid: parsed.data.commitOid,
        status: parsed.data.status,
        conclusion: parsed.data.conclusion,
      });
      return dataResponse(presentForgeRow("checks", check), check.id === id ? 201 : 200);
    }
    if (targetTable === "forge_pull_requests" && action === "diff" && request.method === "GET") {
      logger.debug("forge:pull-request-diff", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        hasAgentSession: Boolean(current.head_session_id),
      });
      return env.GIT.fetch(compareRequest(request.url, repository, current, user));
    }
    if (targetTable === "forge_pull_requests" && action === "merge" && request.method === "POST") {
      const denied = requireMember();
      if (denied) return denied;
      if (actor.kind !== "user")
        return errorResponse(403, "forbidden", "Only a human repository member may merge.");
      const parsed = MergePullRequestInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid merge payload.");
      if (current.state === "merged" && current.merged_oid) {
        const merged = await env.DB.prepare(
          `SELECT pull.*, users.identifier AS author${assignmentsSelect("forge_pull_requests", "pull")} FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id WHERE pull.id = ?`
        )
          .bind(current.id)
          .first<Record<string, unknown>>();
        return merged
          ? dataResponse(presentForgeRow(resource, merged))
          : errorResponse(404, "not_found", "Pull request was not found.");
      }
      if (current.state !== "open" || current.draft)
        return errorResponse(409, "conflict", "Pull request must be open and ready to merge.");

      const rules = matchingBranchRules(
        await branchRules(env.DB, repository.id),
        String(current.base_ref)
      );
      if (rules.some((rule) => rule.locked))
        return errorResponse(403, "protected_branch", "The base branch is locked.");
      const allowed =
        parsed.data.method === "merge"
          ? repository.allow_merge_commit !== 0
          : parsed.data.method === "squash"
            ? repository.allow_squash_merge !== 0
            : repository.allow_rebase_merge !== 0;
      if (!allowed)
        return errorResponse(403, "merge_method_disabled", "This merge method is disabled.");
      const leaseAt = Date.now();
      const staleBefore = leaseAt - 300_000;
      const lease = await env.DB.prepare(
        "UPDATE forge_pull_requests SET merge_started_at = ?, merge_base_oid = ?, merge_head_oid = ? WHERE id = ? AND state = 'open' AND draft = 0 AND (merge_started_at IS NULL OR merge_started_at < ?) RETURNING id"
      )
        .bind(
          leaseAt,
          parsed.data.expectedBaseOid,
          parsed.data.expectedHeadOid,
          current.id,
          staleBefore
        )
        .first<{ id: string }>();
      if (!lease)
        return errorResponse(
          409,
          "conflict",
          "Another merge is in progress for this pull request."
        );
      const releaseLease = async (): Promise<void> => {
        await env.DB.prepare(
          "UPDATE forge_pull_requests SET merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND merge_started_at = ?"
        )
          .bind(current.id, leaseAt)
          .run();
      };

      const rejected = await authorizeMerge(env, repository, user, current, parsed.data);
      if (rejected) {
        await releaseLease();
        return rejected;
      }
      const gitUrl = new URL(`/repositories/${repository.id}/merge`, request.url);
      const headSessionId =
        current.head_session_id == null ? null : String(current.head_session_id);
      const gitHeaders = trustedHeaders(user);
      gitHeaders.set("Content-Type", "application/json");
      const gitResponse = await env.GIT.fetch(
        new Request(gitUrl, {
          method: "POST",
          headers: gitHeaders,
          body: JSON.stringify({
            pullRequestId: String(current.id),
            leaseAt,
            method: parsed.data.method,
            baseRef: current.base_ref,
            headRef: current.head_ref,
            headSessionId,
            expectedBaseOid: parsed.data.expectedBaseOid,
            expectedHeadOid: parsed.data.expectedHeadOid,
            author: { name: user.identifier, email: `${user.identifier}@users.gitedge.invalid` },
            message: `${current.title}`,
          }),
        })
      );
      const payload: unknown = await gitResponse.json().catch(() => null);
      const oid = mergeResultOid(payload);
      if (!gitResponse.ok || !oid) {
        await releaseLease();
        logger.warn("forge:pull-request-git-merge-failed", {
          repositoryId: repository.id,
          pullRequestNumber: number,
          status: gitResponse.status,
        });
        return errorResponse(
          gitResponse.status === 409 ? 409 : 502,
          "conflict",
          gitFailureMessage(payload)
        );
      }
      const now = Date.now();
      // Task binding and the progress entry share the batch with the merge record.
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE forge_pull_requests SET state = 'merged', merged_oid = ?, updated_at = ?, merge_started_at = NULL WHERE id = ? AND state = 'open' AND merge_started_at = ? AND merge_base_oid = ? AND merge_head_oid = ?"
        ).bind(
          oid,
          now,
          current.id,
          leaseAt,
          parsed.data.expectedBaseOid,
          parsed.data.expectedHeadOid
        ),
        ...mergeBindingStatements(env, {
          repositoryId: repository.id,
          pullRequestId: String(current.id),
          number,
          oid,
          baseRef: String(current.base_ref),
          summary: String(current.title),
          author: user.identifier,
          actor,
          now,
        }),
      ]);
      const merged = await env.DB.prepare(
        `SELECT pull.*, users.identifier AS author${assignmentsSelect("forge_pull_requests", "pull")} FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id WHERE pull.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      if (merged?.state === "merged" && merged.merged_oid) {
        await pullRequestEvent(env, repository, user, String(current.id), {
          number,
          state: "merged",
          oid,
        });
        if (
          repository.delete_branch_on_merge === 1 &&
          !headSessionId &&
          current.head_ref !== repository.default_branch &&
          current.head_ref !== current.base_ref
        ) {
          const deletion = await env.GIT.fetch(
            new Request(new URL(`/repositories/${repository.id}/branches`, request.url), {
              method: "DELETE",
              headers: gitHeaders,
              body: JSON.stringify({
                name: current.head_ref,
                expectedOid: parsed.data.expectedHeadOid,
              }),
            })
          );
          if (!deletion.ok)
            logger.warn("forge:merged-branch-cleanup-skipped", {
              repositoryId: repository.id,
              pullRequestNumber: number,
              status: deletion.status,
            });
          await deletion.body?.cancel();
        }
        logger.info("forge:pull-request-merged", {
          repositoryId: repository.id,
          pullRequestNumber: number,
          mergedOid: merged.merged_oid,
        });
        return dataResponse(presentForgeRow(resource, merged));
      }
      return errorResponse(409, "conflict", "Pull request state changed after Git merge.");
    }
  }

  if (resource === "wiki" && item) {
    if (request.method === "GET") {
      if (action === "history") {
        const rows = await env.DB.prepare(
          "SELECT slug, title, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? ORDER BY revision DESC LIMIT ?"
        )
          .bind(repository.id, item, MAX_LIST_ROWS + 1)
          .all<WikiPageSummary>();
        return boundedList(rows.results);
      }
      if (action === "revisions" && subitem) {
        const page = await env.DB.prepare(
          "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? AND revision = ?"
        )
          .bind(repository.id, item, Number(subitem))
          .first();
        return page
          ? dataResponse(page)
          : errorResponse(404, "not_found", "Wiki revision was not found.");
      }
      const page = await env.DB.prepare(
        "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? AND slug = ?"
      )
        .bind(repository.id, item)
        .first();
      return page
        ? dataResponse(page)
        : errorResponse(404, "not_found", "Wiki page was not found.");
    }
    if (request.method === "PUT" || (action === "restore" && request.method === "POST")) {
      const denied = requireMember();
      if (denied) return denied;
      let title: string;
      let content: string;
      let expected: number | undefined;
      if (action === "restore" && subitem) {
        const input = await parseJson(request);
        if (
          !input ||
          typeof input !== "object" ||
          !("expectedRevision" in input) ||
          typeof input.expectedRevision !== "number" ||
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision < 0
        )
          return errorResponse(
            400,
            "bad_request",
            "A current wiki revision is required to restore history."
          );
        const historical = await env.DB.prepare(
          "SELECT title, content FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? AND revision = ?"
        )
          .bind(repository.id, item, Number(subitem))
          .first<{ title: string; content: string }>();
        if (!historical) return errorResponse(404, "not_found", "Wiki revision was not found.");
        title = historical.title;
        content = historical.content;
        expected = input.expectedRevision;
      } else {
        const parsed = PutWikiPageInputSchema.safeParse(await parseJson(request));
        if (!parsed.success) return errorResponse(400, "bad_request", "Invalid wiki page payload.");
        title = parsed.data.title;
        content = parsed.data.content;
        expected = parsed.data.expectedRevision;
      }
      const now = Date.now();
      const inserted = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO forge_wiki_pages (repository_id, slug, title, content, revision, updated_by, updated_at) SELECT ?, ?, ?, ?, 1, ?, ? WHERE ? IS NULL OR ? = 0 ON CONFLICT(repository_id, slug) DO NOTHING"
        ).bind(
          repository.id,
          item,
          title,
          content,
          user.id,
          now,
          expected ?? null,
          expected ?? null
        ),
        env.DB.prepare(
          "INSERT INTO forge_wiki_revisions (repository_id, slug, revision, title, content, updated_by, actor_json, updated_at) SELECT ?, ?, 1, ?, ?, ?, ?, ? WHERE changes() = 1"
        ).bind(repository.id, item, title, content, user.id, JSON.stringify(actor), now),
      ]);
      if (inserted[0].meta.changes === 1)
        return dataResponse(
          { slug: item, title, content, revision: 1, updatedBy: user.id, updatedAt: now },
          201
        );
      const expectedRevision = expected ?? 0;
      const updated = await env.DB.batch([
        env.DB.prepare(
          "UPDATE forge_wiki_pages SET title = ?, content = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE repository_id = ? AND slug = ? AND revision = ?"
        ).bind(title, content, user.id, now, repository.id, item, expectedRevision),
        env.DB.prepare(
          "INSERT INTO forge_wiki_revisions (repository_id, slug, revision, title, content, updated_by, actor_json, updated_at) SELECT repository_id, slug, revision, title, content, updated_by, ?, updated_at FROM forge_wiki_pages WHERE repository_id = ? AND slug = ? AND revision = ? AND updated_by = ? AND updated_at = ? AND title = ? AND content = ? AND changes() = 1"
        ).bind(
          JSON.stringify(actor),
          repository.id,
          item,
          expectedRevision + 1,
          user.id,
          now,
          title,
          content
        ),
      ]);
      if (updated[0].meta.changes !== 1)
        return errorResponse(409, "conflict", "Wiki page revision has changed.");
      return dataResponse({
        slug: item,
        title,
        content,
        revision: expectedRevision + 1,
        updatedBy: user.id,
        updatedAt: now,
      });
    }
  }
  return null;
}

function groupLimitsFor(env: ForgeEnv, user: TrustedUser): UserGroupLimits {
  const limits = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
  return limits[user.groupKey] ?? limits.free;
}

async function countCreatedRepositories(env: ForgeEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?"
  )
    .bind(userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function databaseHealth(env: ForgeEnv, logger: Logger) {
  try {
    await env.DB.prepare("SELECT 1").first();
    return dataResponse({ ok: true });
  } catch (cause) {
    logger.error("forge:health-d1-failed", {
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(503, "service_unavailable", "Database is unavailable.");
  }
}

export default {
  async fetch(request: Request, env: ForgeEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/internal/health")
      return dataResponse({ ok: true });
    if (request.method === "GET" && url.pathname === "/internal/health/d1")
      return databaseHealth(env, logger);

    if (url.pathname === "/internal/actions-check") return actionsCheck(request, env);
    const user = trustedUser(request);
    if (url.pathname === "/internal/merge-authorization") {
      if (url.hostname !== "forge.internal" || request.method !== "POST" || !user)
        return errorResponse(404, "not_found", "Endpoint was not found.");
      const input = MergeAuthorizationInputSchema.safeParse(await parseJson(request));
      if (!input.success) return errorResponse(400, "bad_request", "Invalid merge authorization.");
      const pull = await env.DB.prepare("SELECT * FROM forge_pull_requests WHERE id=?")
        .bind(input.data.pullRequestId)
        .first<Record<string, unknown>>();
      if (
        !pull ||
        pull.state !== "open" ||
        pull.repository_id !== input.data.repositoryId ||
        pull.base_ref !== input.data.baseRef ||
        pull.head_ref !== input.data.headRef ||
        (pull.head_session_id ?? null) !== (input.data.headSessionId ?? null) ||
        pull.merge_started_at !== input.data.leaseAt ||
        input.data.leaseAt < Date.now() - 300_000 ||
        pull.merge_base_oid !== input.data.expectedBaseOid ||
        pull.merge_head_oid !== input.data.expectedHeadOid
      )
        return errorResponse(409, "merge_changed", "Merge authorization expired or changed.");
      const repository = await repositoryById(env, String(pull.repository_id));
      if (!repository) return repositoryNotFound();
      return (
        (await authorizeMerge(env, repository, user, pull, input.data)) ??
        dataResponse({ authorized: true })
      );
    }
    if (request.method === "GET" && parts[0] === "profiles" && parts.length === 2)
      return publicProfile(env, request, parts[1], user);
    if (!user) {
      if (request.method !== "GET" || parts[0] !== "repositories")
        return errorResponse(401, "unauthorized", "Trusted user context is required.");
      const byName = parts[1] === "by-name";
      const repository = byName
        ? await publicRepositoryForOwnerAndSlug(env, parts[2] ?? "", parts[3] ?? "")
        : await repositoryById(env, parts[1] ?? "");
      if (repository instanceof Response) return repository;
      if (!repository) return repositoryNotFound();
      if (repository.visibility !== "public") return repositoryAccessDenied();
      return publicRepositoryRead(env, repository, parts.slice(byName ? 4 : 2), request);
    }
    const sessionError = await activeAgentSession(env, user);
    if (sessionError) return sessionError;
    if (
      user.agentSession &&
      (parts[0] !== "repositories" ||
        !parts[1] ||
        (parts[1] !== user.agentSession.repositoryId && parts[1] !== "by-name"))
    )
      return errorResponse(403, "forbidden", "Agent session is limited to its repository.");
    if (user.agentSession && request.method !== "GET" && parts[1] === "by-name")
      return errorResponse(
        403,
        "forbidden",
        "Agent sessions cannot resolve repositories by name for writes."
      );

    if (request.method === "GET" && url.pathname === "/organizations") {
      const rows = await env.DB.prepare(
        "SELECT namespaces.id, namespaces.slug, namespaces.kind, namespaces.display_name, namespaces.description, namespaces.created_by, namespaces.created_at, namespace_memberships.role FROM namespaces JOIN namespace_memberships ON namespace_memberships.namespace_id = namespaces.id WHERE namespace_memberships.user_id = ? AND namespaces.kind = 'organization' ORDER BY namespaces.slug ASC"
      )
        .bind(user.id)
        .all<NamespaceAccessRow>();
      return dataResponse(rows.results.map(organizationResponse));
    }
    if (request.method === "POST" && url.pathname === "/organizations") {
      const parsed = CreateOrganizationInputSchema.safeParse(await parseJson(request));
      if (!parsed.success)
        return errorResponse(400, "bad_request", "Invalid organization payload.");
      const now = Date.now();
      const organizationId = crypto.randomUUID();
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES (?, ?, ?, ?, 'organization', ?, ?)"
          ).bind(
            organizationId,
            parsed.data.slug,
            user.id,
            now,
            parsed.data.displayName,
            parsed.data.description
          ),
          env.DB.prepare(
            "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) VALUES (?, ?, ?, 'owner')"
          ).bind(organizationId, user.id, now),
        ]);
      } catch {
        logger.warn("forge:organization-create-conflict", {
          slug: parsed.data.slug,
          userId: user.id,
        });
        return errorResponse(409, "conflict", "Organization slug already exists.");
      }
      const organization: NamespaceAccessRow = {
        id: organizationId,
        slug: parsed.data.slug,
        kind: "organization",
        display_name: parsed.data.displayName,
        description: parsed.data.description,
        created_by: user.id,
        created_at: now,
        role: "owner",
      };
      logger.info("forge:organization-created", {
        organizationId,
        slug: organization.slug,
        userId: user.id,
      });
      return dataResponse(organizationResponse(organization), 201);
    }

    const organizationSlug = parts[1];
    if (parts[0] === "organizations" && organizationSlug) {
      const organization = await namespaceForUser(env, user.id, organizationSlug);
      if (!organization || organization.kind !== "organization")
        return errorResponse(404, "not_found", "Organization was not found.");
      if (request.method === "GET" && parts.length === 2)
        return dataResponse(organizationResponse(organization));
      if (parts[2] === "members") {
        if (request.method === "GET" && parts.length === 3) {
          if (!organization.role)
            return errorResponse(403, "forbidden", "Organization membership is required.");
          const rows = await env.DB.prepare(
            "SELECT users.identifier, namespace_memberships.role, namespace_memberships.created_at AS createdAt FROM namespace_memberships JOIN users ON users.id = namespace_memberships.user_id WHERE namespace_memberships.namespace_id = ? ORDER BY namespace_memberships.role DESC, users.identifier ASC"
          )
            .bind(organization.id)
            .all<OrganizationMemberRow>();
          return dataResponse(rows.results);
        }
        if (!organizationOwner(organization))
          return errorResponse(403, "forbidden", "Organization owner access is required.");
        if (request.method === "POST" && parts.length === 3) {
          const parsed = AddOrganizationMemberInputSchema.safeParse(await parseJson(request));
          if (!parsed.success)
            return errorResponse(400, "bad_request", "Invalid organization member payload.");
          const result = await env.DB.prepare(
            "INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, created_at, role) SELECT ?, users.id, ?, ? FROM users WHERE users.identifier = ?"
          )
            .bind(organization.id, Date.now(), parsed.data.role, parsed.data.identifier)
            .run();
          if (result.meta.changes !== 1)
            return errorResponse(
              409,
              "conflict",
              "User was not found or is already an organization member."
            );
          logger.info("forge:organization-member-added", {
            organizationId: organization.id,
            identifier: parsed.data.identifier,
            role: parsed.data.role,
            userId: user.id,
          });
          return dataResponse({ identifier: parsed.data.identifier, role: parsed.data.role }, 201);
        }
        const memberIdentifier = parts[3];
        if (request.method === "DELETE" && memberIdentifier && parts.length === 4) {
          const result = await env.DB.prepare(
            "DELETE FROM namespace_memberships WHERE namespace_id = ? AND user_id = (SELECT id FROM users WHERE identifier = ?) AND NOT (role = 'owner' AND (SELECT COUNT(*) FROM namespace_memberships WHERE namespace_id = ? AND role = 'owner') <= 1) RETURNING user_id"
          )
            .bind(organization.id, memberIdentifier, organization.id)
            .first<{ user_id: string }>();
          if (!result)
            return errorResponse(
              409,
              "conflict",
              "Member was not found or is the last organization owner."
            );
          const revoked = await revokeAgentSessions(env, {
            namespaceId: organization.id,
            userId: result.user_id,
          });
          logger.info("forge:organization-member-removed", {
            organizationId: organization.id,
            identifier: memberIdentifier,
            userId: user.id,
          });
          if (!revoked) return dataResponse({ removed: true, revocationIncomplete: true }, 202);
          return new Response(null, { status: 204 });
        }
      }
      if (request.method === "DELETE" && parts.length === 2) {
        if (!organizationOwner(organization))
          return errorResponse(403, "forbidden", "Organization owner access is required.");
        return deleteOrganization(env, request, organization, user);
      }
      return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
    }
    if (parts[0] === "deleted-repositories") return deletedRepositories(env, request, user, parts);

    if (request.method === "GET" && url.pathname === "/usage") {
      const groupLimits = groupLimitsFor(env, user);
      const usage: Usage = {
        groupKey: user.groupKey,
        repositories: {
          used: await countCreatedRepositories(env, user.id),
          limit: groupLimits.maxRepositories,
        },
        storage: { usedBytes: null, limitBytes: groupLimits.maxStorageBytes },
        maxPushBytes: groupLimits.maxPushBytes,
        maxRepositoryBytes: groupLimits.maxRepositoryBytes,
        rpm: groupLimits.rpm,
      };
      return dataResponse(usage);
    }
    if (request.method === "GET" && url.pathname === "/repositories") {
      const rows = await env.DB.prepare(
        "SELECT repositories.*, namespaces.slug AS owner, CASE WHEN m.user_id IS NOT NULL OR c.role IN ('write','admin') THEN 1 ELSE 0 END AS can_write FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id LEFT JOIN namespace_memberships m ON m.namespace_id=repositories.namespace_id AND m.user_id=? LEFT JOIN repository_collaborators c ON c.repository_id=repositories.id AND c.user_id=? WHERE repositories.deleted_at IS NULL AND (m.user_id IS NOT NULL OR c.user_id IS NOT NULL) ORDER BY repositories.updated_at DESC LIMIT 1001"
      )
        .bind(user.id, user.id)
        .all<RepositoryRow>();
      if (rows.results.length > 1000)
        return errorResponse(413, "repository_limit", "Repository listing exceeds its limit.");
      if (rows.results.some((row) => !row.artifact_name || !row.remote))
        return errorResponse(
          503,
          "internal_error",
          "One or more repositories have unavailable storage."
        );
      return dataResponse(rows.results.map((row) => repoResponse(row, null, row.can_write === 1)));
    }
    if (request.method === "POST" && url.pathname === "/repositories") {
      const parsed = CreateRepositoryInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid repository payload.");
      const groupLimits = groupLimitsFor(env, user);
      const repositoryCount = await countCreatedRepositories(env, user.id);
      if (repositoryCount >= groupLimits.maxRepositories)
        return quotaExceededResponse(
          "Repository limit reached for this user group. Deleted repositories count until they are purged.",
          {
            resource: "repositories",
            used: repositoryCount,
            limit: groupLimits.maxRepositories,
          }
        );
      const namespace = await namespaceForUser(env, user.id, parsed.data.owner);
      if (!namespace) return errorResponse(404, "not_found", "Repository owner was not found.");
      if (!canCreateRepository(namespace, user.id))
        return errorResponse(
          403,
          "forbidden",
          "Repository creation requires namespace owner access."
        );
      const now = Date.now(),
        id = crypto.randomUUID(),
        artifactName = `repo-${id}`;
      try {
        await env.DB.prepare(
          "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'main', ?, ?, ?, ?)"
        )
          .bind(
            id,
            namespace.id,
            user.id,
            parsed.data.slug,
            `repo:${id}`,
            parsed.data.visibility,
            parsed.data.description,
            now,
            now
          )
          .run();
      } catch (cause) {
        if (
          cause instanceof Error &&
          (cause.message.includes("UNIQUE") || cause.message.includes("repository path"))
        )
          return errorResponse(
            409,
            "conflict",
            "Repository name is already used or reserved by a rename."
          );
        throw cause;
      }
      let createdArtifact: { name: string; remote: string };
      try {
        const created = await env.ARTIFACTS.create(artifactName, {
          setDefaultBranch: "main",
          description: parsed.data.description,
        });
        using artifact = await env.ARTIFACTS.get(created.name);
        if (!(await artifact.revokeToken(created.token)))
          throw new Error("Initial repository token could not be revoked.");
        createdArtifact = { name: created.name, remote: created.remote };
        await env.DB.prepare(
          "UPDATE repositories SET artifact_name = ?, remote = ?, updated_at = ? WHERE id = ?"
        )
          .bind(createdArtifact.name, createdArtifact.remote, Date.now(), id)
          .run();
      } catch (cause) {
        await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(id).run();
        logger.error("forge:repository-artifact-create-failed", {
          repositoryId: id,
          namespaceId: namespace.id,
          error: cause instanceof Error ? cause.message : "unknown",
        });
        return errorResponse(503, "internal_error", "Repository storage is unavailable.");
      }
      await env.DB.prepare("INSERT INTO forge_counters (repository_id) VALUES (?)").bind(id).run();
      const created: RepositoryRow = {
        id,
        namespace_id: namespace.id,
        owner: namespace.slug,
        slug: parsed.data.slug,
        visibility: parsed.data.visibility,
        description: parsed.data.description,
        created_at: now,
        updated_at: Date.now(),
        artifact_name: createdArtifact.name,
        remote: createdArtifact.remote,
        default_branch: "main",
      };
      logger.info("forge:repository-created", {
        repositoryId: id,
        namespaceId: namespace.id,
        userId: user.id,
        artifactName: createdArtifact.name,
      });
      if (parsed.data.initializeReadme) {
        const initialHeaders = trustedHeaders(user);
        initialHeaders.set("Content-Type", "application/json");
        const initial = await env.GIT.fetch(
          new Request(new URL(`/repositories/${id}/edit`, request.url), {
            method: "POST",
            headers: initialHeaders,
            body: JSON.stringify({
              branch: "main",
              expectedOid: null,
              path: "README.md",
              content: `# ${parsed.data.slug}\n\n${parsed.data.description}\n`,
              message: "Initialize repository",
            }),
          })
        );
        if (!initial.ok)
          return errorResponse(
            503,
            "initialization_failed",
            "Repository was created but README initialization failed. Open the repository to retry."
          );
      }
      return dataResponse(repoResponse(created, "admin", true), 201);
    }

    const repositoryId = parts[1];
    if (parts[0] !== "repositories" || !repositoryId)
      return errorResponse(404, "not_found", "Endpoint was not found.");
    if (request.method === "GET" && repositoryId === "by-name" && parts[2] && parts[3]) {
      const path = await resolveRepositoryPath(env.DB, parts[2], parts[3]);
      const named = path ? await repositoryById(env, path.id) : null;
      if (!named) return repositoryNotFound();
      if (user.agentSession && named.id !== user.agentSession.repositoryId)
        return repositoryNotFound();
      const role = await repositoryRole(env.DB, named.id, user.id);
      if (named.visibility === "private" && role === null) return repositoryAccessDenied();
      if (!named.artifact_name || !named.remote)
        return errorResponse(503, "internal_error", "Repository storage is unavailable.");
      return dataResponse(
        repoResponse(
          named,
          role,
          writableRole(role) && canWriteSession(user, named.id)
        ) satisfies Repository
      );
    }
    const repository = await repositoryById(env, repositoryId);
    if (!repository) return repositoryNotFound();
    const access = await authorizeRepository(env, user, repository);
    if (access) return access;
    if (!repository.artifact_name || !repository.remote)
      return errorResponse(503, "internal_error", "Repository storage is unavailable.");
    if (request.method === "GET" && parts.length === 2) {
      const role = await repositoryRole(env.DB, repositoryId, user.id);
      return dataResponse(
        repoResponse(
          repository,
          role,
          writableRole(role) && canWriteSession(user, repositoryId)
        ) satisfies Repository
      );
    }
    if (parts[2] === "wiki" && !parts[3] && request.method === "GET") {
      if (repository.wiki_enabled === 0)
        return errorResponse(404, "feature_disabled", "Repository wiki is disabled.");
      const rows = await env.DB.prepare(
        "SELECT slug, title, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? ORDER BY slug ASC LIMIT ?"
      )
        .bind(repositoryId, MAX_LIST_ROWS + 1)
        .all<WikiPageSummary>();
      return boundedList(rows.results);
    }
    if (["memory", "tasks", "settings", "assignee-candidates"].includes(parts[2] ?? "")) {
      const viewer: Viewer = {
        user,
        member: await isMember(env, repositoryId, user.id),
        writeAllowed: canWriteSession(user, repositoryId),
        isOwner: async () => {
          if (user.agentSession) return false;
          return (await repositoryRole(env.DB, repositoryId, user.id)) === "admin";
        },
      };
      const memory = await memoryTaskRequest(env, request, repository, viewer, parts.slice(2));
      if (memory) return memory;
    }
    const lifecycle = await repositoryLifecycle(env, request, repository, user, parts);
    if (lifecycle) return lifecycle;
    const controls = await repositoryControls(env, request, repository, user, parts);
    if (controls) return controls;
    const feature = await featureRequest(env, user, repository, parts, request);
    if (feature) return feature;

    return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  },
  async scheduled(_controller: ScheduledController, env: ForgeEnv): Promise<void> {
    await purgeDueRepositories(env);
  },
};
