import {
  ADMIN_PAGE_SIZE,
  UpdateAdminUserSchema,
  parseUserGroupLimits,
  type AdminGroup,
  type AdminPage,
  type AdminRepository,
  type AdminStats,
  type AdminUser,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { dataResponse, errorResponse, requireRecentAuth } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import { revokeUserAgentSessions, type AgentAuthEnv } from "./agents";
import { expireAccessBans } from "./access-bans";
import { ipMatchesRange } from "../../../packages/contracts/src/ip-access";
import {
  CreateAccessBanSchema,
  UpdateIpRpmSchema,
  IP_RPM_MAX,
  IP_RPM_MIN,
  parseIpRange,
  type AccessBan,
} from "../../../packages/contracts/src/ip-access";

export interface AdminEnv extends AgentAuthEnv {
  SITE_ADMINS?: string;
  USER_GROUP_LIMITS_JSON?: string;
}

interface AccessBanRow {
  id: string;
  kind: "user" | "ip";
  subjectValue: string;
  reason: string;
  expiresAt: number | null;
  createdAt: number;
  createdBy: string;
}

async function activeAccessBans(env: AdminEnv, now = Date.now()): Promise<AccessBan[]> {
  const rows = await env.DB.prepare(
    "SELECT b.id, b.kind, CASE WHEN b.kind = 'user' THEN u.identifier ELSE b.subject_value END AS subjectValue, b.reason, b.expires_at AS expiresAt, b.created_at AS createdAt, actor.identifier AS createdBy FROM access_bans b LEFT JOIN users u ON b.kind = 'user' AND u.id = b.subject_value JOIN users actor ON actor.id = b.created_by WHERE b.expires_at IS NULL OR b.expires_at > ? ORDER BY b.created_at DESC LIMIT 101"
  )
    .bind(now)
    .all<AccessBanRow>();
  if (rows.results.length > 100) throw new Error("Access ban list exceeds its limit.");
  return rows.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    value: row.subjectValue,
    reason: row.reason,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }));
}

async function listAccessBans(env: AdminEnv): Promise<Response> {
  try {
    return dataResponse(await activeAccessBans(env));
  } catch {
    return errorResponse(503, "internal_error", "Access bans could not be loaded.");
  }
}

async function createAccessBan(
  request: Request,
  env: AdminEnv,
  admin: TrustedUser
): Promise<Response> {
  const parsed = CreateAccessBanSchema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid access ban.");
  const input = parsed.data;
  const now = Date.now();
  if (input.expiresAt !== null && input.expiresAt <= now)
    return errorResponse(400, "bad_request", "The expiry must be in the future.");

  let value: string;
  if (input.kind === "ip") {
    try {
      value = parseIpRange(input.value);
    } catch {
      return errorResponse(400, "bad_request", "Enter a valid IP address or CIDR range.");
    }
    const clientIp = request.headers.get("CF-Connecting-IP");
    if (clientIp && ipMatchesRange(clientIp, value))
      return errorResponse(409, "conflict", "This range includes your current address.");
  } else {
    const user = await env.DB.prepare(
      "SELECT id, identifier, is_site_admin AS flagged, disabled_at AS disabledAt FROM users WHERE lower(identifier) = lower(?) AND deleted_at IS NULL"
    )
      .bind(input.value)
      .first<{ id: string; identifier: string; flagged: number; disabledAt: number | null }>();
    if (!user) return errorResponse(404, "not_found", "No matching user was found.");
    if (user.id === admin.id || isSiteAdmin(env, user.identifier, user.flagged === 1))
      return errorResponse(409, "conflict", "Administrator accounts cannot be banned.");
    if (user.disabledAt !== null)
      return errorResponse(409, "conflict", "Enable the account before adding a temporary ban.");
    value = user.id;
  }

  const createdAt = Date.now();
  if (input.expiresAt !== null && input.expiresAt <= createdAt)
    return errorResponse(400, "bad_request", "The expiry must be in the future.");
  const id = crypto.randomUUID();
  let changes: D1Result[];
  try {
    const statements = [
      env.DB.prepare(
        "INSERT INTO access_bans (id, kind, subject_value, reason, expires_at, created_at, created_by) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM access_bans WHERE expires_at IS NULL OR expires_at > ?) < 100 AND (? IS NULL OR ? > ?) AND (? <> 'user' OR EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL AND is_site_admin = 0))"
      ).bind(
        id,
        input.kind,
        value,
        input.reason,
        input.expiresAt,
        createdAt,
        admin.id,
        createdAt,
        input.expiresAt,
        input.expiresAt,
        createdAt,
        input.kind,
        value
      ),
    ];
    if (input.kind === "user") {
      const activeBan =
        "EXISTS (SELECT 1 FROM access_bans WHERE id = ? AND kind = 'user' AND subject_value = ?)";
      statements.push(
        env.DB.prepare(
          `UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL AND is_site_admin = 0 AND ${activeBan}`
        ).bind(createdAt, value, id, value),
        env.DB.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND ${activeBan}`).bind(
          value,
          id,
          value
        ),
        env.DB.prepare(
          `UPDATE auth_access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${activeBan}`
        ).bind(createdAt, value, id, value),
        env.DB.prepare(
          `UPDATE auth_git_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND ${activeBan}`
        ).bind(createdAt, value, id, value),
        env.DB.prepare(
          `UPDATE auth_agent_sessions SET status = 'revoked' WHERE user_id = ? AND status = 'active' AND ${activeBan}`
        ).bind(value, id, value)
      );
    }
    changes = await env.DB.batch(statements);
  } catch {
    try {
      const existing = await env.DB.prepare(
        "SELECT id FROM access_bans WHERE kind = ? AND subject_value = ?"
      )
        .bind(input.kind, value)
        .first<{ id: string }>();
      if (existing) return errorResponse(409, "conflict", "A matching active ban already exists.");
    } catch {
      // The failed write remains a service error when its cause cannot be identified.
    }
    createLogger(env.LOG_LEVEL, { service: "admin" }).error("admin:access-ban-write-failed", {
      kind: input.kind,
    });
    return errorResponse(503, "internal_error", "The access ban could not be saved.");
  }
  if (changes[0]?.meta.changes !== 1)
    return errorResponse(
      409,
      "conflict",
      "A matching ban exists or the active ban limit was reached."
    );
  if (input.kind === "user") {
    const revoked = await revokeUserAgentSessions(env, value, false);
    if (!revoked)
      createLogger(env.LOG_LEVEL, { service: "admin" }).warn(
        "admin:access-ban-agent-revoke-incomplete",
        {
          userId: value,
        }
      );
  }

  await recordAudit(env, {
    action: "admin.access_ban_added",
    actor: auditActor(admin),
    target: {
      type: input.kind,
      id: input.kind === "user" ? value : id,
      label: input.kind === "user" ? input.value : "IP address range",
    },
    subjectUserId: input.kind === "user" ? value : null,
    metadata: { reason: input.reason, expiresAt: input.expiresAt, kind: input.kind },
  });
  return dataResponse(
    {
      id,
      kind: input.kind,
      value: input.kind === "ip" ? value : input.value,
      reason: input.reason,
      expiresAt: input.expiresAt,
      createdAt,
      createdBy: admin.identifier,
    },
    201
  );
}

async function removeAccessBan(env: AdminEnv, admin: TrustedUser, id: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT id, kind, subject_value AS subjectValue, reason, expires_at AS expiresAt, created_at AS createdAt FROM access_bans WHERE id = ?"
  )
    .bind(id)
    .first<Omit<AccessBanRow, "createdBy">>();
  if (!row) return errorResponse(404, "not_found", "Access ban was not found.");
  const changes = await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at = ? AND EXISTS (SELECT 1 FROM access_bans WHERE id = ? AND kind = 'user' AND subject_value = ?)"
    ).bind(row.subjectValue, row.createdAt, id, row.subjectValue),
    env.DB.prepare("DELETE FROM access_bans WHERE id = ?").bind(id),
  ]);
  if (changes[1]?.meta.changes !== 1)
    return errorResponse(404, "not_found", "Access ban was not found.");
  await recordAudit(env, {
    action: "admin.access_ban_removed",
    actor: auditActor(admin),
    target: { type: row.kind, id: row.kind === "ip" ? id : row.subjectValue, label: row.kind },
    subjectUserId: row.kind === "user" ? row.subjectValue : null,
  });
  return dataResponse({ id, removed: true });
}

async function readIpRpm(env: AdminEnv): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT value FROM admin_settings WHERE key = 'ip_rpm_limit'"
  ).first<{ value: string }>();
  const rpm = Number(row?.value);
  if (!Number.isSafeInteger(rpm) || rpm < IP_RPM_MIN || rpm > IP_RPM_MAX)
    return errorResponse(500, "internal_error", "The IP request limit is invalid.");
  return dataResponse({ rpm });
}

async function updateIpRpm(request: Request, env: AdminEnv, admin: TrustedUser): Promise<Response> {
  const parsed = UpdateIpRpmSchema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid IP request limit.");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO admin_settings (key, value, updated_at) VALUES ('ip_rpm_limit', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(String(parsed.data.rpm), now)
    .run();
  await recordAudit(env, {
    action: "admin.ip_rpm_changed",
    actor: auditActor(admin),
    target: { type: "setting", id: "ip_rpm_limit", label: "IP requests per minute" },
    metadata: { rpm: parsed.data.rpm },
  });
  return dataResponse({ rpm: parsed.data.rpm });
}

function configuredAdmins(env: Pick<AdminEnv, "SITE_ADMINS">): Set<string> {
  return new Set(
    (env.SITE_ADMINS ?? "")
      .split(/[\s,]+/)
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** A site administrator is flagged in D1 or listed by username in `SITE_ADMINS`. */
export function isSiteAdmin(
  env: Pick<AdminEnv, "SITE_ADMINS">,
  identifier: string,
  flagged: boolean
): boolean {
  return flagged || configuredAdmins(env).has(identifier.toLowerCase());
}

interface UserRow {
  id: string;
  identifier: string;
  groupKey: string;
  createdAt: number;
  disabledAt: number | null;
  deletedAt: number | null;
  flagged: number;
}
interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  visibility: "public" | "private";
  archived: number;
  createdBy: string;
  createdAt: number;
  deletedAt: number | null;
}

const CURSOR_PATTERN = /^(\d{1,16})\.([\w-]{1,64})$/;
const MAX_QUERY = 63;

function pageSize(url: URL): number {
  const parsed = Number(url.searchParams.get("limit"));
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : ADMIN_PAGE_SIZE;
}

function searchPattern(url: URL): string {
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY).toLowerCase();
  return `%${query.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

function cursorOf(url: URL): { at: number | null; id: string } | "invalid" {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return { at: null, id: "" };
  const match = CURSOR_PATTERN.exec(raw);
  return match ? { at: Number(match[1]), id: match[2] } : "invalid";
}

function paged<T extends { createdAt: number; id: string }>(
  rows: readonly T[],
  limit: number
): AdminPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.id}` : null };
}

async function listUsers(env: AdminEnv, url: URL): Promise<Response> {
  const cursor = cursorOf(url);
  if (cursor === "invalid") return errorResponse(400, "bad_request", "Invalid cursor.");
  const limit = pageSize(url);
  const rows = await env.DB.prepare(
    "SELECT id, identifier, group_key AS groupKey, created_at AS createdAt, disabled_at AS disabledAt, deleted_at AS deletedAt, is_site_admin AS flagged FROM users WHERE identifier LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC LIMIT ?4"
  )
    .bind(searchPattern(url), cursor.at, cursor.id, limit + 1)
    .all<UserRow>();
  const configured = configuredAdmins(env);
  const users: AdminUser[] = rows.results.map((row) => ({
    id: row.id,
    identifier: row.identifier,
    groupKey: row.groupKey,
    createdAt: row.createdAt,
    disabledAt: row.disabledAt,
    deletedAt: row.deletedAt,
    siteAdmin: row.flagged === 1,
    configuredAdmin: configured.has(row.identifier.toLowerCase()),
  }));
  return dataResponse(paged(users, limit));
}

async function listRepositories(env: AdminEnv, url: URL): Promise<Response> {
  const cursor = cursorOf(url);
  if (cursor === "invalid") return errorResponse(400, "bad_request", "Invalid cursor.");
  const limit = pageSize(url);
  const rows = await env.DB.prepare(
    "SELECT r.id, n.slug AS owner, COALESCE(r.deleted_slug, r.slug) AS name, r.visibility, r.archived, u.identifier AS createdBy, r.created_at AS createdAt, r.deleted_at AS deletedAt FROM repositories r JOIN namespaces n ON n.id = r.namespace_id JOIN users u ON u.id = r.created_by WHERE r.system_kind IS NULL AND (n.slug || '/' || COALESCE(r.deleted_slug, r.slug)) LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR r.created_at < ?2 OR (r.created_at = ?2 AND r.id < ?3)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?4"
  )
    .bind(searchPattern(url), cursor.at, cursor.id, limit + 1)
    .all<RepositoryRow>();
  const repositories: AdminRepository[] = rows.results.map((row) => ({
    ...row,
    archived: row.archived === 1,
  }));
  return dataResponse(paged(repositories, limit));
}

async function stats(env: AdminEnv): Promise<Response> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL AND deleted_at IS NULL) AS disabled, (SELECT COUNT(*) FROM users WHERE deleted_at IS NOT NULL) AS deleted, (SELECT COUNT(*) FROM namespaces WHERE kind = 'organization') AS organizations, (SELECT COUNT(*) FROM repositories WHERE deleted_at IS NULL AND visibility = 'public') AS publicRepositories, (SELECT COUNT(*) FROM repositories WHERE deleted_at IS NULL AND visibility = 'private') AS privateRepositories, (SELECT COUNT(*) FROM repositories WHERE deleted_at IS NOT NULL) AS deletedRepositories, (SELECT COUNT(*) FROM invitations WHERE status = 'pending' AND expires_at > ?1) AS pendingInvitations, (SELECT COUNT(*) FROM audit_events WHERE created_at > ?2) AS audit"
  )
    .bind(now, now - 86_400_000)
    .first<Record<string, number>>();
  const value = (key: string): number => row?.[key] ?? 0;
  const result: AdminStats = {
    users: { total: value("users"), disabled: value("disabled"), deleted: value("deleted") },
    organizations: value("organizations"),
    repositories: {
      public: value("publicRepositories"),
      private: value("privateRepositories"),
      deleted: value("deletedRepositories"),
    },
    pendingInvitations: value("pendingInvitations"),
    auditEventsLast24Hours: value("audit"),
  };
  return dataResponse(result);
}

async function setDisabled(
  env: AdminEnv,
  admin: TrustedUser,
  target: string,
  disable: boolean
): Promise<Response> {
  if (disable && target === admin.id)
    return errorResponse(409, "conflict", "You cannot disable your own account.");
  if (disable) {
    const subject = await env.DB.prepare(
      "SELECT identifier, is_site_admin AS flagged FROM users WHERE id = ?"
    )
      .bind(target)
      .first<{ identifier: string; flagged: number }>();
    if (subject && isSiteAdmin(env, subject.identifier, subject.flagged === 1))
      return errorResponse(
        409,
        "conflict",
        "Remove administrator access before disabling this account."
      );
  }
  if (!disable) {
    const activeBan = await env.DB.prepare(
      "SELECT id FROM access_bans WHERE kind = 'user' AND subject_value = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
    )
      .bind(target, Date.now())
      .first<{ id: string }>();
    if (activeBan)
      return errorResponse(
        409,
        "conflict",
        "Remove the active access ban before enabling this account."
      );
  }
  const now = Date.now();
  const row = disable
    ? await env.DB.prepare(
        "UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL AND is_site_admin = 0 RETURNING identifier"
      )
        .bind(now, target)
        .first<{ identifier: string }>()
    : await env.DB.prepare(
        "UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL AND deleted_at IS NULL RETURNING identifier"
      )
        .bind(target)
        .first<{ identifier: string }>();
  if (!row) return errorResponse(404, "not_found", "No matching user was found.");
  // Sessions end now; tokens and Git credentials are rejected at validation, while agent
  // session forks hold direct Artifacts credentials and must be revoked explicitly.
  let revoked = true;
  if (disable) {
    await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(target).run();
    revoked = await revokeUserAgentSessions(env, target, false);
  }
  const logger = createLogger(env.LOG_LEVEL, { service: "admin" });
  logger.info("admin:user-disabled-changed", {
    adminId: admin.id,
    userId: target,
    disabled: disable,
  });
  if (!revoked) logger.warn("admin:agent-revocation-incomplete", { userId: target });
  await recordAudit(env, {
    action: disable ? "admin.user_disabled" : "admin.user_enabled",
    actor: auditActor(admin),
    target: { type: "user", id: target, label: row.identifier },
    subjectUserId: target,
  });
  return dataResponse({ id: target, disabled: disable, revocationIncomplete: !revoked });
}

async function updateUser(
  request: Request,
  env: AdminEnv,
  admin: TrustedUser,
  target: string
): Promise<Response> {
  const parsed = UpdateAdminUserSchema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid user update.");
  const { groupKey, siteAdmin } = parsed.data;
  if (groupKey !== undefined && !(groupKey in parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON)))
    return errorResponse(400, "bad_request", "Unknown user group.");
  if (siteAdmin !== undefined && target === admin.id)
    return errorResponse(409, "conflict", "You cannot change your own administrator flag.");
  if (siteAdmin === true) {
    const activeBan = await env.DB.prepare(
      "SELECT id FROM access_bans WHERE kind = 'user' AND subject_value = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1"
    )
      .bind(target, Date.now())
      .first<{ id: string }>();
    if (activeBan)
      return errorResponse(
        409,
        "conflict",
        "Remove the active access ban before granting administrator access."
      );
  }
  const row = await env.DB.prepare(
    "UPDATE users SET group_key = COALESCE(?, group_key), is_site_admin = COALESCE(?, is_site_admin) WHERE id = ? AND deleted_at IS NULL RETURNING identifier, group_key AS groupKey, is_site_admin AS flagged"
  )
    .bind(groupKey ?? null, siteAdmin === undefined ? null : Number(siteAdmin), target)
    .first<{ identifier: string; groupKey: string; flagged: number }>();
  if (!row) return errorResponse(404, "not_found", "User was not found.");
  const actor = auditActor(admin);
  const label = row.identifier;
  if (groupKey !== undefined)
    await recordAudit(env, {
      action: "admin.user_group_changed",
      actor,
      target: { type: "user", id: target, label },
      subjectUserId: target,
      metadata: { groupKey },
    });
  if (siteAdmin !== undefined)
    await recordAudit(env, {
      action: "admin.user_site_admin_changed",
      actor,
      target: { type: "user", id: target, label },
      subjectUserId: target,
      metadata: { siteAdmin },
    });
  return dataResponse({ id: target, groupKey: row.groupKey, siteAdmin: row.flagged === 1 });
}

/** Site administration for browser sessions of site administrators; mutations need recent authentication. */
export async function handleAdmin(
  request: Request,
  env: AdminEnv,
  admin: TrustedUser & { readonly siteAdmin?: true }
): Promise<Response> {
  if (request.headers.has("Authorization") || !admin.siteAdmin)
    return errorResponse(403, "forbidden", "Site administrator access is required.");
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  if (method !== "GET") {
    if (request.headers.get("Origin") !== url.origin)
      return errorResponse(403, "forbidden", "Same-origin account management is required.");
    const reauth = requireRecentAuth(admin);
    if (reauth) return reauth;
  }
  await expireAccessBans(env);
  if (method === "GET" && parts.length === 2) {
    if (parts[1] === "users") return listUsers(env, url);
    if (parts[1] === "repositories") return listRepositories(env, url);
    if (parts[1] === "stats") return stats(env);
    if (parts[1] === "groups") {
      const groups: AdminGroup[] = Object.entries(parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON))
        .map(([key, limits]) => ({
          key,
          rpm: limits.rpm,
          maxRepositories: limits.maxRepositories,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
      return dataResponse(groups);
    }
  }
  if (parts[1] === "access-bans") {
    if (method === "GET" && parts.length === 2) return listAccessBans(env);
    if (method === "POST" && parts.length === 2) return createAccessBan(request, env, admin);
    if (method === "DELETE" && parts.length === 3) return removeAccessBan(env, admin, parts[2]);
  }
  if (parts[1] === "ip-rpm") {
    if (method === "GET" && parts.length === 2) return readIpRpm(env);
    if (method === "PUT" && parts.length === 2) return updateIpRpm(request, env, admin);
  }
  if (parts[1] === "users" && parts[2]) {
    if (method === "PATCH" && parts.length === 3) return updateUser(request, env, admin, parts[2]);
    if (method === "POST" && parts.length === 4 && parts[3] === "disable")
      return setDisabled(env, admin, parts[2], true);
    if (method === "POST" && parts.length === 4 && parts[3] === "enable")
      return setDisabled(env, admin, parts[2], false);
  }
  return errorResponse(404, "not_found", "Unknown admin endpoint.");
}
