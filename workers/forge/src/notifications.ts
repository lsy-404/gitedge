import {
  ListNotificationsQuerySchema,
  MarkNotificationsReadInputSchema,
  MAX_MENTIONS,
  NOTIFICATION_RETENTION_MS,
  NOTIFICATION_UNREAD_COUNT_CAP,
  NotificationPreferencesSchema,
  extractMentions,
  type Notification,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationReason,
  type NotificationUnreadCount,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";

export interface NotificationTarget {
  readonly kind: "issue" | "pull_request" | "discussion";
  readonly id: string;
  readonly number: number;
}

const TARGET_TABLES = {
  issue: "forge_issues",
  pull_request: "forge_pull_requests",
  discussion: "forge_discussions",
} as const;
const PARTICIPANT_LIMIT = 500;
const PURGE_BATCH = 500;

/** Read access to repository `r` for user `u`: public, namespace member or collaborator. */
const USER_CAN_READ = `(r.visibility = 'public' OR EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = r.namespace_id AND m.user_id = u.id) OR EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = r.id AND c.user_id = u.id))`;
/** A pending, unexpired invitation of user `u` to repository `r`, which lets them see that one notification. */
const PENDING_INVITATION = `EXISTS (SELECT 1 FROM invitations iv WHERE iv.repository_id = r.id AND iv.invitee_user_id = u.id AND iv.status = 'pending' AND iv.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)`;
/** Listing access: readable repositories, plus invitations the user has not answered yet. */
const USER_CAN_SEE = `(${USER_CAN_READ} OR (n.reason = 'invited' AND ${PENDING_INVITATION}))`;
const REASON_NOT_MUTED = `NOT EXISTS (SELECT 1 FROM forge_notification_preferences p, json_each(p.muted_reasons_json) j WHERE p.user_id = u.id AND j.value = ?)`;
/** Users who silenced the repository receive nothing but invitations. */
const NOT_IGNORING = `NOT EXISTS (SELECT 1 FROM repository_watches w WHERE w.repository_id = r.id AND w.user_id = u.id AND w.level = 'ignore')`;
const UPSERT = `ON CONFLICT(recipient_id, subject_kind, subject_id) DO UPDATE SET reason = excluded.reason, subject_number = excluded.subject_number, actor_id = excluded.actor_id, created_at = excluded.created_at, read_at = NULL`;

/** Extra predicate that must hold when the batch runs, so a statement only fires if its sibling write applied. */
export interface StatementCondition {
  readonly sql: string;
  readonly binds: readonly unknown[];
}
interface RecipientSet {
  readonly sql: string;
  readonly binds: readonly unknown[];
}
interface Subject {
  readonly kind: NotificationTarget["kind"] | "repository";
  readonly id: string;
  readonly number: number | null;
}

// Id lists travel as one JSON bind because D1 caps a statement at 100 bound parameters.
function userIds(ids: readonly string[]): RecipientSet {
  return { sql: "SELECT value FROM json_each(?)", binds: [JSON.stringify(ids)] };
}

function ownerIds(target: NotificationTarget): RecipientSet {
  const assigned =
    target.kind === "discussion"
      ? ""
      : " UNION SELECT assignee_id FROM forge_assignments WHERE target_kind = ? AND target_id = ? AND assignee_kind = 'user'";
  return {
    sql: `SELECT author_id FROM ${TARGET_TABLES[target.kind]} WHERE id = ?${assigned}`,
    binds: target.kind === "discussion" ? [target.id] : [target.id, target.kind, target.id],
  };
}

function participantIds(target: NotificationTarget): RecipientSet {
  const owners = ownerIds(target);
  const reviewers =
    target.kind === "pull_request"
      ? " UNION SELECT author_id FROM forge_reviews WHERE pull_request_id = ?"
      : "";
  return {
    sql: `${owners.sql} UNION SELECT author_id FROM forge_comments WHERE target_kind = ? AND target_id = ?${reviewers} LIMIT ${PARTICIPANT_LIMIT}`,
    binds: [
      ...owners.binds,
      target.kind,
      target.id,
      ...(target.kind === "pull_request" ? [target.id] : []),
    ],
  };
}

function insertNotifications(
  db: D1Database,
  repositoryId: string,
  subject: Subject,
  reason: NotificationReason,
  actorId: string | null,
  recipients: RecipientSet,
  now: number,
  when?: StatementCondition,
  access = USER_CAN_READ
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO forge_notifications (id, recipient_id, repository_id, subject_kind, subject_id, subject_number, reason, actor_id, created_at, read_at) SELECT lower(hex(randomblob(16))), u.id, r.id, ?, ?, ?, ?, ?, ?, NULL FROM users u JOIN repositories r ON r.id = ? WHERE u.id IN (${recipients.sql}) AND u.id IS NOT ? AND r.deleted_at IS NULL AND ${access} AND ${reason === "invited" ? "1" : NOT_IGNORING} AND ${REASON_NOT_MUTED}${when ? ` AND (${when.sql})` : ""} ${UPSERT}`
    )
    .bind(
      subject.kind,
      subject.id,
      subject.number,
      reason,
      actorId,
      now,
      repositoryId,
      ...recipients.binds,
      actorId,
      reason,
      ...(when?.binds ?? [])
    );
}

/** Watchers of everything (`all`) learn about each new issue, pull request or discussion. */
export function watcherNotificationStatement(
  db: D1Database,
  repository: Pick<RepositoryRow, "id">,
  user: TrustedUser,
  target: NotificationTarget
): D1PreparedStatement {
  return insertNotifications(
    db,
    repository.id,
    target,
    "watching",
    user.id,
    {
      sql: `SELECT user_id FROM repository_watches WHERE repository_id = ? AND level = 'all' LIMIT ${PARTICIPANT_LIMIT}`,
      binds: [repository.id],
    },
    Date.now()
  );
}

/** Resolves mentioned logins to user ids; mentions already present in `previousBody` are skipped. */
export async function mentionedUserIds(
  env: ForgeEnv,
  body: string,
  previousBody = ""
): Promise<string[]> {
  const before = new Set(extractMentions(previousBody).users);
  const logins = extractMentions(body).users.filter((login) => !before.has(login));
  if (logins.length === 0) return [];
  if (logins.length > MAX_MENTIONS)
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("notifications:mentions-truncated", {
      count: logins.length,
    });
  const rows = await env.DB.prepare(
    "SELECT id FROM users WHERE identifier IN (SELECT value FROM json_each(?))"
  )
    .bind(JSON.stringify(logins.slice(0, MAX_MENTIONS)))
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/**
 * Statements for activity on a thread: thread participants receive `comment` when `participants`
 * is set, and newly mentioned users receive `mentioned`. Callers append them to the batch that
 * writes the activity so both land together.
 */
export async function threadNotificationStatements(
  env: ForgeEnv,
  repository: Pick<RepositoryRow, "id">,
  user: TrustedUser,
  target: NotificationTarget,
  options: {
    body: string;
    previousBody?: string;
    participants: boolean;
    when?: StatementCondition;
  }
): Promise<D1PreparedStatement[]> {
  const now = Date.now();
  const subject: Subject = target;
  const statements: D1PreparedStatement[] = [];
  if (options.participants)
    statements.push(
      insertNotifications(
        env.DB,
        repository.id,
        subject,
        "comment",
        user.id,
        participantIds(target),
        now,
        options.when
      )
    );
  const mentioned = await mentionedUserIds(env, options.body, options.previousBody);
  if (mentioned.length)
    statements.push(
      insertNotifications(
        env.DB,
        repository.id,
        subject,
        "mentioned",
        user.id,
        userIds(mentioned),
        now,
        options.when
      )
    );
  return statements;
}

export function assignmentNotificationStatement(
  db: D1Database,
  repository: Pick<RepositoryRow, "id">,
  user: TrustedUser,
  target: NotificationTarget,
  role: "assignee" | "reviewer",
  addedUserIds: readonly string[]
): D1PreparedStatement[] {
  if (addedUserIds.length === 0) return [];
  return [
    insertNotifications(
      db,
      repository.id,
      target,
      role === "assignee" ? "assigned" : "review_requested",
      user.id,
      userIds(addedUserIds),
      Date.now()
    ),
  ];
}

/** Notifies the pull request author and assignees (`owners`) or every participant of the outcome. */
export function outcomeNotificationStatement(
  db: D1Database,
  repository: Pick<RepositoryRow, "id">,
  actorId: string | null,
  target: NotificationTarget,
  reason: "merged" | "check_failed",
  scope: "owners" | "participants",
  when: StatementCondition
): D1PreparedStatement {
  return insertNotifications(
    db,
    repository.id,
    target,
    reason,
    actorId,
    scope === "owners" ? ownerIds(target) : participantIds(target),
    Date.now(),
    when
  );
}

/** Tells `recipients` that automation stopped acting on a pull request; the acting user is not excluded. */
export function automationNotificationStatement(
  db: D1Database,
  repository: Pick<RepositoryRow, "id">,
  target: NotificationTarget,
  reason: "auto_merge_disabled" | "queue_ejected",
  recipients: readonly string[]
): D1PreparedStatement {
  return insertNotifications(
    db,
    repository.id,
    target,
    reason,
    null,
    userIds([...new Set(recipients)]),
    Date.now()
  );
}

/** Notifies the invitee of a pending repository invitation, even before they can read the repository. */
export function invitationNotificationStatement(
  db: D1Database,
  invitation: { id: string; repositoryId: string; inviteeId: string },
  actorId: string,
  now: number
): D1PreparedStatement {
  return insertNotifications(
    db,
    invitation.repositoryId,
    { kind: "repository", id: invitation.repositoryId, number: null },
    "invited",
    actorId,
    userIds([invitation.inviteeId]),
    now,
    {
      sql: "EXISTS (SELECT 1 FROM invitations WHERE id = ? AND status = 'pending')",
      binds: [invitation.id],
    },
    `(${USER_CAN_READ} OR ${PENDING_INVITATION})`
  );
}

interface NotificationRow {
  id: string;
  reason: NotificationReason;
  subjectKind: Notification["subjectKind"];
  subjectNumber: number | null;
  title: string | null;
  createdAt: number;
  readAt: number | null;
  repositoryId: string;
  repositoryName: string;
  owner: string;
  actor: string | null;
}

function allowlist(user: TrustedUser): { sql: string; binds: string[] } {
  const ids = user.token?.repositoryIds;
  return ids
    ? {
        sql: " AND n.repository_id IN (SELECT value FROM json_each(?))",
        binds: [JSON.stringify(ids)],
      }
    : { sql: "", binds: [] };
}

async function listNotifications(
  env: ForgeEnv,
  user: TrustedUser,
  search: URLSearchParams
): Promise<Response> {
  const parsed = ListNotificationsQuerySchema.safeParse(Object.fromEntries(search));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid notification query.");
  const query = parsed.data;
  const scope = allowlist(user);
  const filters: string[] = [];
  const binds: unknown[] = [user.id];
  if (query.unread) filters.push("n.read_at IS NULL");
  if (query.repositoryId) {
    filters.push("n.repository_id = ?");
    binds.push(query.repositoryId);
  }
  if (query.reason) {
    filters.push("n.reason = ?");
    binds.push(query.reason);
  }
  if (query.before) {
    const [createdAt, id] = query.before.split(":");
    filters.push("(n.created_at < ? OR (n.created_at = ? AND n.id < ?))");
    binds.push(Number(createdAt), Number(createdAt), id);
  }
  const rows = await env.DB.prepare(
    `SELECT n.id, n.reason, n.subject_kind AS subjectKind, n.subject_number AS subjectNumber, CASE n.subject_kind WHEN 'issue' THEN i.title WHEN 'pull_request' THEN p.title WHEN 'discussion' THEN d.title END AS title, n.created_at AS createdAt, n.read_at AS readAt, r.id AS repositoryId, r.slug AS repositoryName, ns.slug AS owner, actor.identifier AS actor FROM forge_notifications n JOIN users u ON u.id = n.recipient_id JOIN repositories r ON r.id = n.repository_id AND r.deleted_at IS NULL JOIN namespaces ns ON ns.id = r.namespace_id LEFT JOIN users actor ON actor.id = n.actor_id LEFT JOIN forge_issues i ON n.subject_kind = 'issue' AND i.id = n.subject_id LEFT JOIN forge_pull_requests p ON n.subject_kind = 'pull_request' AND p.id = n.subject_id LEFT JOIN forge_discussions d ON n.subject_kind = 'discussion' AND d.id = n.subject_id WHERE n.recipient_id = ? AND ${USER_CAN_SEE}${filters.map((filter) => ` AND ${filter}`).join("")}${scope.sql} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`
  )
    .bind(...binds, ...scope.binds, query.limit + 1)
    .all<NotificationRow>();
  const page = rows.results.slice(0, query.limit);
  const last = page.at(-1);
  const body: NotificationPage = {
    items: page.map((row): Notification => ({
      id: row.id,
      reason: row.reason,
      subjectKind: row.subjectKind,
      subjectNumber: row.subjectNumber,
      title: row.title,
      repository: { id: row.repositoryId, owner: row.owner, name: row.repositoryName },
      actor: row.actor,
      createdAt: row.createdAt,
      readAt: row.readAt,
    })),
    nextCursor: rows.results.length > query.limit && last ? `${last.createdAt}:${last.id}` : null,
  };
  return dataResponse(body);
}

async function unreadCount(env: ForgeEnv, user: TrustedUser): Promise<Response> {
  const scope = allowlist(user);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total FROM (SELECT 1 FROM forge_notifications n JOIN users u ON u.id = n.recipient_id JOIN repositories r ON r.id = n.repository_id AND r.deleted_at IS NULL WHERE n.recipient_id = ? AND n.read_at IS NULL AND ${USER_CAN_SEE}${scope.sql} LIMIT ?)`
  )
    .bind(user.id, ...scope.binds, NOTIFICATION_UNREAD_COUNT_CAP + 1)
    .first<{ total: number }>();
  const total = row?.total ?? 0;
  const body: NotificationUnreadCount = {
    unread: Math.min(total, NOTIFICATION_UNREAD_COUNT_CAP),
    capped: total > NOTIFICATION_UNREAD_COUNT_CAP,
  };
  return dataResponse(body);
}

async function markRead(env: ForgeEnv, request: Request, user: TrustedUser): Promise<Response> {
  const parsed = MarkNotificationsReadInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid mark-read payload.");
  const scope = allowlist(user);
  const input = parsed.data;
  const filter =
    "ids" in input
      ? { sql: " AND n.id IN (SELECT value FROM json_each(?))", binds: [JSON.stringify(input.ids)] }
      : input.repositoryId
        ? { sql: " AND n.repository_id = ?", binds: [input.repositoryId] }
        : { sql: "", binds: [] };
  const result = await env.DB.prepare(
    `UPDATE forge_notifications AS n SET read_at = ? WHERE n.recipient_id = ? AND n.read_at IS NULL${filter.sql}${scope.sql}`
  )
    .bind(Date.now(), user.id, ...filter.binds, ...scope.binds)
    .run();
  return dataResponse({ updated: result.meta.changes });
}

async function loadPreferences(env: ForgeEnv, userId: string): Promise<NotificationPreferences> {
  const row = await env.DB.prepare(
    "SELECT muted_reasons_json AS mutedJson FROM forge_notification_preferences WHERE user_id = ?"
  )
    .bind(userId)
    .first<{ mutedJson: string }>();
  const parsed = NotificationPreferencesSchema.safeParse({
    mutedReasons: row ? JSON.parse(row.mutedJson) : [],
  });
  return parsed.success ? parsed.data : { mutedReasons: [] };
}

export async function handleNotifications(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  parts: readonly string[]
): Promise<Response | null> {
  if (parts[0] === "notification-preferences" && parts.length === 1) {
    if (request.method === "GET") return dataResponse(await loadPreferences(env, user.id));
    if (request.method === "PUT") {
      const parsed = NotificationPreferencesSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid preferences.");
      await env.DB.prepare(
        "INSERT INTO forge_notification_preferences (user_id, muted_reasons_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET muted_reasons_json = excluded.muted_reasons_json, updated_at = excluded.updated_at"
      )
        .bind(user.id, JSON.stringify(parsed.data.mutedReasons), Date.now())
        .run();
      return dataResponse(parsed.data);
    }
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  }
  if (parts[0] !== "notifications") return null;
  const search = new URL(request.url).searchParams;
  if (parts.length === 1 && request.method === "GET") return listNotifications(env, user, search);
  if (parts.length === 2 && parts[1] === "unread-count" && request.method === "GET")
    return unreadCount(env, user);
  if (parts.length === 2 && parts[1] === "read" && request.method === "POST")
    return markRead(env, request, user);
  return errorResponse(404, "not_found", "Endpoint was not found.");
}

/** Deletes read notifications past retention in bounded batches. */
export async function purgeReadNotifications(env: ForgeEnv, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM forge_notifications WHERE id IN (SELECT id FROM forge_notifications WHERE read_at IS NOT NULL AND read_at < ? LIMIT ?)"
  )
    .bind(now - NOTIFICATION_RETENTION_MS, PURGE_BATCH)
    .run();
  return result.meta.changes;
}
