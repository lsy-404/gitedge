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

export interface AdminEnv {
  DB: D1Database;
  LOG_LEVEL?: string;
  SITE_ADMINS?: string;
  USER_GROUP_LIMITS_JSON?: string;
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
    "SELECT r.id, n.slug AS owner, COALESCE(r.deleted_slug, r.slug) AS name, r.visibility, r.archived, u.identifier AS createdBy, r.created_at AS createdAt, r.deleted_at AS deletedAt FROM repositories r JOIN namespaces n ON n.id = r.namespace_id JOIN users u ON u.id = r.created_by WHERE (n.slug || '/' || COALESCE(r.deleted_slug, r.slug)) LIKE ?1 ESCAPE '\\' AND (?2 IS NULL OR r.created_at < ?2 OR (r.created_at = ?2 AND r.id < ?3)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?4"
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
  const now = Date.now();
  const row = disable
    ? await env.DB.prepare(
        "UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL AND deleted_at IS NULL RETURNING identifier"
      )
        .bind(now, target)
        .first<{ identifier: string }>()
    : await env.DB.prepare(
        "UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL AND deleted_at IS NULL RETURNING identifier"
      )
        .bind(target)
        .first<{ identifier: string }>();
  if (!row) return errorResponse(404, "not_found", "No matching user was found.");
  // Disabling ends interactive sign-ins; other credentials are rejected at validation.
  if (disable)
    await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(target).run();
  createLogger(env.LOG_LEVEL, { service: "admin" }).info("admin:user-disabled-changed", {
    adminId: admin.id,
    userId: target,
    disabled: disable,
  });
  await recordAudit(env, {
    action: disable ? "admin.user_disabled" : "admin.user_enabled",
    actor: auditActor(admin),
    target: { type: "user", id: target, label: row.identifier },
    subjectUserId: target,
  });
  return dataResponse({ id: target, disabled: disable });
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
  if (parts[1] === "users" && parts[2]) {
    if (method === "PATCH" && parts.length === 3) return updateUser(request, env, admin, parts[2]);
    if (method === "POST" && parts.length === 4 && parts[3] === "disable")
      return setDisabled(env, admin, parts[2], true);
    if (method === "POST" && parts.length === 4 && parts[3] === "enable")
      return setDisabled(env, admin, parts[2], false);
  }
  return errorResponse(404, "not_found", "Unknown admin endpoint.");
}
