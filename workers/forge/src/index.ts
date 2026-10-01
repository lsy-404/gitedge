import {
  AddOrganizationMemberInputSchema,
  CreateOrganizationInputSchema,
  CreateIssueInputSchema,
  CreatePullRequestInputSchema,
  CreateRepositoryInputSchema,
  PutWikiPageInputSchema,
  UpdateIssueInputSchema,
  UpdatePullRequestInputSchema,
  parseUserGroupLimits,
  type TrustedUser,
  CreateCommentInputSchema,
  CreateDiscussionInputSchema,
  CreateReviewInputSchema,
  PutCheckRunInputSchema,
  UpdateDiscussionInputSchema,
  MergePullRequestInputSchema,
  type Actor,
  ActorSchema,
  type Repository,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import {
  actorForUser,
  readTrustedUser,
  trustedHeaders,
} from "../../../packages/contracts/src/trust";

type ForgeEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: {
    create(
      name: string,
      options: { setDefaultBranch: string; description: string }
    ): Promise<{ name: string; token: string }>;
    get(name: string): Promise<{ remote: string; revokeToken(token: string): Promise<boolean> }>;
  };
  readonly GIT: { fetch(request: Request): Promise<Response> };
  readonly LOG_LEVEL?: string;
  readonly USER_GROUP_LIMITS_JSON?: string;
};
type RepositoryRow = {
  id: string;
  namespace_id: string;
  owner: string;
  slug: string;
  visibility: "public" | "private";
  description: string;
  artifact_name?: string | null;
  remote?: string | null;
  default_branch?: string;
  created_at: number;
  updated_at: number;
};
type NumberRow = { number: number | null };
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function parseJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
    "SELECT repositories.id, repositories.namespace_id, namespaces.slug AS owner, repositories.slug, repositories.visibility, repositories.description, repositories.created_at, repositories.updated_at, repositories.artifact_name, repositories.remote, repositories.default_branch FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE repositories.id = ?"
  )
    .bind(repositoryId)
    .first<RepositoryRow>();
}

async function isMember(env: ForgeEnv, repositoryId: string, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM repositories JOIN namespace_memberships ON namespace_memberships.namespace_id = repositories.namespace_id WHERE repositories.id = ? AND namespace_memberships.user_id = ?"
  )
    .bind(repositoryId, userId)
    .first<{ found: number }>();
  return row !== null;
}

function canWriteSession(user: TrustedUser, repositoryId: string): boolean {
  return (
    !user.agentSession ||
    (user.agentSession.repositoryId === repositoryId && user.agentSession.permission === "write")
  );
}

function hasActiveMergeLease(resource: Record<string, unknown>): boolean {
  return (
    typeof resource.merge_started_at === "number" &&
    resource.merge_started_at >= Date.now() - 60_000
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
    "SELECT auth_agent_sessions.id, auth_agent_sessions.agent_id, auth_agents.name AS agent_name, auth_agent_sessions.user_id, auth_agent_sessions.repository_id, auth_agent_sessions.workspace_name, auth_agent_sessions.permission, auth_agent_sessions.status, auth_agent_sessions.expires_at, auth_agents.disabled_at FROM auth_agent_sessions JOIN auth_agents ON auth_agents.id = auth_agent_sessions.agent_id WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ? AND EXISTS (SELECT 1 FROM repositories r JOIN namespace_memberships m ON m.namespace_id = r.namespace_id WHERE r.id = auth_agent_sessions.repository_id AND m.user_id = auth_agent_sessions.user_id)"
  )
    .bind(identity.id, user.id)
    .first<AgentSessionRow>();
  if (
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
    return error(401, "unauthorized", "Agent session is invalid or expired.");
  return null;
}

async function authorizeRepository(
  env: ForgeEnv,
  user: TrustedUser,
  repository: RepositoryRow,
  options: { member?: boolean; write?: boolean } = {}
): Promise<Response | null> {
  if (user.agentSession && user.agentSession.repositoryId !== repository.id)
    return error(403, "forbidden", "Agent session is limited to another repository.");
  if (options.write && !canWriteSession(user, repository.id))
    return error(403, "forbidden", "Read-only agent session cannot write.");
  const member = await isMember(env, repository.id, user.id);
  if (options.member && !member)
    return error(403, "forbidden", "Repository membership is required.");
  if (repository.visibility === "private" && !member)
    return error(404, "not_found", "Repository was not found.");
  return null;
}

async function publicRepositoryForOwnerAndSlug(
  env: ForgeEnv,
  owner: string,
  slug: string
): Promise<RepositoryRow | null> {
  return env.DB.prepare(
    "SELECT repositories.id, repositories.namespace_id, namespaces.slug AS owner, repositories.slug, repositories.visibility, repositories.description, repositories.created_at, repositories.updated_at, repositories.artifact_name, repositories.remote, repositories.default_branch FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE namespaces.slug = ? AND repositories.slug = ? AND repositories.visibility = 'public'"
  )
    .bind(owner, slug)
    .first<RepositoryRow>();
}

async function nextNumber(
  env: ForgeEnv,
  table: "forge_issues" | "forge_pull_requests" | "forge_discussions",
  repositoryId: string
): Promise<number> {
  const column = table === "forge_discussions" ? "discussion_number" : "conversation_number";
  await env.DB.prepare("INSERT OR IGNORE INTO forge_counters (repository_id) VALUES (?)")
    .bind(repositoryId)
    .run();
  const row = await env.DB.prepare(
    `UPDATE forge_counters SET ${column} = ${column} + 1 WHERE repository_id = ? RETURNING ${column} AS number`
  )
    .bind(repositoryId)
    .first<NumberRow>();
  if (!row?.number) throw new Error("Repository counter did not return a number.");
  return row.number;
}

function repoResponse(row: RepositoryRow, canWrite = false) {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    owner: row.owner,
    name: row.slug,
    slug: row.slug,
    artifactName: row.artifact_name ?? "",
    remote: row.remote ?? "",
    defaultBranch: row.default_branch ?? "main",
    visibility: row.visibility,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canWrite,
  } satisfies Omit<Repository, "createdAt"> & { createdAt: number };
}

function mergeResultOid(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = value.data;
  if (!data || typeof data !== "object" || !("oid" in data) || typeof data.oid !== "string")
    return null;
  return /^[0-9a-f]{40}$/.test(data.oid) ? data.oid : null;
}

function gitConflict(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("error" in value)) return false;
  const detail = value.error;
  return Boolean(
    detail && typeof detail === "object" && "code" in detail && detail.code === "conflict"
  );
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

function parseActor(value: unknown, authorId: unknown): Actor {
  try {
    const parsed = ActorSchema.safeParse(JSON.parse(String(value)));
    if (parsed.success) return parsed.data;
  } catch {
    /* malformed legacy actor data falls back to the stored user identity */
  }
  const id = typeof authorId === "string" ? authorId : "unknown";
  return { kind: "user", id, name: id };
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
      assignees: parseJsonArray(row.assignees_json),
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

async function publicRepositoryRead(env: ForgeEnv, parts: string[]): Promise<Response> {
  const owner = parts[2];
  const slug = parts[3];
  if (!owner || !slug) return error(404, "not_found", "Endpoint was not found.");

  const repository = await publicRepositoryForOwnerAndSlug(env, owner, slug);
  if (!repository) return error(404, "not_found", "Repository was not found.");
  if (!repository.artifact_name || !repository.remote)
    return error(503, "internal_error", "Repository storage is unavailable.");
  if (parts.length === 4) return json({ data: repoResponse(repository) });

  const resource = parts[4];
  if (resource === "issues" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT forge_issues.*, users.identifier AS author FROM forge_issues JOIN users ON users.id = forge_issues.author_id WHERE forge_issues.repository_id = ? ORDER BY forge_issues.number DESC"
    )
      .bind(repository.id)
      .all<Record<string, unknown>>();
    return json({ data: rows.results.map((row) => presentForgeRow("issues", row)) });
  }
  if (resource === "pull-requests" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT forge_pull_requests.*, users.identifier AS author FROM forge_pull_requests JOIN users ON users.id = forge_pull_requests.author_id WHERE forge_pull_requests.repository_id = ? ORDER BY forge_pull_requests.number DESC"
    )
      .bind(repository.id)
      .all<Record<string, unknown>>();
    return json({ data: rows.results.map((row) => presentForgeRow("pull-requests", row)) });
  }
  if (resource === "wiki" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? ORDER BY slug ASC"
    )
      .bind(repository.id)
      .all();
    return json({ data: rows.results });
  }
  if (resource === "wiki" && parts.length === 6) {
    const page = await env.DB.prepare(
      "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? AND slug = ?"
    )
      .bind(repository.id, parts[5])
      .first();
    return page ? json({ data: page }) : error(404, "not_found", "Wiki page was not found.");
  }
  if (resource === "discussions" && parts.length === 5) {
    const rows = await env.DB.prepare(
      "SELECT forge_discussions.*, users.identifier AS author FROM forge_discussions JOIN users ON users.id = forge_discussions.author_id WHERE forge_discussions.repository_id = ? ORDER BY forge_discussions.number DESC"
    )
      .bind(repository.id)
      .all<Record<string, unknown>>();
    return json({ data: rows.results.map((row) => presentForgeRow("discussions", row)) });
  }
  if (
    (resource === "issues" || resource === "pull-requests" || resource === "discussions") &&
    parts.length === 6
  ) {
    const number = Number(parts[5]);
    if (!Number.isSafeInteger(number) || number < 1)
      return error(404, "not_found", "Resource was not found.");
    const table =
      resource === "issues"
        ? "forge_issues"
        : resource === "pull-requests"
          ? "forge_pull_requests"
          : "forge_discussions";
    const row = await env.DB.prepare(
      `SELECT resource.*, users.identifier AS author FROM ${table} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? AND resource.number = ?`
    )
      .bind(repository.id, number)
      .first<Record<string, unknown>>();
    return row
      ? json({ data: presentForgeRow(resource, row) })
      : error(404, "not_found", "Resource was not found.");
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
    if (!target) return error(404, "not_found", "Resource was not found.");
    const rows = await env.DB.prepare(
      "SELECT * FROM forge_comments WHERE repository_id = ? AND target_kind = ? AND target_id = ? ORDER BY created_at ASC"
    )
      .bind(repository.id, targetKind, target.id)
      .all<Record<string, unknown>>();
    return json({ data: rows.results.map((row) => presentForgeRow("comments", row)) });
  }
  return error(404, "not_found", "Endpoint was not found.");
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
  const actor = actorFor(user);
  const member = await isMember(env, repository.id, user.id);
  const writeAllowed = canWriteSession(user, repository.id);
  const requireWrite = (): Response | null =>
    writeAllowed ? null : error(403, "forbidden", "Read-only agent session cannot write.");
  const requireMember = (): Response | null =>
    member && writeAllowed
      ? null
      : error(403, "forbidden", "Repository membership and a writable session are required.");
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
        `SELECT resource.*, users.identifier AS author FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? ORDER BY resource.number DESC`
      )
        .bind(repository.id)
        .all<Record<string, unknown>>();
      return json({ data: rows.results.map((row) => presentForgeRow(resource, row)) });
    }
    const denied = requireWrite();
    if (denied) return denied;
    if (targetTable === "forge_issues") {
      const parsed = CreateIssueInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid issue payload.");
      const number = await nextNumber(env, targetTable, repository.id),
        id = crypto.randomUUID(),
        now = Date.now();
      await env.DB.prepare(
        "INSERT INTO forge_issues (id, repository_id, number, author_id, actor_json, title, body, state, labels_json, assignees_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)"
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
          JSON.stringify(parsed.data.assignees),
          now,
          now
        )
        .run();
      logger.info("forge:issue-created", {
        repositoryId: repository.id,
        issueNumber: number,
        actorKind: actor.kind,
      });
      return json(
        {
          data: {
            id,
            number,
            ...parsed.data,
            state: "open",
            author: user.identifier,
            actor,
            createdAt: now,
            updatedAt: now,
          },
        },
        201
      );
    }
    if (targetTable === "forge_pull_requests") {
      const parsed = CreatePullRequestInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid pull request payload.");
      if (actor.kind === "agent" && parsed.data.headSessionId !== user.agentSession?.id)
        return error(403, "forbidden", "An agent pull request must use its own workspace session.");
      if (parsed.data.headSessionId) {
        const session = await env.DB.prepare(
          "SELECT id FROM auth_agent_sessions WHERE auth_agent_sessions.id = ? AND auth_agent_sessions.user_id = ? AND auth_agent_sessions.repository_id = ? AND auth_agent_sessions.status = 'active' AND auth_agent_sessions.expires_at > ? AND EXISTS (SELECT 1 FROM auth_agents a WHERE a.id = auth_agent_sessions.agent_id AND a.disabled_at IS NULL) AND EXISTS (SELECT 1 FROM repositories r JOIN namespace_memberships m ON m.namespace_id = r.namespace_id WHERE r.id = auth_agent_sessions.repository_id AND m.user_id = auth_agent_sessions.user_id)"
        )
          .bind(parsed.data.headSessionId, user.id, repository.id, Date.now())
          .first<{ id: string }>();
        if (!session)
          return error(
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
      logger.info("forge:pull-request-created", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        actorKind: actor.kind,
      });
      return json(
        {
          data: {
            id,
            number,
            ...parsed.data,
            state: "open",
            author: user.identifier,
            actor,
            mergedOid: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        201
      );
    }
    const parsed = CreateDiscussionInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return error(400, "bad_request", "Invalid discussion payload.");
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
    return json(
      {
        data: {
          id,
          number,
          ...parsed.data,
          state: "open",
          actor,
          answerCommentId: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      201
    );
  }
  if (targetTable && item) {
    const number = Number(item);
    if (!Number.isSafeInteger(number) || number < 1)
      return error(404, "not_found", "Resource was not found.");
    const current = await env.DB.prepare(
      `SELECT resource.*, users.identifier AS author FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.repository_id = ? AND resource.number = ?`
    )
      .bind(repository.id, number)
      .first<Record<string, unknown>>();
    if (!current) return error(404, "not_found", "Resource was not found.");
    if (request.method === "GET" && !action) {
      const itemRow = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return itemRow
        ? json({ data: presentForgeRow(resource, itemRow) })
        : error(404, "not_found", "Resource was not found.");
    }
    if (action === "comments" && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "GET") {
        const comments = await env.DB.prepare(
          "SELECT * FROM forge_comments WHERE repository_id = ? AND target_kind = ? AND target_id = ? ORDER BY created_at ASC"
        )
          .bind(repository.id, targetKind, String(current.id))
          .all<Record<string, unknown>>();
        return json({
          data: comments.results.map((comment) => presentForgeRow("comments", comment)),
        });
      }
      const denied = requireWrite();
      if (denied) return denied;
      const parsed = CreateCommentInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid comment payload.");
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
      logger.info("forge:comment-created", {
        repositoryId: repository.id,
        targetKind,
        targetId: current.id,
        actorKind: actor.kind,
      });
      return json(
        {
          data: presentForgeRow("comments", {
            id,
            actor_json: JSON.stringify(actor),
            body: parsed.data.body,
            created_at: now,
            updated_at: now,
          }),
        },
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
      if (!comment) return error(404, "not_found", "Comment was not found.");
      if (comment.author_id !== user.id && !member)
        return error(
          403,
          "forbidden",
          "Only the comment author or a repository member may change it."
        );
      const denied = requireWrite();
      if (denied) return denied;
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM forge_comments WHERE id = ?").bind(subitem).run();
        return new Response(null, { status: 204 });
      }
      const parsed = CreateCommentInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid comment payload.");
      await env.DB.prepare("UPDATE forge_comments SET body = ?, updated_at = ? WHERE id = ?")
        .bind(parsed.data.body, Date.now(), subitem)
        .run();
      const updatedComment = await env.DB.prepare("SELECT * FROM forge_comments WHERE id = ?")
        .bind(subitem)
        .first<Record<string, unknown>>();
      return updatedComment
        ? json({ data: presentForgeRow("comments", updatedComment) })
        : error(404, "not_found", "Comment was not found.");
    }
    if (request.method === "PATCH" && !action) {
      const input = await parseJson(request);
      if (targetTable === "forge_issues") {
        const parsed = UpdateIssueInputSchema.safeParse(input);
        if (!parsed.success) return error(400, "bad_request", "Invalid issue update.");
        const p = parsed.data;
        const isMember = member && writeAllowed;
        const isPublicAuthor =
          repository.visibility === "public" && current.author_id === user.id && writeAllowed;
        if (!isMember && !isPublicAuthor)
          return error(
            403,
            "forbidden",
            "Only repository members or the issue author may edit this issue."
          );
        if (!isMember && (p.labels !== undefined || p.assignees !== undefined))
          return error(
            403,
            "forbidden",
            "Only repository members may change issue labels or assignees."
          );
        const changed = await env.DB.prepare(
          "UPDATE forge_issues SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), labels_json = COALESCE(?, labels_json), assignees_json = COALESCE(?, assignees_json), updated_at = ? WHERE id = ?"
        )
          .bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.labels ? JSON.stringify(p.labels) : null,
            p.assignees ? JSON.stringify(p.assignees) : null,
            Date.now(),
            current.id
          )
          .run();
        if (changed.meta.changes !== 1)
          return error(409, "conflict", "Issue changed while it was being updated.");
      } else if (targetTable === "forge_pull_requests") {
        const denied = requireMember();
        if (denied) return denied;
        const staleMergeCutoff = Date.now() - 60_000;
        if (
          typeof current.merge_started_at === "number" &&
          current.merge_started_at >= staleMergeCutoff
        )
          return error(409, "conflict", "Pull request merge is in progress.");
        const parsed = UpdatePullRequestInputSchema.safeParse(input);
        if (!parsed.success) return error(400, "bad_request", "Invalid pull request update.");
        const p = parsed.data;
        const changed = await env.DB.prepare(
          "UPDATE forge_pull_requests SET title = COALESCE(?, title), body = COALESCE(?, body), state = COALESCE(?, state), draft = COALESCE(?, draft), updated_at = ?, merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND state != 'merged' AND (merge_started_at IS NULL OR merge_started_at < ?)"
        )
          .bind(
            p.title ?? null,
            p.body ?? null,
            p.state ?? null,
            p.draft === undefined ? null : p.draft ? 1 : 0,
            Date.now(),
            current.id,
            staleMergeCutoff
          )
          .run();
        if (changed.meta.changes !== 1)
          return error(
            409,
            "conflict",
            "Pull request changed while it was being updated or merged."
          );
      } else {
        const denied = requireMember();
        if (denied) return denied;
        const parsed = UpdateDiscussionInputSchema.safeParse(input);
        if (!parsed.success) return error(400, "bad_request", "Invalid discussion update.");
        const p = parsed.data;
        if (p.answerCommentId) {
          const answer = await env.DB.prepare(
            "SELECT id FROM forge_comments WHERE id = ? AND repository_id = ? AND target_kind = 'discussion' AND target_id = ?"
          )
            .bind(p.answerCommentId, repository.id, current.id)
            .first<{ id: string }>();
          if (!answer)
            return error(400, "bad_request", "Answer comment must belong to this discussion.");
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
          return error(409, "conflict", "Discussion changed while it was being updated.");
      }
      const updated = await env.DB.prepare(
        `SELECT resource.*, users.identifier AS author FROM ${targetTable} AS resource JOIN users ON users.id = resource.author_id WHERE resource.id = ?`
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      return json({ data: updated ? presentForgeRow(resource, updated) : null });
    }
    if (targetTable === "forge_pull_requests" && action === "reviews" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT * FROM forge_reviews WHERE pull_request_id = ? ORDER BY created_at DESC"
      )
        .bind(String(current.id))
        .all<Record<string, unknown>>();
      return json({ data: rows.results.map((row) => presentForgeRow("reviews", row)) });
    }
    if (
      targetTable === "forge_pull_requests" &&
      action === "reviews" &&
      request.method === "POST"
    ) {
      const denied = requireWrite();
      if (denied) return denied;
      if (current.state !== "open" || hasActiveMergeLease(current))
        return error(
          409,
          "conflict",
          "Reviews cannot change while this pull request is closed or merging."
        );
      const parsed = CreateReviewInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid review payload.");
      if (actor.kind === "agent" && !user.agentSession)
        return error(403, "forbidden", "Trusted agent session is required.");
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
      return json({ data: { id, ...parsed.data, actor, createdAt: now } }, 201);
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
        return json({ data: rows.results.map((row) => presentForgeRow("checks", row)) });
      }
      const denied = requireMember();
      if (denied) return denied;
      if (current.state !== "open" || hasActiveMergeLease(current))
        return error(
          409,
          "conflict",
          "Checks cannot change while this pull request is closed or merging."
        );
      const parsed = PutCheckRunInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid check run payload.");
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
        return error(409, "conflict", "Check run cannot move backwards from its current status.");
      logger.info("forge:check-run-recorded", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        checkName: parsed.data.name,
        commitOid: parsed.data.commitOid,
        status: parsed.data.status,
        conclusion: parsed.data.conclusion,
      });
      return json({ data: presentForgeRow("checks", check) }, check.id === id ? 201 : 200);
    }
    if (targetTable === "forge_pull_requests" && action === "diff" && request.method === "GET") {
      const baseRef = String(current.base_ref),
        headRef = String(current.head_ref),
        headSessionId = String(current.head_session_id ?? "");
      const gitUrl = new URL(`/repositories/${repository.id}/compare`, request.url);
      logger.debug("forge:pull-request-diff", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        baseRef,
        headRef,
        hasAgentSession: Boolean(headSessionId),
      });
      gitUrl.searchParams.set("base", baseRef);
      gitUrl.searchParams.set("head", headRef);
      if (headSessionId) gitUrl.searchParams.set("headSessionId", headSessionId);
      return env.GIT.fetch(new Request(gitUrl, { headers: trustedHeaders(user) }));
    }
    if (targetTable === "forge_pull_requests" && action === "merge" && request.method === "POST") {
      const denied = requireMember();
      if (denied) return denied;
      if (actor.kind !== "user")
        return error(403, "forbidden", "Only a human repository member may merge.");
      const parsed = MergePullRequestInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid merge payload.");
      if (current.state === "merged" && current.merged_oid) {
        const merged = await env.DB.prepare(
          "SELECT pull.*, users.identifier AS author FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id WHERE pull.id = ?"
        )
          .bind(current.id)
          .first<Record<string, unknown>>();
        return merged
          ? json({ data: presentForgeRow(resource, merged) })
          : error(404, "not_found", "Pull request was not found.");
      }
      if (current.state !== "open" || current.draft)
        return error(409, "conflict", "Pull request must be open and ready to merge.");

      const leaseAt = Date.now();
      const staleBefore = leaseAt - 60_000;
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
        return error(409, "conflict", "Another merge is in progress for this pull request.");
      const releaseLease = async (): Promise<void> => {
        await env.DB.prepare(
          "UPDATE forge_pull_requests SET merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND merge_started_at = ?"
        )
          .bind(current.id, leaseAt)
          .run();
      };

      const reviewRows = await env.DB.prepare(
        "SELECT state, actor_json, actor_key, author_id, EXISTS (SELECT 1 FROM repositories r JOIN namespace_memberships m ON m.namespace_id = r.namespace_id WHERE r.id = forge_reviews.repository_id AND m.user_id = forge_reviews.author_id) AS reviewer_is_member FROM forge_reviews WHERE pull_request_id = ? AND commit_oid = ? ORDER BY created_at DESC, rowid DESC"
      )
        .bind(String(current.id), parsed.data.expectedHeadOid)
        .all<{
          state: string;
          actor_json: string;
          actor_key: string;
          author_id: string;
          reviewer_is_member: number;
        }>();
      const latestByActor = new Map<
        string,
        { state: string; actor_json: string; author_id: string; reviewer_is_member: number }
      >();
      for (const review of reviewRows.results)
        if (!latestByActor.has(review.actor_key)) latestByActor.set(review.actor_key, review);
      const latestReviews = [...latestByActor.values()];
      if (
        latestReviews.some(
          (review) => review.state === "changes_requested" && review.reviewer_is_member === 1
        )
      ) {
        await releaseLease();
        logger.warn("forge:pull-request-merge-blocked-review", {
          repositoryId: repository.id,
          pullRequestNumber: number,
          commitOid: parsed.data.expectedHeadOid,
        });
        return error(409, "conflict", "The latest review for the current commit requests changes.");
      }
      const checks = await env.DB.prepare(
        "SELECT status, conclusion FROM forge_check_runs WHERE pull_request_id = ? AND commit_oid = ?"
      )
        .bind(String(current.id), parsed.data.expectedHeadOid)
        .all<{ status: string; conclusion: string | null }>();
      if (
        checks.results.some(
          (check) =>
            check.status !== "completed" ||
            (check.conclusion !== "success" && check.conclusion !== "neutral")
        )
      ) {
        await releaseLease();
        logger.warn("forge:pull-request-merge-blocked-checks", {
          repositoryId: repository.id,
          pullRequestNumber: number,
          commitOid: parsed.data.expectedHeadOid,
        });
        return error(409, "conflict", "Checks for the current commit are incomplete or failed.");
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
        return error(
          gitResponse.status === 409 ? 409 : 502,
          "conflict",
          gitConflict(payload) ? "Git refs changed during merge." : "Git merge failed."
        );
      }
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE forge_pull_requests SET state = 'merged', merged_oid = ?, updated_at = ?, merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND state = 'open' AND merge_started_at = ? AND merge_base_oid = ? AND merge_head_oid = ?"
      )
        .bind(
          oid,
          now,
          current.id,
          leaseAt,
          parsed.data.expectedBaseOid,
          parsed.data.expectedHeadOid
        )
        .run();
      const merged = await env.DB.prepare(
        "SELECT pull.*, users.identifier AS author FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id WHERE pull.id = ?"
      )
        .bind(current.id)
        .first<Record<string, unknown>>();
      if (merged?.state === "merged" && merged.merged_oid) {
        logger.info("forge:pull-request-merged", {
          repositoryId: repository.id,
          pullRequestNumber: number,
          mergedOid: merged.merged_oid,
        });
        return json({ data: presentForgeRow(resource, merged) });
      }
      return error(409, "conflict", "Pull request state changed after Git merge.");
    }
  }

  if (resource === "wiki" && item) {
    if (request.method === "GET") {
      if (action === "history") {
        const rows = await env.DB.prepare(
          "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? ORDER BY revision DESC"
        )
          .bind(repository.id, item)
          .all<{
            slug: string;
            title: string;
            content: string;
            revision: number;
            updatedBy: string;
            updatedAt: number;
          }>();
        return json({ data: rows.results });
      }
      if (action === "revisions" && subitem) {
        const page = await env.DB.prepare(
          "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? AND revision = ?"
        )
          .bind(repository.id, item, Number(subitem))
          .first();
        return page
          ? json({ data: page })
          : error(404, "not_found", "Wiki revision was not found.");
      }
      const page = await env.DB.prepare(
        "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? AND slug = ?"
      )
        .bind(repository.id, item)
        .first();
      return page ? json({ data: page }) : error(404, "not_found", "Wiki page was not found.");
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
          return error(
            400,
            "bad_request",
            "A current wiki revision is required to restore history."
          );
        const historical = await env.DB.prepare(
          "SELECT title, content FROM forge_wiki_revisions WHERE repository_id = ? AND slug = ? AND revision = ?"
        )
          .bind(repository.id, item, Number(subitem))
          .first<{ title: string; content: string }>();
        if (!historical) return error(404, "not_found", "Wiki revision was not found.");
        title = historical.title;
        content = historical.content;
        expected = input.expectedRevision;
      } else {
        const parsed = PutWikiPageInputSchema.safeParse(await parseJson(request));
        if (!parsed.success) return error(400, "bad_request", "Invalid wiki page payload.");
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
        return json(
          { data: { slug: item, title, content, revision: 1, updatedBy: user.id, updatedAt: now } },
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
        return error(409, "conflict", "Wiki page revision has changed.");
      return json({
        data: {
          slug: item,
          title,
          content,
          revision: expectedRevision + 1,
          updatedBy: user.id,
          updatedAt: now,
        },
      });
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: ForgeEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (request.method === "GET" && parts[0] === "public" && parts[1] === "repositories") {
      const publicUser = trustedUser(request);
      if (publicUser?.agentSession) {
        const sessionError = await activeAgentSession(env, publicUser);
        if (sessionError) return sessionError;
        const scopedRepo = await publicRepositoryForOwnerAndSlug(
          env,
          parts[2] ?? "",
          parts[3] ?? ""
        );
        if (!scopedRepo || scopedRepo.id !== publicUser.agentSession.repositoryId)
          return error(403, "forbidden", "Agent session is limited to another repository.");
      }
      return publicRepositoryRead(env, parts);
    }

    const user = trustedUser(request);
    if (!user) return error(401, "unauthorized", "Trusted user context is required.");
    const sessionError = await activeAgentSession(env, user);
    if (sessionError) return sessionError;
    if (
      user.agentSession &&
      (parts[0] !== "repositories" ||
        !parts[1] ||
        (parts[1] !== user.agentSession.repositoryId && parts[1] !== "by-name"))
    )
      return error(403, "forbidden", "Agent session is limited to its repository.");
    if (user.agentSession && request.method !== "GET" && parts[1] === "by-name")
      return error(
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
      return json({ data: rows.results.map(organizationResponse) });
    }
    if (request.method === "POST" && url.pathname === "/organizations") {
      const parsed = CreateOrganizationInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid organization payload.");
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
        return error(409, "conflict", "Organization slug already exists.");
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
      return json({ data: organizationResponse(organization) }, 201);
    }

    const organizationSlug = parts[1];
    if (parts[0] === "organizations" && organizationSlug) {
      const organization = await namespaceForUser(env, user.id, organizationSlug);
      if (!organization || organization.kind !== "organization")
        return error(404, "not_found", "Organization was not found.");
      if (request.method === "GET" && parts.length === 2)
        return json({ data: organizationResponse(organization) });
      if (parts[2] === "members") {
        if (request.method === "GET" && parts.length === 3) {
          if (!organization.role)
            return error(403, "forbidden", "Organization membership is required.");
          const rows = await env.DB.prepare(
            "SELECT users.identifier, namespace_memberships.role, namespace_memberships.created_at AS createdAt FROM namespace_memberships JOIN users ON users.id = namespace_memberships.user_id WHERE namespace_memberships.namespace_id = ? ORDER BY namespace_memberships.role DESC, users.identifier ASC"
          )
            .bind(organization.id)
            .all<OrganizationMemberRow>();
          return json({ data: rows.results });
        }
        if (!organizationOwner(organization))
          return error(403, "forbidden", "Organization owner access is required.");
        if (request.method === "POST" && parts.length === 3) {
          const parsed = AddOrganizationMemberInputSchema.safeParse(await parseJson(request));
          if (!parsed.success)
            return error(400, "bad_request", "Invalid organization member payload.");
          const result = await env.DB.prepare(
            "INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, created_at, role) SELECT ?, users.id, ?, ? FROM users WHERE users.identifier = ?"
          )
            .bind(organization.id, Date.now(), parsed.data.role, parsed.data.identifier)
            .run();
          if (result.meta.changes !== 1)
            return error(
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
          return json(
            { data: { identifier: parsed.data.identifier, role: parsed.data.role } },
            201
          );
        }
        const memberIdentifier = parts[3];
        if (request.method === "DELETE" && memberIdentifier && parts.length === 4) {
          const result = await env.DB.prepare(
            "DELETE FROM namespace_memberships WHERE namespace_id = ? AND user_id = (SELECT id FROM users WHERE identifier = ?) AND NOT (role = 'owner' AND (SELECT COUNT(*) FROM namespace_memberships WHERE namespace_id = ? AND role = 'owner') <= 1) RETURNING user_id"
          )
            .bind(organization.id, memberIdentifier, organization.id)
            .first<{ user_id: string }>();
          if (!result)
            return error(
              409,
              "conflict",
              "Member was not found or is the last organization owner."
            );
          logger.info("forge:organization-member-removed", {
            organizationId: organization.id,
            identifier: memberIdentifier,
            userId: user.id,
          });
          return new Response(null, { status: 204 });
        }
      }
      return error(405, "method_not_allowed", "Method is not allowed for this endpoint.");
    }

    if (request.method === "GET" && url.pathname === "/repositories") {
      const rows = await env.DB.prepare(
        "SELECT repositories.id, repositories.namespace_id, namespaces.slug AS owner, repositories.slug, repositories.visibility, repositories.description, repositories.created_at, repositories.updated_at, repositories.artifact_name, repositories.remote, repositories.default_branch FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id JOIN namespace_memberships ON namespace_memberships.namespace_id = repositories.namespace_id WHERE namespace_memberships.user_id = ? ORDER BY repositories.updated_at DESC"
      )
        .bind(user.id)
        .all<RepositoryRow>();
      if (rows.results.some((row) => !row.artifact_name || !row.remote))
        return error(503, "internal_error", "One or more repositories have unavailable storage.");
      return json({ data: rows.results.map((row) => repoResponse(row, true)) });
    }
    if (request.method === "POST" && url.pathname === "/repositories") {
      const parsed = CreateRepositoryInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return error(400, "bad_request", "Invalid repository payload.");
      const limits = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
      const groupLimits = limits[user.groupKey] ?? limits.free;
      const repositoryCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM repositories WHERE created_by = ?"
      )
        .bind(user.id)
        .first<{ count: number }>();
      if ((repositoryCount?.count ?? 0) >= groupLimits.maxRepositories)
        return error(403, "forbidden", "Repository limit reached for this user group.");
      const namespace = await namespaceForUser(env, user.id, parsed.data.owner);
      if (!namespace) return error(404, "not_found", "Repository owner was not found.");
      if (!canCreateRepository(namespace, user.id))
        return error(403, "forbidden", "Repository creation requires namespace owner access.");
      const now = Date.now(),
        id = crypto.randomUUID(),
        artifactName = `repo-${id}`;
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'main', ?, ?, ?, ?)"
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
      if (result.meta.changes !== 1)
        return error(409, "conflict", "Repository slug already exists.");
      let createdArtifact: { name: string; remote: string };
      try {
        const created = await env.ARTIFACTS.create(artifactName, {
          setDefaultBranch: "main",
          description: parsed.data.description,
        });
        const artifact = await env.ARTIFACTS.get(created.name);
        if (!(await artifact.revokeToken(created.token)))
          throw new Error("Initial repository token could not be revoked.");
        createdArtifact = { name: created.name, remote: artifact.remote };
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
        return error(503, "internal_error", "Repository storage is unavailable.");
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
      return json({ data: repoResponse(created, true) }, 201);
    }

    const repositoryId = parts[1];
    if (parts[0] !== "repositories" || !repositoryId)
      return error(404, "not_found", "Endpoint was not found.");
    if (request.method === "GET" && repositoryId === "by-name" && parts[2] && parts[3]) {
      const named = await env.DB.prepare(
        "SELECT repositories.id, repositories.namespace_id, namespaces.slug AS owner, repositories.slug, repositories.visibility, repositories.description, repositories.created_at, repositories.updated_at, repositories.artifact_name, repositories.remote, repositories.default_branch FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE namespaces.slug = ? AND repositories.slug = ?"
      )
        .bind(parts[2], parts[3])
        .first<RepositoryRow>();
      if (!named || (named.visibility === "private" && !(await isMember(env, named.id, user.id))))
        return error(404, "not_found", "Repository was not found.");
      if (user.agentSession && named.id !== user.agentSession.repositoryId)
        return error(403, "forbidden", "Agent session is limited to its repository.");
      if (!named.artifact_name || !named.remote)
        return error(503, "internal_error", "Repository storage is unavailable.");
      const member = await isMember(env, named.id, user.id);
      return json({
        data: repoResponse(named, member && canWriteSession(user, named.id)) satisfies Repository,
      });
    }
    const repository = await repositoryById(env, repositoryId);
    if (!repository) return error(404, "not_found", "Repository was not found.");
    const access = await authorizeRepository(env, user, repository);
    if (access) return access;
    if (!repository.artifact_name || !repository.remote)
      return error(503, "internal_error", "Repository storage is unavailable.");
    if (request.method === "GET" && parts.length === 2) {
      const member = await isMember(env, repositoryId, user.id);
      return json({
        data: repoResponse(
          repository,
          member && canWriteSession(user, repositoryId)
        ) satisfies Repository,
      });
    }
    if (parts[2] === "wiki" && !parts[3] && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT slug, title, content, revision, updated_by AS updatedBy, updated_at AS updatedAt FROM forge_wiki_pages WHERE repository_id = ? ORDER BY slug ASC"
      )
        .bind(repositoryId)
        .all();
      return json({ data: rows.results });
    }
    const feature = await featureRequest(env, user, repository, parts, request);
    if (feature) return feature;

    return error(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  },
};
