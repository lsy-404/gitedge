import type {
  DashboardAttentionItem,
  DashboardAttentionPage,
} from "../../../packages/contracts/src";
import type { TrustedUser } from "../../../packages/contracts/src";
import { createLogger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import type { ForgeEnv } from "./common";
import { pullCurrentHeadOidExpression } from "./pull-attention";

const PAGE_SIZE = 50;
const SOON_MS = 24 * 60 * 60 * 1000;

type Cursor = { at: number; id: string };
type DashboardCountsRow = {
  review_requested: number;
  changes_requested: number;
  failed_check: number;
  blocked_task: number;
  expiring_session: number;
};

function parseCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      "at" in parsed &&
      typeof parsed.at === "number" &&
      "id" in parsed &&
      typeof parsed.id === "string"
    )
      return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
  return null;
}

/** Cross-repository attention is always scoped to repositories the signed-in human can access. */
export async function dashboardAttention(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser
): Promise<Response> {
  const url = new URL(request.url);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  if (url.searchParams.has("cursor") && !cursor)
    return errorResponse(400, "bad_request", "Invalid cursor.");

  const accessible = `(r.system_kind = 'account_runner' AND r.created_by = ?) OR (r.system_kind IS NULL AND (EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = r.namespace_id AND m.user_id = ?) OR EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = r.id AND c.user_id = ? AND c.role IN ('read', 'write', 'admin'))))`;
  const now = Date.now();
  const zeroOid = "0".repeat(40);
  const cursorSql = cursor ? "WHERE updatedAt > ? OR (updatedAt = ? AND id > ?)" : "";
  const cursorBinds = cursor ? [cursor.at, cursor.at, cursor.id] : [];
  const [itemsResult, countsRow] = await Promise.all([
    env.DB.prepare(
      `WITH accessible_repositories AS (
        SELECT r.id, r.slug AS repository, n.slug AS owner
        FROM repositories r JOIN namespaces n ON n.id = r.namespace_id
        WHERE r.deleted_at IS NULL AND (${accessible})
      ), pulls AS (
        SELECT p.id, p.number, p.title, p.author_id, p.actor_json, p.updated_at, ar.repository, ar.owner,
          ${pullCurrentHeadOidExpression("p")} AS head_oid
        FROM forge_pull_requests p JOIN accessible_repositories ar ON ar.id = p.repository_id
        WHERE p.state = 'open' AND p.draft = 0
      ), attention_items AS (
        SELECT 'review_requested:' || p.id AS id, 'review_requested' AS kind,
          '#' || p.number || ' ' || p.title AS title, 'A review is waiting for you' AS detail,
          p.owner, p.repository, p.number, p.updated_at AS updatedAt,
          '/' || p.owner || '/' || p.repository || '/pulls/' || p.number AS url
        FROM pulls p
        WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND (p.author_id <> ? OR json_extract(p.actor_json, '$.kind') <> 'user') AND EXISTS (
          SELECT 1 FROM forge_assignments a WHERE a.target_kind = 'pull_request' AND a.target_id = p.id AND a.role = 'reviewer' AND a.assignee_kind = 'user' AND a.assignee_id = ? AND NOT EXISTS (
            SELECT 1 FROM forge_reviews review WHERE review.pull_request_id = p.id AND review.commit_oid = p.head_oid AND review.created_at >= a.created_at AND (CASE WHEN json_extract(review.actor_json, '$.kind') = 'agent' THEN 'agent' ELSE 'user' END) = a.assignee_kind AND COALESCE(json_extract(review.actor_json, '$.id'), review.author_id) = a.assignee_id
          )
        )
        UNION ALL
        SELECT 'changes_requested:' || p.id, 'changes_requested', '#' || p.number || ' ' || p.title,
          'Changes were requested on the current pull request revision', p.owner, p.repository, p.number, p.updated_at,
          '/' || p.owner || '/' || p.repository || '/pulls/' || p.number
        FROM pulls p
        WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND p.author_id = ? AND json_extract(p.actor_json, '$.kind') = 'user' AND EXISTS (
          SELECT 1 FROM forge_reviews review WHERE review.pull_request_id = p.id AND review.commit_oid = p.head_oid AND review.state = 'changes_requested' AND review.id = (
            SELECT newer.id FROM forge_reviews newer WHERE newer.pull_request_id = review.pull_request_id AND newer.commit_oid = review.commit_oid AND newer.actor_key = review.actor_key ORDER BY newer.created_at DESC, newer.rowid DESC LIMIT 1
          )
        )
        UNION ALL
        SELECT 'failed_check:' || p.id, 'failed_check', '#' || p.number || ' ' || p.title,
          'A check failed on the current pull request revision', p.owner, p.repository, p.number, p.updated_at,
          '/' || p.owner || '/' || p.repository || '/pulls/' || p.number
        FROM pulls p
        WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND EXISTS (
          SELECT 1 FROM forge_check_runs c WHERE c.pull_request_id = p.id AND c.commit_oid = p.head_oid AND c.status = 'completed' AND c.conclusion = 'failure'
        )
        UNION ALL
        SELECT 'blocked_task:' || t.id, 'blocked_task', '#' || t.number || ' ' || t.title,
          COALESCE(t.blocked_reason, ''), ar.owner, ar.repository, t.number, t.updated_at,
          '/' || ar.owner || '/' || ar.repository || '/tasks/' || t.number
        FROM forge_tasks t JOIN accessible_repositories ar ON ar.id = t.repository_id
        WHERE t.status = 'blocked'
        UNION ALL
        SELECT 'expiring_session:' || s.id, 'expiring_session', a.name, CAST(s.expires_at AS TEXT),
          ar.owner, ar.repository, NULL, s.expires_at,
          '/' || ar.owner || '/' || ar.repository || '/agents'
        FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id
          JOIN accessible_repositories ar ON ar.id = s.repository_id
        WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at > ? AND s.expires_at <= ?
      )
      SELECT id, kind, title, detail, owner, repository, number, updatedAt, url
      FROM attention_items ${cursorSql}
      ORDER BY updatedAt ASC, id ASC LIMIT ?`
    )
      .bind(
        user.id,
        user.id,
        user.id,
        zeroOid,
        user.id,
        user.id,
        zeroOid,
        user.id,
        zeroOid,
        user.id,
        now,
        now + SOON_MS,
        ...cursorBinds,
        PAGE_SIZE + 1
      )
      .all<DashboardAttentionItem>(),
    env.DB.prepare(
      `WITH accessible_repositories AS (
        SELECT r.id FROM repositories r WHERE r.deleted_at IS NULL AND (${accessible})
      ), pulls AS (
        SELECT pull.id, pull.author_id, pull.actor_json, ${pullCurrentHeadOidExpression("pull")} AS head_oid
        FROM forge_pull_requests pull JOIN accessible_repositories ar ON ar.id = pull.repository_id
        WHERE pull.state = 'open' AND pull.draft = 0
      )
      SELECT
        (SELECT COUNT(*) FROM pulls p WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND (p.author_id <> ? OR json_extract(p.actor_json, '$.kind') <> 'user') AND EXISTS (
          SELECT 1 FROM forge_assignments a WHERE a.target_kind = 'pull_request' AND a.target_id = p.id AND a.role = 'reviewer' AND a.assignee_kind = 'user' AND a.assignee_id = ? AND NOT EXISTS (
            SELECT 1 FROM forge_reviews r WHERE r.pull_request_id = p.id AND r.commit_oid = p.head_oid AND r.created_at >= a.created_at AND (CASE WHEN json_extract(r.actor_json, '$.kind') = 'agent' THEN 'agent' ELSE 'user' END) = a.assignee_kind AND COALESCE(json_extract(r.actor_json, '$.id'), r.author_id) = a.assignee_id
          )
        )) AS review_requested,
        (SELECT COUNT(*) FROM pulls p WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND p.author_id = ? AND json_extract(p.actor_json, '$.kind') = 'user' AND EXISTS (
          SELECT 1 FROM forge_reviews r WHERE r.pull_request_id = p.id AND r.commit_oid = p.head_oid AND r.state = 'changes_requested' AND r.id = (
            SELECT newer.id FROM forge_reviews newer WHERE newer.pull_request_id = r.pull_request_id AND newer.commit_oid = r.commit_oid AND newer.actor_key = r.actor_key ORDER BY newer.created_at DESC, newer.rowid DESC LIMIT 1
          )
        )) AS changes_requested,
        (SELECT COUNT(*) FROM pulls p WHERE p.head_oid IS NOT NULL AND p.head_oid <> ? AND EXISTS (
          SELECT 1 FROM forge_check_runs c WHERE c.pull_request_id = p.id AND c.commit_oid = p.head_oid AND c.status = 'completed' AND c.conclusion = 'failure'
        )) AS failed_check,
        (SELECT COUNT(*) FROM forge_tasks t JOIN accessible_repositories ar ON ar.id = t.repository_id WHERE t.status = 'blocked') AS blocked_task,
        (SELECT COUNT(*) FROM auth_agent_sessions s JOIN accessible_repositories ar ON ar.id = s.repository_id WHERE s.user_id = ? AND s.status = 'active' AND s.expires_at > ? AND s.expires_at <= ?) AS expiring_session`
    )
      .bind(
        user.id,
        user.id,
        user.id,
        zeroOid,
        user.id,
        user.id,
        zeroOid,
        user.id,
        zeroOid,
        user.id,
        now,
        now + SOON_MS
      )
      .first<DashboardCountsRow>(),
  ]);

  if (!countsRow) {
    createLogger(env.LOG_LEVEL, { service: "forge" }).error(
      "forge:dashboard-attention-counts-unavailable",
      { userId: user.id }
    );
    return errorResponse(503, "internal_error", "Dashboard attention counts are unavailable.");
  }

  const hasMore = itemsResult.results.length > PAGE_SIZE;
  const items = itemsResult.results.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  const page: DashboardAttentionPage = {
    items,
    counts: countsRow,
    nextCursor: hasMore && last ? JSON.stringify({ at: last.updatedAt, id: last.id }) : null,
    truncated: hasMore,
  };
  return dataResponse(page);
}
