import { z } from "zod";
import { GitOidSchema, type Actor } from "./forge";

export const REVIEW_COMMENT_BODY_MAX = 20_000;
export const REVIEW_COMMENT_HUNK_MAX = 4_000;
export const MAX_PENDING_REVIEW_COMMENTS = 200;

const commentBody = z.string().trim().min(1).max(REVIEW_COMMENT_BODY_MAX);
const pending = z.boolean().default(false);

export const ReviewCommentSideSchema = z.enum(["LEFT", "RIGHT"]);
export type ReviewCommentSide = z.infer<typeof ReviewCommentSideSchema>;

export const CreateReviewThreadInputSchema = z
  .object({
    body: commentBody,
    commitOid: GitOidSchema,
    path: z.string().min(1).max(1000),
    side: ReviewCommentSideSchema,
    line: z.number().int().min(1).max(10_000_000),
    startLine: z.number().int().min(1).max(10_000_000).optional(),
    diffHunk: z.string().max(REVIEW_COMMENT_HUNK_MAX).default(""),
    pending,
  })
  .refine((value) => value.startLine === undefined || value.startLine <= value.line, {
    path: ["startLine"],
  });
export type CreateReviewThreadInput = z.infer<typeof CreateReviewThreadInputSchema>;

export const CreateReviewReplyInputSchema = z.object({
  body: commentBody,
  inReplyTo: z.string().min(1).max(100),
  pending,
});
export type CreateReviewReplyInput = z.infer<typeof CreateReviewReplyInputSchema>;

export const CreateReviewCommentInputSchema = z.union([
  CreateReviewReplyInputSchema,
  CreateReviewThreadInputSchema,
]);
export type CreateReviewCommentInput = z.infer<typeof CreateReviewCommentInputSchema>;

export const UpdateReviewCommentInputSchema = z.object({ body: commentBody });

/** Identity that owns a review comment; an agent keeps its comments across sessions. */
export function reviewActorKey(actor: Pick<Actor, "kind" | "id">): string {
  return `${actor.kind}:${actor.id}`;
}

export interface ReviewComment {
  id: string;
  /** Root comment of the thread; null on the root itself. */
  inReplyTo: string | null;
  reviewId: string | null;
  commitOid: string;
  path: string;
  side: ReviewCommentSide;
  line: number;
  startLine: number | null;
  diffHunk: string;
  body: string;
  actor: Actor;
  /** Visible only to its author until the review is submitted. */
  pending: boolean;
  /** The commit differs from the current pull request head. */
  outdated: boolean;
  resolvedAt: number | null;
  resolvedBy: Actor | null;
  createdAt: number;
  updatedAt: number;
}
