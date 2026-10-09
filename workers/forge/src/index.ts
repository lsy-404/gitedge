import {
  repositoryAccessDenied,
  repositoryNotFound,
} from "../../../src/worker/common/repository-response";
import { actionsCheck, attachActionChecks } from "./actions-checks";
import {
  aiSummaryRequest,
  drainAiSummaries,
  enqueueAiSummary,
  purgeAiSummaryRecords,
} from "./ai-summary";
import { authorizeMerge, blockerResponse } from "./merge-policy";
import { reconcileRepository, sweepMergeAutomation } from "./merge-automation";
import { mergeAutomationRoutes } from "./merge-routes";
import { executeMerge, hasActiveMergeLease } from "./merge-execution";
import { compareRequest, pullHead, pullRequestHeadOid, setHeadParams } from "./pull-git";
import { issueReferences, syncLinkStatements } from "./issue-links";
import {
  announcePublishedComments,
  listReviewComments,
  publishPendingStatements,
  reviewCommentRequest,
} from "./review-comments";
import { commentEvent, mentionAgents, pullRequestEvent, revokeAgentSessions } from "./agent-events";
import { agentFeedStatus, handleAgentFeed, purgeAgentFeeds } from "./agent-feed";
import { publicProfile } from "./profiles";
import { detachForks, publicForkList, repositoryForks, type ForkContext } from "./forks";
import {
  handleExplore,
  handleStarred,
  repositorySocial,
  repositorySocialFields,
  socialFieldsFor,
} from "./social";
import {
  handleNotifications,
  outcomeNotificationStatement,
  purgeReadNotifications,
  threadNotificationStatements,
  watcherNotificationStatement,
} from "./notifications";
import {
  checkRunWebhook,
  commentWebhook,
  issueWebhook,
  pullRequestWebhook,
  queueWebhookEvent,
  reviewWebhook,
} from "./webhook-events";
import {
  drainWebhookDeliveries,
  handlePushEvent,
  handleRepositoryWebhooks,
  purgeWebhookDeliveries,
} from "./webhooks";
import {
  repositoryRole,
  resolveRepositoryPath,
  writableRole,
} from "../../../src/worker/common/repositories";
import { repositoryControls } from "./controls";
import { publicReleaseRead, repositoryReleases } from "./releases";
import {
  deleteOrganization,
  deletedRepositories,
  purgeDueRepositories,
  repositoryLifecycle,
} from "./lifecycle";
import {
  accessTokenAllowsRepository,
  accessTokenPermits,
  requiredAccessTokenScope,
  UpdateOrganizationMemberSchema,
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
import {
  auditActor,
  auditPageSize,
  readAuditPage,
  recordAudit,
} from "../../../src/worker/common/audit";
import { myInvitations, scopedInvitations } from "./invitations";
import { activeImportPath, handleRepositoryImports } from "./imports";
import { assignmentsColumn, parseAssignments, replaceAssignments } from "./assignments";
import {
  canWriteSession,
  repoResponse,
  isMember,
  nextNumber,
  parseActor,
  parseJson,
  repositoryById,
  type ForgeEnv,
  type RepositoryRow,
} from "./common";
import {
  memoryTaskRequest,
  releaseExpiredTaskLeases,
  targetStateProgressStatements,
  taskReferenceStatements,
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
  if (table === "forge_pull_requests")
    return `, ${assignmentsColumn("pull_request", alias)}, (SELECT n.slug FROM repositories h JOIN namespaces n ON n.id = h.namespace_id WHERE h.id = ${alias}.head_repository_id AND h.deleted_at IS NULL) AS head_owner, (SELECT h.slug FROM repositories h WHERE h.id = ${alias}.head_repository_id AND h.deleted_at IS NULL) AS head_name`;
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
  if (user.token && !accessTokenAllowsRepository(user.token, repository.id))
    return errorResponse(403, "forbidden", "Access token is limited to other repositories.");
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

/** Head used to decide whether review comments are outdated; null when it cannot be resolved. */
async function reviewCommentHead(
  env: ForgeEnv,
  requestUrl: string,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser | null
): Promise<string | null> {
  if (pull.state === "merged")
    return typeof pull.merge_head_oid === "string" ? pull.merge_head_oid : null;
  if (pull.state === "closed" && (pull.head_session_id || pull.head_repository_id)) return null;
  const gitUrl = new URL(`/repositories/${repository.id}/pull-head`, requestUrl);
  gitUrl.searchParams.set("head", String(pull.head_ref));
  setHeadParams(gitUrl, pullHead(pull));
  const response = await env.GIT.fetch(
    new Request(gitUrl, { headers: trustedHeaders(user ?? undefined) })
  );
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  const data = body && typeof body === "object" && "data" in body ? body.data : null;
  if (data && typeof data === "object" && "oid" in data && typeof data.oid === "string")
    return data.oid;
  if (!response.ok) await response.body?.cancel();
  createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id }).warn(
    "forge:review-comment-head-unavailable",
    { pullRequestId: String(pull.id), status: response.status }
  );
  return null;
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
      headRepositoryId: row.head_repository_id ?? null,
      headRepository:
        typeof row.head_owner === "string" && typeof row.head_name === "string"
          ? { owner: row.head_owner, name: row.head_name }
          : null,
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
  if (parts.length === 4)
    return dataResponse(
      repoResponse(repository, null, false, await socialFieldsFor(env, repository, null))
    );
  if (parts[4] === "forks" && parts.length === 5 && request.method === "GET")
    return publicForkList(env, repository);

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
  if (resource === "releases") {
    const releases = await publicReleaseRead(env, repository, suffix, request);
    if (releases) return releases;
  }
  const aiSummary = await aiSummaryRequest(env, request, repository, null, suffix);
  if (aiSummary) return aiSummary;
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
    resource === "issues" &&
    parts.length === 7 &&
    parts[6] === "references" &&
    Number.isSafeInteger(Number(parts[5]))
  ) {
    const issue = await env.DB.prepare(
      "SELECT id FROM forge_issues WHERE repository_id = ? AND number = ?"
    )
      .bind(repository.id, Number(parts[5]))
      .first<{ id: string }>();
    return issue
      ? issueReferences(env, issue.id)
      : errorResponse(404, "not_found", "Resource was not found.");
  }
  if (
    resource === "pull-requests" &&
    parts.length === 7 &&
    parts[6] === "review-comments" &&
    Number.isSafeInteger(Number(parts[5]))
  ) {
    const pull = await env.DB.prepare(
      "SELECT * FROM forge_pull_requests WHERE repository_id = ? AND number = ?"
    )
      .bind(repository.id, Number(parts[5]))
      .first<Record<string, unknown>>();
    if (!pull) return errorResponse(404, "not_found", "Pull request was not found.");
    return listReviewComments({
      env,
      repository,
      pull,
      user: null,
      actor: null,
      member: false,
      writeAllowed: false,
      mergeLeased: false,
      resolveHead: () => reviewCommentHead(env, request.url, repository, pull, null),
    });
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
      if (pull.state === "closed" && (pull.head_session_id || pull.head_repository_id))
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
      setHeadParams(gitUrl, pullHead(pull));
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
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO forge_issues (id, repository_id, number, author_id, actor_json, title, body, state, labels_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)"
        ).bind(
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
        ),
        watcherNotificationStatement(env.DB, repository, user, { kind: "issue", id, number }),
        ...(await threadNotificationStatements(
          env,
          repository,
          user,
          { kind: "issue", id, number },
          { body: parsed.data.body, participants: false }
        )),
        queueWebhookEvent(
          env.DB,
          repository.id,
          issueWebhook(repository, user, "opened", {
            number,
            title: parsed.data.title,
            body: parsed.data.body,
            state: "open",
            author: user.identifier,
          })
        ),
      ]);
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
      if (parsed.data.headRepositoryId) {
        if (actor.kind !== "user")
          return errorResponse(
            403,
            "forbidden",
            "Only a user can propose a pull request from a fork."
          );
        const fork = await env.DB.prepare(
          "SELECT id, visibility FROM repositories WHERE id = ? AND fork_of = ? AND deleted_at IS NULL AND artifact_name IS NOT NULL"
        )
          .bind(parsed.data.headRepositoryId, repository.id)
          .first<{ id: string; visibility: "public" | "private" }>();
        const forkRole = fork ? await repositoryRole(env.DB, fork.id, user.id) : null;
        if (
          !fork ||
          (fork.visibility === "private" &&
            (forkRole === null ||
              (user.token && !accessTokenAllowsRepository(user.token, fork.id))))
        )
          return errorResponse(404, "not_found", "Pull request head repository was not found.");
        // Opening the pull request discloses a private fork's head to every base reader.
        if (fork.visibility === "private" && !writableRole(forkRole))
          return errorResponse(
            403,
            "forbidden",
            "Publishing a private fork branch requires write access to the fork."
          );
      }
      const number = await nextNumber(env, targetTable, repository.id),
        id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO forge_pull_requests (id, repository_id, number, author_id, actor_json, title, body, base_ref, head_ref, head_session_id, head_repository_id, draft, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)"
        ).bind(
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
          parsed.data.headRepositoryId,
          parsed.data.draft ? 1 : 0,
          now,
          now
        ),
        watcherNotificationStatement(env.DB, repository, user, {
          kind: "pull_request",
          id,
          number,
        }),
        ...(await threadNotificationStatements(
          env,
          repository,
          user,
          { kind: "pull_request", id, number },
          { body: parsed.data.body, participants: false }
        )),
        queueWebhookEvent(
          env.DB,
          repository.id,
          pullRequestWebhook(repository, user, "opened", {
            number,
            title: parsed.data.title,
            body: parsed.data.body,
            state: "open",
            author: user.identifier,
            baseRef: parsed.data.baseRef,
            headRef: parsed.data.headRef,
            draft: parsed.data.draft,
            merged: false,
            mergedOid: null,
          })
        ),
        ...syncLinkStatements(env, repository, id, parsed.data.title, parsed.data.body, now),
        ...taskReferenceStatements(
          env,
          repository,
          id,
          parsed.data,
          actor,
          member && writeAllowed,
          now
        ),
      ]);
      if (
        repository.actions_enabled === 1 &&
        !parsed.data.headSessionId &&
        !parsed.data.headRepositoryId
      )
        await attachActionChecks(env, repository.id, id, parsed.data.headRef);
      await mentionAgents(env, repository, user, parsed.data.body, {
        targetKind: "pull_request",
        targetId: id,
        number,
      });
      await pullRequestEvent(env, repository, user, id, { number, state: "open" });
      await enqueueAiSummary(env, repository, id, user.id, false);
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
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO forge_discussions (id, repository_id, number, author_id, actor_json, title, body, category, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)"
      ).bind(
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
      ),
      watcherNotificationStatement(env.DB, repository, user, { kind: "discussion", id, number }),
      ...(await threadNotificationStatements(
        env,
        repository,
        user,
        { kind: "discussion", id, number },
        { body: parsed.data.body, participants: false }
      )),
    ]);
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
      const commentTarget = {
        kind: targetKind,
        id: String(current.id),
        number,
      } as const;
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO forge_comments (id, repository_id, target_kind, target_id, actor_json, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          id,
          repository.id,
          targetKind,
          String(current.id),
          JSON.stringify(actor),
          user.id,
          parsed.data.body,
          now,
          now
        ),
        ...(await threadNotificationStatements(env, repository, user, commentTarget, {
          body: parsed.data.body,
          participants: true,
        })),
        ...(targetKind === "discussion"
          ? []
          : [
              queueWebhookEvent(
                env.DB,
                repository.id,
                commentWebhook(
                  repository,
                  user,
                  "created",
                  { kind: targetKind, number, title: String(current.title) },
                  { id, body: parsed.data.body }
                )
              ),
            ]),
      ]);
      const mentioned = await mentionAgents(env, repository, user, parsed.data.body, {
        targetKind,
        targetId: String(current.id),
        commentId: id,
      });
      await commentEvent(env, repository, user, commentTarget, id, mentioned);
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
            ? []
            : [
                queueWebhookEvent(
                  env.DB,
                  repository.id,
                  commentWebhook(
                    repository,
                    user,
                    "deleted",
                    { kind: targetKind, number, title: String(current.title) },
                    { id: subitem, body: comment.body }
                  )
                ),
              ]),
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
      await env.DB.batch([
        env.DB.prepare("UPDATE forge_comments SET body = ?, updated_at = ? WHERE id = ?").bind(
          parsed.data.body,
          Date.now(),
          subitem
        ),
        ...(await threadNotificationStatements(
          env,
          repository,
          user,
          { kind: targetKind, id: String(current.id), number },
          { body: parsed.data.body, previousBody: comment.body, participants: false }
        )),
        ...(targetKind === "discussion"
          ? []
          : [
              queueWebhookEvent(
                env.DB,
                repository.id,
                commentWebhook(
                  repository,
                  user,
                  "edited",
                  { kind: targetKind, number, title: String(current.title) },
                  { id: subitem, body: parsed.data.body }
                )
              ),
            ]),
      ]);
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
          ...(p.body !== undefined
            ? await threadNotificationStatements(
                env,
                repository,
                user,
                { kind: "issue", id: String(current.id), number },
                { body: p.body, previousBody: String(current.body), participants: false }
              )
            : []),
          queueWebhookEvent(
            env.DB,
            repository.id,
            issueWebhook(
              repository,
              user,
              stateChanged ? (p.state === "closed" ? "closed" : "reopened") : "edited",
              {
                number,
                title: p.title ?? String(current.title),
                body: p.body ?? String(current.body),
                state: p.state ?? String(current.state),
                author: String(current.author),
              }
            )
          ),
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
        const updateApplied = {
          sql: "EXISTS (SELECT 1 FROM forge_pull_requests WHERE id = ? AND updated_at = ?)",
          binds: [current.id, now],
        };
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
          ...((p.title !== undefined || p.body !== undefined) && current.state !== "merged"
            ? syncLinkStatements(
                env,
                repository,
                String(current.id),
                p.title ?? String(current.title),
                p.body ?? String(current.body),
                now
              )
            : []),
          ...(stateChanged
            ? targetStateProgressStatements(
                env,
                "pull_request",
                String(current.id),
                `Pull request #${number} ${p.state === "closed" ? "closed" : "reopened"} by ${actor.name}`,
                now
              )
            : []),
          ...(p.body !== undefined
            ? await threadNotificationStatements(
                env,
                repository,
                user,
                { kind: "pull_request", id: String(current.id), number },
                {
                  body: p.body,
                  previousBody: String(current.body),
                  participants: false,
                  when: updateApplied,
                }
              )
            : []),
          queueWebhookEvent(
            env.DB,
            repository.id,
            pullRequestWebhook(
              repository,
              user,
              stateChanged ? (p.state === "closed" ? "closed" : "reopened") : "edited",
              {
                number,
                title: p.title ?? String(current.title),
                body: p.body ?? String(current.body),
                state: p.state ?? String(current.state),
                author: String(current.author),
                baseRef: String(current.base_ref),
                headRef: String(current.head_ref),
                draft: p.draft ?? current.draft === 1,
                merged: false,
                mergedOid: null,
              }
            ),
            updateApplied
          ),
          ...((p.title !== undefined || p.body !== undefined) && current.state !== "merged"
            ? taskReferenceStatements(
                env,
                repository,
                String(current.id),
                { title: p.title ?? String(current.title), body: p.body ?? String(current.body) },
                actor,
                true,
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
        const [changed] = await env.DB.batch([
          env.DB.prepare(
            "UPDATE forge_discussions SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), answer_comment_id = CASE WHEN ? THEN ? ELSE answer_comment_id END, updated_at = ? WHERE id = ?"
          ).bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.answerCommentId === null ? 1 : p.answerCommentId ? 1 : 0,
            p.answerCommentId ?? null,
            Date.now(),
            current.id
          ),
          ...(p.body !== undefined
            ? await threadNotificationStatements(
                env,
                repository,
                user,
                { kind: "discussion", id: String(current.id), number },
                { body: p.body, previousBody: String(current.body), participants: false }
              )
            : []),
        ]);
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
        {
          kind: targetTable === "forge_issues" ? "issue" : "pull_request",
          id: String(current.id),
          number,
        },
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
    if (targetTable === "forge_pull_requests" && action === "review-comments")
      return reviewCommentRequest(
        {
          env,
          repository,
          pull: current,
          user,
          actor,
          member,
          writeAllowed,
          mergeLeased: hasActiveMergeLease(current),
          resolveHead: () => reviewCommentHead(env, request.url, repository, current, user),
        },
        request.method,
        request,
        parts.slice(4)
      );
    if (targetTable === "forge_issues" && action === "references" && request.method === "GET")
      return issueReferences(env, String(current.id));
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
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO forge_reviews (id, repository_id, pull_request_id, actor_json, author_id, actor_key, state, body, commit_oid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
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
        ),
        ...(await threadNotificationStatements(
          env,
          repository,
          user,
          { kind: "pull_request", id: String(current.id), number },
          { body: parsed.data.body, participants: true }
        )),
        queueWebhookEvent(
          env.DB,
          repository.id,
          reviewWebhook(
            repository,
            user,
            { number, title: String(current.title) },
            {
              id,
              state: parsed.data.state,
              body: parsed.data.body,
              commitOid: parsed.data.commitOid,
            }
          )
        ),
        ...publishPendingStatements(env, String(current.id), id, actor),
      ]);
      await announcePublishedComments(
        env,
        repository,
        user,
        { id: String(current.id), number },
        id
      );
      await pullRequestEvent(
        env,
        repository,
        user,
        String(current.id),
        { number, reviewId: id, state: parsed.data.state, commitOid: parsed.data.commitOid },
        "review.submitted"
      );
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
      const checkApplied = {
        sql: "EXISTS (SELECT 1 FROM forge_check_runs WHERE pull_request_id = ? AND commit_oid = ? AND name = ? AND actor_key = ? AND updated_at = ?)",
        binds: [String(current.id), parsed.data.commitOid, parsed.data.name, key, now],
      };
      const [upserted] = await env.DB.batch<Record<string, unknown>>([
        env.DB.prepare(
          "INSERT INTO forge_check_runs (id, repository_id, pull_request_id, actor_json, actor_key, name, commit_oid, status, conclusion, summary, details_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pull_request_id, commit_oid, name, actor_key) DO UPDATE SET actor_json = excluded.actor_json, status = excluded.status, conclusion = excluded.conclusion, summary = excluded.summary, details_url = excluded.details_url, updated_at = excluded.updated_at WHERE (forge_check_runs.status = 'queued' AND excluded.status IN ('queued', 'in_progress', 'completed')) OR (forge_check_runs.status = 'in_progress' AND excluded.status IN ('in_progress', 'completed')) OR (forge_check_runs.status = 'completed' AND excluded.status = 'completed') RETURNING *"
        ).bind(
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
        ),
        ...(parsed.data.status === "completed" && parsed.data.conclusion === "failure"
          ? [
              outcomeNotificationStatement(
                env.DB,
                repository,
                user.id,
                { kind: "pull_request", id: String(current.id), number },
                "check_failed",
                "owners",
                checkApplied
              ),
            ]
          : []),
        queueWebhookEvent(
          env.DB,
          repository.id,
          checkRunWebhook(repository, user, {
            name: parsed.data.name,
            status: parsed.data.status,
            conclusion: parsed.data.conclusion,
            commitOid: parsed.data.commitOid,
            summary: parsed.data.summary,
            pullRequestNumber: number,
          }),
          checkApplied
        ),
      ]);
      const check = upserted.results[0];
      if (!check)
        return errorResponse(
          409,
          "conflict",
          "Check run cannot move backwards from its current status."
        );
      if (parsed.data.status === "completed")
        await pullRequestEvent(
          env,
          repository,
          user,
          String(current.id),
          {
            number,
            name: parsed.data.name,
            conclusion: parsed.data.conclusion,
            commitOid: parsed.data.commitOid,
          },
          "check.completed"
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
      const outcome = await executeMerge(
        { env, repository, user, pull: current, requestUrl: request.url, trigger: "manual" },
        parsed.data
      );
      if (!outcome.ok) return blockerResponse(outcome.blocker);
      const merged = await env.DB.prepare(
        `SELECT pull.*, users.identifier AS author${assignmentsSelect("forge_pull_requests", "pull")} FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id WHERE pull.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return merged
        ? dataResponse(presentForgeRow(resource, merged))
        : errorResponse(404, "not_found", "Pull request was not found.");
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

function forkContext(env: ForgeEnv, user: TrustedUser): ForkContext {
  return {
    async resolveOwner(slug) {
      const namespace = await namespaceForUser(env, user.id, slug);
      return namespace
        ? {
            id: namespace.id,
            slug: namespace.slug,
            canCreate: canCreateRepository(namespace, user.id),
          }
        : null;
    },
    async checkQuota() {
      const limits = groupLimitsFor(env, user);
      const used = await countCreatedRepositories(env, user.id);
      return used >= limits.maxRepositories
        ? quotaExceededResponse(
            "Repository limit reached for this user group. Deleted repositories count until they are purged.",
            { resource: "repositories", used, limit: limits.maxRepositories }
          )
        : null;
    },
  };
}

const PERSONAL_RESOURCES: ReadonlySet<string> = new Set([
  "notifications",
  "notification-preferences",
  "stars",
]);
const WEBHOOK_CRON = "* * * * *";

const worker = {
  async fetch(request: Request, env: ForgeEnv, ctx?: ExecutionContext): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && url.pathname === "/internal/health")
      return dataResponse({ ok: true });
    if (request.method === "GET" && url.pathname === "/internal/health/d1")
      return databaseHealth(env, logger);

    if (url.pathname === "/internal/actions-check")
      return actionsCheck(request, env, (id) => repositoryById(env, id));
    if (url.pathname === "/internal/push-event")
      return handlePushEvent(env, request, (id) => repositoryById(env, id));
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
        (pull.head_repository_id ?? null) !== (input.data.headRepositoryId ?? null) ||
        pull.merge_started_at !== input.data.leaseAt ||
        input.data.leaseAt < Date.now() - 300_000 ||
        pull.merge_base_oid !== input.data.expectedBaseOid ||
        pull.merge_head_oid !== input.data.expectedHeadOid
      )
        return errorResponse(409, "merge_changed", "Merge authorization expired or changed.");
      const repository = await repositoryById(env, String(pull.repository_id));
      if (!repository) return repositoryNotFound();
      const blocker = await authorizeMerge(env, repository, user, pull, input.data);
      return blocker ? blockerResponse(blocker) : dataResponse({ authorized: true });
    }
    if (request.method === "GET" && parts[0] === "profiles" && parts.length === 2)
      return publicProfile(env, request, parts[1], user);
    const exploring = await handleExplore(env, request, parts);
    if (exploring) return exploring;
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
    if (user.token) {
      if (!accessTokenPermits(user.token, "forge", request.method, parts))
        return errorResponse(
          403,
          "insufficient_scope",
          `Access token requires the ${requiredAccessTokenScope("forge", request.method, parts)} scope.`
        );
      if (
        user.token.repositoryIds &&
        !PERSONAL_RESOURCES.has(parts[0] ?? "") &&
        (parts[0] !== "repositories" ||
          !parts[1] ||
          (parts[1] !== "by-name" && !user.token.repositoryIds.includes(parts[1])))
      )
        return errorResponse(403, "forbidden", "Access token is limited to its repositories.");
    }
    if (
      user.agentSession &&
      (PERSONAL_RESOURCES.has(parts[0] ?? "") ||
        parts[0] !== "repositories" ||
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

    const personal = await handleNotifications(env, request, user, parts);
    if (personal) return personal;
    const starred = await handleStarred(env, request, user, parts);
    if (starred) return starred;

    const imported = await handleRepositoryImports({
      request,
      env,
      user,
      parts,
      resolveOwner: async (slug) => {
        const namespace = await namespaceForUser(env, user.id, slug);
        return namespace
          ? {
              id: namespace.id,
              slug: namespace.slug,
              canCreate: canCreateRepository(namespace, user.id),
            }
          : null;
      },
      defer: (task) => (ctx ? ctx.waitUntil(task) : void task),
    });
    if (imported) return imported;

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
        const memberIdentifier = parts[3];
        if (request.method === "PATCH" && memberIdentifier && parts.length === 4) {
          const parsed = UpdateOrganizationMemberSchema.safeParse(await parseJson(request));
          if (!parsed.success)
            return errorResponse(400, "bad_request", "Invalid organization member payload.");
          const changed = await env.DB.prepare(
            "UPDATE namespace_memberships SET role = ?1 WHERE namespace_id = ?2 AND user_id = (SELECT id FROM users WHERE identifier = ?3) AND role <> ?1 AND NOT (role = 'owner' AND ?1 = 'member' AND (SELECT COUNT(*) FROM namespace_memberships WHERE namespace_id = ?2 AND role = 'owner') <= 1) RETURNING user_id"
          )
            .bind(parsed.data.role, organization.id, memberIdentifier)
            .first<{ user_id: string }>();
          if (!changed)
            return errorResponse(
              409,
              "conflict",
              "Member was not found, already has this role or is the last organization owner."
            );
          logger.info("forge:organization-member-role-changed", {
            organizationId: organization.id,
            role: parsed.data.role,
            userId: user.id,
          });
          await recordAudit(env, {
            action: "member.role_changed",
            actor: auditActor(user),
            target: { type: "user", id: changed.user_id, label: memberIdentifier },
            namespaceId: organization.id,
            metadata: { role: parsed.data.role },
          });
          return dataResponse({ identifier: memberIdentifier, role: parsed.data.role });
        }
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
          await detachForks(env, { namespaceId: organization.id, level: env.LOG_LEVEL });
          logger.info("forge:organization-member-removed", {
            organizationId: organization.id,
            identifier: memberIdentifier,
            userId: user.id,
          });
          await recordAudit(env, {
            action: "member.removed",
            actor: auditActor(user),
            target: { type: "user", id: result.user_id, label: memberIdentifier },
            namespaceId: organization.id,
          });
          if (!revoked) return dataResponse({ removed: true, revocationIncomplete: true }, 202);
          return new Response(null, { status: 204 });
        }
      }
      if (parts[2] === "invitations") {
        if (!organizationOwner(organization))
          return errorResponse(403, "forbidden", "Organization owner access is required.");
        return scopedInvitations(
          env,
          request,
          user,
          { kind: "organization", namespaceId: organization.id, label: organization.slug },
          parts.slice(3)
        );
      }
      if (parts[2] === "audit-log" && parts.length === 3 && request.method === "GET") {
        if (!organizationOwner(organization))
          return errorResponse(403, "forbidden", "Organization owner access is required.");
        const page = await readAuditPage(
          env.DB,
          "namespace_id",
          organization.id,
          url.searchParams.get("cursor"),
          auditPageSize(url.searchParams.get("limit"))
        );
        return page ? dataResponse(page) : errorResponse(400, "bad_request", "Invalid cursor.");
      }
      if (request.method === "DELETE" && parts.length === 2) {
        if (!organizationOwner(organization))
          return errorResponse(403, "forbidden", "Organization owner access is required.");
        return deleteOrganization(env, request, organization, user);
      }
      return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
    }
    if (parts[0] === "invitations") return myInvitations(env, request, user, parts);
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
      const social = await repositorySocialFields(env, rows.results, user.id);
      return dataResponse(
        rows.results.map((row) => repoResponse(row, null, row.can_write === 1, social.get(row.id)))
      );
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
      if (await activeImportPath(env, namespace.id, parsed.data.slug))
        return errorResponse(
          409,
          "conflict",
          "Repository name is reserved by an import in progress."
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

    if (
      request.method === "GET" &&
      parts[0] === "agents" &&
      parts[1] &&
      parts[2] === "event-feed" &&
      parts.length === 3
    )
      return agentFeedStatus(env, user, parts[1]);
    const repositoryId = parts[1];
    if (parts[0] !== "repositories" || !repositoryId)
      return errorResponse(404, "not_found", "Endpoint was not found.");
    if (request.method === "GET" && repositoryId === "by-name" && parts[2] && parts[3]) {
      const path = await resolveRepositoryPath(env.DB, parts[2], parts[3]);
      const named = path ? await repositoryById(env, path.id) : null;
      if (!named) return repositoryNotFound();
      if (user.agentSession && named.id !== user.agentSession.repositoryId)
        return repositoryNotFound();
      if (user.token && !accessTokenAllowsRepository(user.token, named.id))
        return repositoryNotFound();
      const role = await repositoryRole(env.DB, named.id, user.id);
      if (named.visibility === "private" && role === null) return repositoryAccessDenied();
      if (!named.artifact_name || !named.remote)
        return errorResponse(503, "internal_error", "Repository storage is unavailable.");
      return dataResponse(
        repoResponse(
          named,
          role,
          writableRole(role) && canWriteSession(user, named.id),
          await socialFieldsFor(env, named, user.id)
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
          writableRole(role) && canWriteSession(user, repositoryId),
          await socialFieldsFor(env, repository, user.id)
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
    const socialRoute = await repositorySocial(env, request, repository, user, parts);
    if (socialRoute) return socialRoute;
    const forks = await repositoryForks(
      env,
      request,
      repository,
      user,
      parts,
      forkContext(env, user)
    );
    if (forks) return forks;
    const agentFeed = await handleAgentFeed(env, request, repository, user, parts.slice(2), {
      defer: (task) => (ctx ? ctx.waitUntil(task) : void task),
    });
    if (agentFeed) return agentFeed;
    const lifecycle = await repositoryLifecycle(env, request, repository, user, parts);
    if (lifecycle) return lifecycle;
    const controls = await repositoryControls(env, request, repository, user, parts);
    if (controls) return controls;
    const hooks = await handleRepositoryWebhooks(env, request, repository, user, parts);
    if (hooks) return hooks;
    const releases = await repositoryReleases(env, request, repository, user, parts);
    if (releases) return releases;
    const mergeAutomation = await mergeAutomationRoutes(env, request, repository, user, parts);
    if (mergeAutomation) return mergeAutomation;
    const aiSummary = await aiSummaryRequest(env, request, repository, user, parts.slice(2));
    if (aiSummary) return aiSummary;
    const feature = await featureRequest(env, user, repository, parts, request);
    if (feature) return feature;

    return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  },
  async scheduled(controller: ScheduledController, env: ForgeEnv): Promise<void> {
    if (controller.cron === WEBHOOK_CRON) {
      await sweepMergeAutomation(env);
      await drainWebhookDeliveries(env);
      await drainAiSummaries(env);
      return;
    }
    await purgeDueRepositories(env);
    await detachForks(env, { level: env.LOG_LEVEL });
    await purgeAgentFeeds(env);
    await releaseExpiredTaskLeases(env);
    await purgeReadNotifications(env);
    await purgeWebhookDeliveries(env);
    await purgeAiSummaryRecords(env);
  },
};

/** Repository a successful write touched, for re-evaluating its auto-merge settings and merge queues. */
async function writtenRepositoryId(
  env: ForgeEnv,
  request: Request,
  body: Request | null
): Promise<string | null> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[0] === "repositories" && parts.length >= 3 && parts[1] !== "by-name") return parts[1];
  if (!body) return null;
  const input: unknown = await body.json().catch(() => null);
  if (!input || typeof input !== "object") return null;
  if ("repositoryId" in input && typeof input.repositoryId === "string") return input.repositoryId;
  if ("runId" in input && typeof input.runId === "string") {
    const run = await env.DB.prepare("SELECT repository_id FROM actions_runs WHERE id = ?")
      .bind(input.runId)
      .first<{ repository_id: string }>();
    return run?.repository_id ?? null;
  }
  return null;
}

async function reconcileAfterWrite(
  env: ForgeEnv,
  request: Request,
  body: Request | null
): Promise<void> {
  try {
    const repositoryId = await writtenRepositoryId(env, request, body);
    if (repositoryId) await reconcileRepository(env, repositoryId);
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "forge" }).error("forge:reconcile-failed", {
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
  await drainWebhookDeliveries(env);
}

export { MergeQueueDurableObject } from "./merge-queue";

/** Internal writes that can make a pull request mergeable; merge authorization runs inside a merge and must not start another pass. */
const RECONCILING_INTERNAL_PATHS = new Set(["/internal/actions-check", "/internal/push-event"]);

export default {
  async fetch(request: Request, env: ForgeEnv, ctx?: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    const internal = path.startsWith("/internal/");
    const writing = request.method !== "GET" && request.method !== "HEAD";
    const reconciling = writing && (!internal || RECONCILING_INTERNAL_PATHS.has(path));
    const internalBody = ctx && reconciling && internal ? request.clone() : null;
    const response = await worker.fetch(request, env, ctx);
    // Re-evaluate auto-merge and queues and deliver freshly queued webhooks right after a successful write instead of waiting for the next cron tick.
    if (ctx && response.ok && reconciling)
      ctx.waitUntil(reconcileAfterWrite(env, request, internalBody));
    else if (ctx && response.ok && writing) ctx.waitUntil(drainWebhookDeliveries(env));
    return response;
  },
  scheduled: worker.scheduled,
};
