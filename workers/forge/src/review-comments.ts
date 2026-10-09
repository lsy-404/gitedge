import {
  CreateReviewCommentInputSchema,
  MAX_PENDING_REVIEW_COMMENTS,
  UpdateReviewCommentInputSchema,
  type Actor,
  type ReviewComment,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { mentionAgents } from "./agent-events";
import { parseActor, parseJson, type ForgeEnv, type RepositoryRow } from "./common";

const MAX_COMMENT_ROWS = 1000;

type ReviewCommentRow = {
  id: string;
  pull_request_id: string;
  review_id: string | null;
  in_reply_to: string | null;
  actor_json: string;
  actor_key: string;
  author_id: string;
  commit_oid: string;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  start_line: number | null;
  diff_hunk: string;
  body: string;
  pending: number;
  resolved_at: number | null;
  resolved_by_json: string | null;
  created_at: number;
  updated_at: number;
};

export interface ReviewCommentScope {
  env: ForgeEnv;
  repository: RepositoryRow;
  pull: Record<string, unknown>;
  /** Null for anonymous readers, who only see published comments. */
  user: TrustedUser | null;
  actor: Actor | null;
  /** Repository write role combined with a writable session. */
  member: boolean;
  writeAllowed: boolean;
  mergeLeased: boolean;
  resolveHead: () => Promise<string | null>;
}

/** Stable per-identity key; an agent keeps its pending comments across sessions. */
export function reviewCommentActorKey(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

function presentReviewComment(row: ReviewCommentRow, headOid: string | null): ReviewComment {
  const resolvedBy = row.resolved_by_json ? parseActor(row.resolved_by_json, null) : null;
  return {
    id: row.id,
    inReplyTo: row.in_reply_to,
    reviewId: row.review_id,
    commitOid: row.commit_oid,
    path: row.path,
    side: row.side,
    line: row.line,
    startLine: row.start_line,
    diffHunk: row.diff_hunk,
    body: row.body,
    actor: parseActor(row.actor_json, row.author_id),
    pending: row.pending === 1,
    outdated: headOid !== null && row.commit_oid !== headOid,
    resolvedAt: row.resolved_at,
    resolvedBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchRow(
  env: ForgeEnv,
  pullRequestId: string,
  id: string
): Promise<ReviewCommentRow | null> {
  return env.DB.prepare("SELECT * FROM forge_review_comments WHERE id = ? AND pull_request_id = ?")
    .bind(id, pullRequestId)
    .first<ReviewCommentRow>();
}

/** A pending comment is visible only to the identity that wrote it. */
function visibleTo(row: ReviewCommentRow, actor: Actor | null): boolean {
  return row.pending === 0 || (actor !== null && row.actor_key === reviewCommentActorKey(actor));
}

export async function listReviewComments(scope: ReviewCommentScope): Promise<Response> {
  const { env, pull, actor } = scope;
  const rows = await env.DB.prepare(
    "SELECT * FROM forge_review_comments WHERE pull_request_id = ? AND (pending = 0 OR actor_key = ?) ORDER BY created_at ASC, rowid ASC LIMIT ?"
  )
    .bind(String(pull.id), actor ? reviewCommentActorKey(actor) : "", MAX_COMMENT_ROWS + 1)
    .all<ReviewCommentRow>();
  const headOid = await scope.resolveHead();
  return jsonResponse({
    data: rows.results.slice(0, MAX_COMMENT_ROWS).map((row) => presentReviewComment(row, headOid)),
    truncated: rows.results.length > MAX_COMMENT_ROWS,
  });
}

/**
 * Handles `review-comments` under a pull request. `rest` holds the path segments after the
 * pull request number: ["review-comments", id?, "resolve" | "unresolve"?].
 */
export async function reviewCommentRequest(
  scope: ReviewCommentScope,
  method: string,
  request: Request,
  rest: string[]
): Promise<Response> {
  const { env, repository, pull, user, actor } = scope;
  const [, id, operation] = rest;
  let cachedHead: Promise<string | null> | undefined;
  const resolveHead = (): Promise<string | null> => (cachedHead ??= scope.resolveHead());
  if (method === "GET" && !id) return listReviewComments(scope);
  if (!user || !actor)
    return errorResponse(401, "unauthorized", "Sign in to change review comments.");
  if (!scope.writeAllowed)
    return errorResponse(403, "forbidden", "Read-only agent session cannot write.");
  if (actor.kind === "agent" && !user.agentSession)
    return errorResponse(403, "forbidden", "Trusted agent session is required.");
  if (scope.mergeLeased)
    return errorResponse(
      409,
      "conflict",
      "Review comments cannot change while a merge is running."
    );
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });
  const pullRequestId = String(pull.id);
  const key = reviewCommentActorKey(actor);

  if (method === "POST" && !id) {
    if (pull.state !== "open")
      return errorResponse(409, "conflict", "Comments need an open pull request.");
    const parsed = CreateReviewCommentInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid review comment.");
    const input = parsed.data;
    const now = Date.now();
    const newId = crypto.randomUUID();
    let target: Pick<
      ReviewCommentRow,
      "commit_oid" | "path" | "side" | "line" | "start_line" | "diff_hunk" | "pending"
    >;
    let inReplyTo: string | null = null;
    if ("inReplyTo" in input) {
      const parent = await fetchRow(env, pullRequestId, input.inReplyTo);
      if (!parent || !visibleTo(parent, actor))
        return errorResponse(404, "not_found", "Review comment was not found.");
      inReplyTo = parent.in_reply_to ?? parent.id;
      const root = parent.in_reply_to ? await fetchRow(env, pullRequestId, inReplyTo) : parent;
      if (!root) return errorResponse(404, "not_found", "Review comment was not found.");
      target = {
        commit_oid: root.commit_oid,
        path: root.path,
        side: root.side,
        line: root.line,
        start_line: root.start_line,
        diff_hunk: "",
        pending: root.pending === 1 || input.pending ? 1 : 0,
      };
    } else {
      const head = await resolveHead();
      if (head === null)
        return errorResponse(
          502,
          "git_unavailable",
          "The pull request head could not be resolved."
        );
      if (input.commitOid !== head)
        return errorResponse(409, "stale_commit", "The commit is no longer the pull request head.");
      target = {
        commit_oid: input.commitOid,
        path: input.path,
        side: input.side,
        line: input.line,
        start_line: input.startLine ?? null,
        diff_hunk: input.diffHunk,
        pending: input.pending ? 1 : 0,
      };
    }
    if (target.pending === 1) {
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM forge_review_comments WHERE pull_request_id = ? AND actor_key = ? AND pending = 1"
      )
        .bind(pullRequestId, key)
        .first<{ total: number }>();
      if ((count?.total ?? 0) >= MAX_PENDING_REVIEW_COMMENTS)
        return errorResponse(409, "pending_limit", "Too many pending review comments.");
    }
    await env.DB.prepare(
      "INSERT INTO forge_review_comments (id, repository_id, pull_request_id, in_reply_to, actor_json, actor_key, author_id, commit_oid, path, side, line, start_line, diff_hunk, body, pending, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        newId,
        repository.id,
        pullRequestId,
        inReplyTo,
        JSON.stringify(actor),
        key,
        user.id,
        target.commit_oid,
        target.path,
        target.side,
        target.line,
        target.start_line,
        target.diff_hunk,
        input.body,
        target.pending,
        now,
        now
      )
      .run();
    if (target.pending === 0)
      await mentionAgents(env, repository, user, input.body, {
        targetKind: "pull_request",
        targetId: pullRequestId,
        reviewCommentId: newId,
      });
    logger.info("forge:review-comment-created", {
      pullRequestId,
      reply: inReplyTo !== null,
      pending: target.pending === 1,
      actorKind: actor.kind,
    });
    const created = await fetchRow(env, pullRequestId, newId);
    return created
      ? dataResponse(presentReviewComment(created, await resolveHead()), 201)
      : errorResponse(500, "internal_error", "Review comment was not stored.");
  }

  if (!id) return errorResponse(404, "not_found", "Endpoint was not found.");
  const row = await fetchRow(env, pullRequestId, id);
  if (!row || !visibleTo(row, actor))
    return errorResponse(404, "not_found", "Review comment was not found.");
  const own = row.actor_key === key;

  if (method === "PATCH" && !operation) {
    if (!own)
      return errorResponse(403, "forbidden", "Only the comment author may edit this comment.");
    const parsed = UpdateReviewCommentInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid review comment.");
    await env.DB.prepare("UPDATE forge_review_comments SET body = ?, updated_at = ? WHERE id = ?")
      .bind(parsed.data.body, Date.now(), id)
      .run();
    const updated = await fetchRow(env, pullRequestId, id);
    return updated
      ? dataResponse(presentReviewComment(updated, await resolveHead()))
      : errorResponse(404, "not_found", "Review comment was not found.");
  }

  if (method === "DELETE" && !operation) {
    if (!own && !(scope.member && actor.kind === "user"))
      return errorResponse(
        403,
        "forbidden",
        "Only the comment author or a repository member may delete it."
      );
    await env.DB.prepare("DELETE FROM forge_review_comments WHERE id = ?").bind(id).run();
    logger.info("forge:review-comment-deleted", { pullRequestId, actorKind: actor.kind });
    return new Response(null, { status: 204 });
  }

  if (method === "POST" && (operation === "resolve" || operation === "unresolve")) {
    const root = row.in_reply_to ? await fetchRow(env, pullRequestId, row.in_reply_to) : row;
    if (!root || root.pending === 1)
      return errorResponse(409, "conflict", "Only published threads can be resolved.");
    const mayResolve =
      root.actor_key === key ||
      (actor.kind === "user" && (scope.member || pull.author_id === user.id));
    if (!mayResolve)
      return errorResponse(
        403,
        "forbidden",
        "Only the thread author, the pull request author or a repository member may resolve it."
      );
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE forge_review_comments SET resolved_at = ?, resolved_by_json = ? WHERE id = ?"
    )
      .bind(
        operation === "resolve" ? now : null,
        operation === "resolve" ? JSON.stringify(actor) : null,
        root.id
      )
      .run();
    logger.info("forge:review-thread-resolution", {
      pullRequestId,
      resolved: operation === "resolve",
      actorKind: actor.kind,
    });
    const updated = await fetchRow(env, pullRequestId, root.id);
    return updated
      ? dataResponse(presentReviewComment(updated, await resolveHead()))
      : errorResponse(404, "not_found", "Review comment was not found.");
  }

  return errorResponse(404, "not_found", "Endpoint was not found.");
}

/** Statements that attach the caller's pending comments to a newly submitted review. */
export function publishPendingStatements(
  env: ForgeEnv,
  pullRequestId: string,
  reviewId: string,
  actor: Actor
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "UPDATE forge_review_comments SET pending = 0, review_id = ? WHERE pull_request_id = ? AND actor_key = ? AND pending = 1"
    ).bind(reviewId, pullRequestId, reviewCommentActorKey(actor)),
  ];
}

export async function unresolvedThreadCount(env: ForgeEnv, pullRequestId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM forge_review_comments WHERE pull_request_id = ? AND in_reply_to IS NULL AND pending = 0 AND resolved_at IS NULL"
  )
    .bind(pullRequestId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}
