import {
  CreateOrganizationInvitationSchema,
  CreateRepositoryInvitationSchema,
  INVITATION_TTL_MS,
  InvitationTokenInputSchema,
  MAX_PENDING_INVITATIONS,
  MAX_REPOSITORY_COLLABORATORS,
  sha256Hex,
  type CreatedInvitation,
  type Invitation,
  type InvitationKind,
  type InvitationStatus,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";

const TOKEN_PREFIX = "gei_";
const LIST_LIMIT = 100;
const TOKEN_ACTIONS = ["lookup", "accept", "decline"] as const;

interface InvitationRow {
  id: string;
  kind: InvitationKind;
  role: string;
  namespaceId: string;
  repositoryId: string | null;
  organization: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  inviter: string;
  invitee: string | null;
  inviteeUserId: string | null;
  inviteeEmail: string | null;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
}

const SELECT =
  "SELECT i.id, i.kind, i.role, COALESCE(r.namespace_id, i.namespace_id) AS namespaceId, i.repository_id AS repositoryId, CASE WHEN i.kind = 'organization' THEN n.slug END AS organization, rn.slug AS repositoryOwner, r.slug AS repositoryName, inviter.identifier AS inviter, invitee.identifier AS invitee, i.invitee_user_id AS inviteeUserId, i.invitee_email AS inviteeEmail, i.status, i.created_at AS createdAt, i.expires_at AS expiresAt FROM invitations i JOIN namespaces n ON n.id = i.namespace_id JOIN users inviter ON inviter.id = i.inviter_id LEFT JOIN users invitee ON invitee.id = i.invitee_user_id LEFT JOIN repositories r ON r.id = i.repository_id AND r.deleted_at IS NULL LEFT JOIN namespaces rn ON rn.id = r.namespace_id";
const LIVE = "(i.repository_id IS NULL OR r.id IS NOT NULL)";

function present(row: InvitationRow, now: number): Invitation {
  return {
    id: row.id,
    kind: row.kind,
    role: row.role,
    organization: row.organization,
    repository:
      row.repositoryId && row.repositoryOwner && row.repositoryName
        ? { id: row.repositoryId, owner: row.repositoryOwner, name: row.repositoryName }
        : null,
    inviter: row.inviter,
    invitee: row.invitee,
    inviteeEmail: row.inviteeEmail,
    status: row.status === "pending" && row.expiresAt <= now ? "expired" : row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export interface InvitationScope {
  kind: InvitationKind;
  namespaceId: string;
  /** Organization slug, or the repository's owner for repository invitations. */
  label: string;
  repository?: RepositoryRow;
}

async function collaboratorLimitReached(env: ForgeEnv, repositoryId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM repository_collaborators WHERE repository_id = ?"
  )
    .bind(repositoryId)
    .first<{ count: number }>();
  return (row?.count ?? 0) >= MAX_REPOSITORY_COLLABORATORS;
}

function scopeFilter(scope: InvitationScope): { sql: string; value: string } {
  return scope.repository
    ? { sql: "i.repository_id = ?", value: scope.repository.id }
    : { sql: "i.kind = 'organization' AND i.namespace_id = ?", value: scope.namespaceId };
}

async function createInvitation(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  scope: InvitationScope
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "invitations" });
  const raw = await parseJson(request);
  const parsed = scope.repository
    ? CreateRepositoryInvitationSchema.safeParse(raw)
    : CreateOrganizationInvitationSchema.safeParse(raw);
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid invitation payload.");
  const input = parsed.data;
  const now = Date.now();
  const filter = scopeFilter(scope);
  await env.DB.prepare(
    `UPDATE invitations AS i SET status = 'expired', resolved_at = ? WHERE i.status = 'pending' AND i.expires_at <= ? AND ${filter.sql}`
  )
    .bind(now, now, filter.value)
    .run();
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM invitations i WHERE i.status = 'pending' AND ${filter.sql}`
  )
    .bind(filter.value)
    .first<{ count: number }>();
  if ((pending?.count ?? 0) >= MAX_PENDING_INVITATIONS)
    return errorResponse(409, "member_limit", "Too many pending invitations. Cancel some first.");
  if (scope.repository && (await collaboratorLimitReached(env, scope.repository.id)))
    return errorResponse(409, "member_limit", "Collaborator limit reached.");

  let inviteeId: string | null = null;
  if (input.identifier !== undefined) {
    const person = await env.DB.prepare(
      "SELECT id FROM users WHERE identifier = ? AND disabled_at IS NULL"
    )
      .bind(input.identifier)
      .first<{ id: string }>();
    if (!person) return errorResponse(404, "not_found", "User was not found.");
    if (person.id === user.id) return errorResponse(409, "conflict", "You cannot invite yourself.");
    const member = await env.DB.prepare(
      "SELECT 1 AS found FROM namespace_memberships WHERE namespace_id = ? AND user_id = ?"
    )
      .bind(scope.namespaceId, person.id)
      .first();
    if (member)
      return errorResponse(
        409,
        scope.repository ? "inherited_access" : "already_member",
        scope.repository
          ? "This user already has access through the owner. Manage it in organization settings."
          : "This user is already an organization member."
      );
    if (scope.repository) {
      const collaborator = await env.DB.prepare(
        "SELECT 1 AS found FROM repository_collaborators WHERE repository_id = ? AND user_id = ?"
      )
        .bind(scope.repository.id, person.id)
        .first();
      if (collaborator)
        return errorResponse(
          409,
          "already_member",
          "This user is already a collaborator. Change their role instead."
        );
    }
    inviteeId = person.id;
  }

  const id = crypto.randomUUID();
  const token = inviteeId === null ? `${TOKEN_PREFIX}${randomHex(32)}` : null;
  const expiresAt = now + INVITATION_TTL_MS;
  try {
    await env.DB.prepare(
      "INSERT INTO invitations (id, kind, namespace_id, repository_id, role, inviter_id, invitee_user_id, invitee_email, token_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
    )
      .bind(
        id,
        scope.kind,
        scope.namespaceId,
        scope.repository?.id ?? null,
        input.role,
        user.id,
        inviteeId,
        input.email ?? null,
        token === null ? null : await sha256Hex(token),
        expiresAt,
        now
      )
      .run();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("UNIQUE"))
      return errorResponse(409, "invitation_pending", "An invitation is already pending.");
    throw cause;
  }
  const row = await env.DB.prepare(`${SELECT} WHERE i.id = ?`).bind(id).first<InvitationRow>();
  if (!row) return errorResponse(500, "internal_error", "Invitation could not be created.");
  // Notification delivery attaches to this event.
  logger.info("forge:invitation-created", {
    invitationId: id,
    kind: scope.kind,
    role: input.role,
    namespaceId: scope.namespaceId,
    repositoryId: scope.repository?.id,
    bound: inviteeId !== null,
  });
  await recordAudit(env, {
    action: "invitation.created",
    actor: auditActor(user),
    target: { type: "invitation", id, label: input.identifier ?? input.email ?? null },
    repositoryId: scope.repository?.id ?? null,
    namespaceId: scope.namespaceId,
    metadata: { kind: scope.kind, role: input.role, invitee: input.identifier ?? input.email },
  });
  const created: CreatedInvitation = { ...present(row, now), token };
  return dataResponse(created, 201);
}

async function listPending(env: ForgeEnv, scope: InvitationScope): Promise<Response> {
  const now = Date.now();
  const filter = scopeFilter(scope);
  const rows = await env.DB.prepare(
    `${SELECT} WHERE i.status = 'pending' AND i.expires_at > ? AND ${LIVE} AND ${filter.sql} ORDER BY i.created_at DESC LIMIT ?`
  )
    .bind(now, filter.value, LIST_LIMIT + 1)
    .all<InvitationRow>();
  return jsonResponse({
    data: rows.results.slice(0, LIST_LIMIT).map((row) => present(row, now)),
    truncated: rows.results.length > LIST_LIMIT,
  });
}

async function cancelInvitation(
  env: ForgeEnv,
  user: TrustedUser,
  scope: InvitationScope,
  id: string
): Promise<Response> {
  const filter = scopeFilter(scope);
  const cancelled = await env.DB.prepare(
    `UPDATE invitations AS i SET status = 'cancelled', resolved_at = ?, resolved_by = ? WHERE i.id = ? AND i.status = 'pending' AND ${filter.sql} RETURNING role`
  )
    .bind(Date.now(), user.id, id, filter.value)
    .first<{ role: string }>();
  if (!cancelled) return errorResponse(404, "not_found", "Pending invitation was not found.");
  await recordAudit(env, {
    action: "invitation.cancelled",
    actor: auditActor(user),
    target: { type: "invitation", id },
    repositoryId: scope.repository?.id ?? null,
    namespaceId: scope.namespaceId,
    metadata: { kind: scope.kind, role: cancelled.role },
  });
  return dataResponse({ cancelled: true });
}

/** Admin routes: `invitations` and `invitations/:id` beneath an organization or repository. */
export async function scopedInvitations(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  scope: InvitationScope,
  rest: string[]
): Promise<Response> {
  if (rest.length === 0 && request.method === "GET") return listPending(env, scope);
  if (rest.length === 0 && request.method === "POST")
    return createInvitation(env, request, user, scope);
  if (rest.length === 1 && request.method === "DELETE")
    return cancelInvitation(env, user, scope, rest[0]);
  return errorResponse(405, "method_not_allowed", "Method is not allowed.");
}

async function targetRow(
  env: ForgeEnv,
  user: TrustedUser,
  selector: { id: string } | { token: string }
): Promise<InvitationRow | null> {
  if ("id" in selector)
    return env.DB.prepare(`${SELECT} WHERE i.id = ? AND i.invitee_user_id = ? AND ${LIVE}`)
      .bind(selector.id, user.id)
      .first<InvitationRow>();
  return env.DB.prepare(`${SELECT} WHERE i.token_hash = ? AND ${LIVE}`)
    .bind(await sha256Hex(selector.token))
    .first<InvitationRow>();
}

async function resolveInvitation(
  env: ForgeEnv,
  user: TrustedUser,
  selector: { id: string } | { token: string },
  action: "accept" | "decline" | "lookup"
): Promise<Response> {
  const row = await targetRow(env, user, selector);
  if (!row) return errorResponse(404, "not_found", "Invitation was not found.");
  const now = Date.now();
  if (row.status !== "pending" || row.expiresAt <= now)
    return errorResponse(409, "invitation_closed", "This invitation is no longer pending.");
  if (action === "lookup") return dataResponse(present(row, now));

  if (action === "decline") {
    const declined = await env.DB.prepare(
      "UPDATE invitations SET status = 'declined', resolved_at = ?, resolved_by = ? WHERE id = ? AND status = 'pending' AND expires_at > ?"
    )
      .bind(now, user.id, row.id, now)
      .run();
    if (declined.meta.changes !== 1)
      return errorResponse(409, "invitation_closed", "This invitation is no longer pending.");
    await recordAudit(env, {
      action: "invitation.declined",
      actor: auditActor(user),
      target: { type: "invitation", id: row.id },
      repositoryId: row.repositoryId,
      namespaceId: row.namespaceId,
      metadata: { kind: row.kind, role: row.role },
    });
    return dataResponse({ ...present(row, now), status: "declined" });
  }

  const alreadyIn =
    row.kind === "organization"
      ? await env.DB.prepare(
          "SELECT 1 AS found FROM namespace_memberships WHERE namespace_id = ? AND user_id = ?"
        )
          .bind(row.namespaceId, user.id)
          .first()
      : await env.DB.prepare(
          "SELECT 1 AS found FROM repository_collaborators WHERE repository_id = ? AND user_id = ? UNION ALL SELECT 1 FROM namespace_memberships WHERE namespace_id = ? AND user_id = ?"
        )
          .bind(row.repositoryId, user.id, row.namespaceId, user.id)
          .first();
  if (alreadyIn)
    return errorResponse(409, "already_member", "You already have access to this resource.");

  const grant =
    row.kind === "organization"
      ? env.DB.prepare(
          "INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, created_at, role) SELECT namespace_id, ?1, ?2, role FROM invitations WHERE id = ?3 AND status = 'accepted' AND resolved_by = ?1 AND resolved_at = ?2"
        )
      : env.DB.prepare(
          "INSERT OR IGNORE INTO repository_collaborators (repository_id, user_id, role, created_at) SELECT repository_id, ?1, role, ?2 FROM invitations WHERE id = ?3 AND status = 'accepted' AND resolved_by = ?1 AND resolved_at = ?2"
        );
  const [claimed] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE invitations SET status = 'accepted', resolved_at = ?1, resolved_by = ?2 WHERE id = ?3 AND status = 'pending' AND expires_at > ?1 AND (kind = 'organization' OR (SELECT COUNT(*) FROM repository_collaborators c WHERE c.repository_id = invitations.repository_id) < ?4)"
    ).bind(now, user.id, row.id, MAX_REPOSITORY_COLLABORATORS),
    grant.bind(user.id, now, row.id),
  ]);
  if (claimed.meta.changes !== 1) {
    if (row.repositoryId && (await collaboratorLimitReached(env, row.repositoryId)))
      return errorResponse(409, "member_limit", "Collaborator limit reached.");
    return errorResponse(409, "invitation_closed", "This invitation is no longer pending.");
  }
  createLogger(env.LOG_LEVEL, { service: "invitations" }).info("forge:invitation-accepted", {
    invitationId: row.id,
    kind: row.kind,
    userId: user.id,
  });
  await recordAudit(env, {
    action: "invitation.accepted",
    actor: auditActor(user),
    target: { type: "invitation", id: row.id, label: user.identifier },
    repositoryId: row.repositoryId,
    namespaceId: row.namespaceId,
    metadata: { kind: row.kind, role: row.role, inviter: row.inviter },
  });
  return dataResponse({ ...present(row, now), status: "accepted" });
}

/** Invitee routes: list mine, accept or decline by id, and look up, accept or decline by link token. */
export async function myInvitations(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  parts: string[]
): Promise<Response> {
  if (user.agentSession)
    return errorResponse(403, "forbidden", "Agent sessions cannot manage invitations.");
  if (parts.length === 1 && request.method === "GET") {
    const now = Date.now();
    const rows = await env.DB.prepare(
      `${SELECT} WHERE i.invitee_user_id = ? AND i.status = 'pending' AND i.expires_at > ? AND ${LIVE} ORDER BY i.created_at DESC LIMIT ?`
    )
      .bind(user.id, now, LIST_LIMIT + 1)
      .all<InvitationRow>();
    return jsonResponse({
      data: rows.results.slice(0, LIST_LIMIT).map((row) => present(row, now)),
      truncated: rows.results.length > LIST_LIMIT,
    });
  }
  if (request.method !== "POST" || parts.length < 2 || parts.length > 3)
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const tokenAction = TOKEN_ACTIONS.find((name) => name === parts[1]);
  if (tokenAction && parts.length === 2) {
    const body = InvitationTokenInputSchema.safeParse(await parseJson(request));
    if (!body.success) return errorResponse(400, "bad_request", "Invalid invitation token.");
    return resolveInvitation(env, user, { token: body.data.token }, tokenAction);
  }
  const action = parts[2];
  if (parts.length === 3 && (action === "accept" || action === "decline"))
    return resolveInvitation(env, user, { id: parts[1] }, action);
  return errorResponse(404, "not_found", "Endpoint was not found.");
}
