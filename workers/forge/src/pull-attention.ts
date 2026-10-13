import { z } from "zod";
import { MERGE_REVIEW_LIMIT } from "../../../packages/contracts/src/merge-requirements";
import {
  AssigneeSchema,
  type Actor,
  type Assignee,
  type PullAttention,
} from "../../../packages/contracts/src/forge";
import { parseActor } from "./common";

const ActivitySchema = z.object({ actor: z.string(), authorId: z.string(), at: z.number() });
const ReviewActivitySchema = ActivitySchema.extend({
  state: z.enum(["commented", "approved", "changes_requested"]),
});
const ContextSchema = z.object({
  truncated: z.boolean(),
  head: z.object({ oid: z.string(), at: z.number() }).nullable(),
  reviewers: z.array(
    AssigneeSchema.extend({ requestedAt: z.number(), review: ReviewActivitySchema.nullable() })
  ),
  review: ReviewActivitySchema.nullable(),
  changesRequestedAt: z.number().nullable(),
  comment: ActivitySchema.nullable(),
});

export function pullAttentionColumn(alias: string): string {
  const scope = `p.repository_id=COALESCE(${alias}.head_repository_id,${alias}.repository_id) AND p.session_id=COALESCE(${alias}.head_session_id,'') AND p.ref='refs/heads/'||${alias}.head_ref`;
  const lastUpdate = `(SELECT json_object('oid',h.new_oid,'at',h.created_at) FROM forge_pull_head_updates h WHERE h.pull_request_id=${alias}.id ORDER BY h.created_at DESC,h.id DESC LIMIT 1)`;
  const head = `COALESCE((SELECT json_object('oid',p.oid,'at',p.updated_at) FROM forge_ref_pushers p WHERE ${scope}),${lastUpdate})`;
  const headOid = pullCurrentHeadOidExpression(alias);
  const currentReview = `r.pull_request_id=${alias}.id AND r.commit_oid=${headOid}`;
  const reviewObject = `json_object('actor',r.actor_json,'authorId',r.author_id,'at',r.created_at,'state',r.state)`;
  const review = `(SELECT ${reviewObject} FROM forge_reviews r WHERE ${currentReview} ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)`;
  const changesRequested = `(SELECT MAX(r.created_at) FROM forge_reviews r WHERE ${currentReview} AND r.state='changes_requested' AND r.id=(SELECT newer.id FROM forge_reviews newer WHERE newer.pull_request_id=r.pull_request_id AND newer.commit_oid=r.commit_oid AND newer.actor_key=r.actor_key ORDER BY newer.created_at DESC,newer.rowid DESC LIMIT 1))`;
  const assignedReview = `(SELECT ${reviewObject} FROM forge_reviews r WHERE ${currentReview} AND r.created_at>=a.created_at AND (CASE WHEN json_extract(r.actor_json,'$.kind')='agent' THEN 'agent' ELSE 'user' END)=a.assignee_kind AND COALESCE(json_extract(r.actor_json,'$.id'),r.author_id)=a.assignee_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1)`;
  const reviewers = `(SELECT json_group_array(json_object('kind',a.assignee_kind,'id',a.assignee_id,'name',COALESCE(u.identifier,g.name,a.assignee_id),'requestedAt',a.created_at,'review',json(${assignedReview}))) FROM forge_assignments a LEFT JOIN users u ON a.assignee_kind='user' AND u.id=a.assignee_id LEFT JOIN auth_agents g ON a.assignee_kind='agent' AND g.id=a.assignee_id WHERE a.target_kind='pull_request' AND a.target_id=${alias}.id AND a.role='reviewer')`;
  const comment = `(SELECT json_object('actor',c.actor_json,'authorId',c.author_id,'at',c.at) FROM (SELECT id,actor_json,author_id,created_at AS at FROM forge_comments WHERE target_kind='pull_request' AND target_id=${alias}.id UNION ALL SELECT id,actor_json,author_id,created_at AS at FROM forge_review_comments WHERE pull_request_id=${alias}.id AND pending=0) c ORDER BY c.at DESC,c.id DESC LIMIT 1)`;
  const limited = `(SELECT COUNT(*) FROM (SELECT 1 FROM forge_reviews limited WHERE limited.pull_request_id=${alias}.id AND limited.commit_oid=${headOid} LIMIT ${MERGE_REVIEW_LIMIT + 1}))>${MERGE_REVIEW_LIMIT}`;
  return `CASE WHEN ${limited} THEN json_object('truncated',json('true'),'head',NULL,'reviewers',json('[]'),'review',NULL,'changesRequestedAt',NULL,'comment',NULL) ELSE json_object('truncated',json('false'),'head',json(${head}),'reviewers',json(${reviewers}),'review',json(${review}),'changesRequestedAt',${changesRequested},'comment',json(${comment})) END AS attention_json`;
}

export function pullCurrentHeadOidExpression(alias: string): string {
  const refScope = `ref.repository_id=COALESCE(${alias}.head_repository_id,${alias}.repository_id) AND ref.session_id=COALESCE(${alias}.head_session_id,'') AND ref.ref='refs/heads/'||${alias}.head_ref`;
  return `COALESCE((SELECT ref.oid FROM forge_ref_pushers ref WHERE ${refScope}),(SELECT update_event.new_oid FROM forge_pull_head_updates update_event WHERE update_event.pull_request_id=${alias}.id ORDER BY update_event.created_at DESC,update_event.id DESC LIMIT 1))`;
}

function subject(actor: Actor): Assignee | null {
  return actor.kind === "user" || actor.kind === "agent"
    ? { kind: actor.kind, id: actor.id, name: actor.name } : null;
}

export function pullAttention(pull: Record<string, unknown>): PullAttention[] {
  if (pull.state !== "open" || pull.draft === 1 || pull.draft === true) return [];
  const author = subject(parseActor(pull.actor_json, pull.author_id));
  if (!author) return [];
  if (typeof pull.attention_json !== "string") return [];
  const context = ContextSchema.parse(JSON.parse(pull.attention_json));
  if (context.truncated) return [{ ...author, reason: "history_unavailable" }];
  if (context.head === null) return [{ ...author, reason: "head_unverified" }];
  const reviewers = context.reviewers.filter(
    (reviewer) => reviewer.kind !== author.kind || reviewer.id !== author.id
  );
  const headAt = context.head?.at ?? 0;
  if (context.head?.oid === "0".repeat(40)) return [{ ...author, reason: "head_missing" }];
  const authorEntry = (reason: PullAttention["reason"]): PullAttention[] => [{ ...author, reason }];
  const reviewerEntries = (reason: PullAttention["reason"]): PullAttention[] =>
    reviewers.map(({ kind, id, name }) => ({ kind, id, name, reason }));
  const reviewAt = context.review?.at ?? 0;
  if (context.comment && context.comment.at > headAt && context.comment.at >= reviewAt) {
    const actor = parseActor(context.comment.actor, context.comment.authorId);
    return actor.kind === author.kind && actor.id === author.id
      ? reviewers.length
        ? reviewerEntries("reply")
        : authorEntry("reviewers_needed")
      : authorEntry("reply");
  }
  if (context.changesRequestedAt !== null) return authorEntry("changes_requested");
  const pending = reviewers.filter(
    (reviewer) => !reviewer.review || reviewer.review.at < reviewer.requestedAt
  );
  const entries: PullAttention[] = pending.map(({ kind, id, name, requestedAt }) => ({
    kind,
    id,
    name,
    reason: headAt >= requestedAt ? "head_updated" : "review_requested",
  }));
  if (context.review) {
    if (context.review.state === "changes_requested") return authorEntry("changes_requested");
    if (context.review.state === "commented") return authorEntry("reply");
    if (context.review.state === "approved" && !pending.length) return authorEntry("reviewed");
  }
  return reviewers.length ? entries : authorEntry("reviewers_needed");
}

export function filterPullAttention(
  rows: Record<string, unknown>[],
  viewer: Assignee | null
): Record<string, unknown>[] {
  return rows.filter(
    (row) =>
      viewer &&
      pullAttention(row).some((entry) => entry.kind === viewer.kind && entry.id === viewer.id)
  );
}
