import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorMessage, type Actor, type ReviewComment, type ReviewThreadDraft } from "./api";

export interface ReviewThreadGroup {
  root: ReviewComment;
  replies: ReviewComment[];
}

/** Identity key shared with the Forge worker: kind and id, never the agent session. */
export function actorIdentity(actor: Actor): string {
  return `${actor.kind}:${actor.id}`;
}

export function groupThreads(comments: readonly ReviewComment[]): ReviewThreadGroup[] {
  const groups = new Map<string, ReviewThreadGroup>();
  for (const comment of comments)
    if (comment.inReplyTo === null) groups.set(comment.id, { root: comment, replies: [] });
  for (const comment of comments)
    if (comment.inReplyTo !== null) groups.get(comment.inReplyTo)?.replies.push(comment);
  return [...groups.values()];
}

export type ReviewTextSegment =
  { kind: "markdown"; text: string } | { kind: "suggestion"; lines: string[] };

/** Splits a comment into prose and ```suggestion blocks so suggestions render as a diff. */
export function splitSuggestions(body: string): ReviewTextSegment[] {
  const segments: ReviewTextSegment[] = [];
  const pattern = /^```suggestion[^\n]*\n([\s\S]*?)\n?^```[ \t]*$/gm;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    const before = body.slice(cursor, match.index);
    if (before.trim()) segments.push({ kind: "markdown", text: before });
    segments.push({ kind: "suggestion", lines: match[1] === "" ? [] : match[1].split("\n") });
    cursor = match.index + match[0].length;
  }
  const rest = body.slice(cursor);
  if (rest.trim() || segments.length === 0) segments.push({ kind: "markdown", text: rest });
  return segments;
}

/** State and actions for the line comments of one pull request. */
export function useReviewThreads(
  repositoryId: () => string,
  number: () => number,
  headOid: () => string
) {
  const { t } = useI18n();
  const comments = ref<ReviewComment[]>([]);
  const truncated = ref(false);
  const busy = ref(false);
  const error = ref("");
  const threads = computed(() => groupThreads(comments.value));
  const pendingCount = computed(() => comments.value.filter((row) => row.pending).length);
  const unresolved = computed(() =>
    threads.value.filter((thread) => !thread.root.pending && thread.root.resolvedAt === null)
  );

  async function refresh(): Promise<void> {
    const page = await api.reviewComments(repositoryId(), number());
    comments.value = page.items;
    truncated.value = page.truncated;
  }

  async function load(): Promise<void> {
    error.value = "";
    try {
      await refresh();
    } catch (cause) {
      error.value = errorMessage(cause, t);
    }
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy.value = true;
    error.value = "";
    try {
      await action();
      await refresh();
    } catch (cause) {
      error.value = errorMessage(cause, t);
    } finally {
      busy.value = false;
    }
  }

  return {
    comments,
    threads,
    unresolved,
    pendingCount,
    truncated,
    busy,
    error,
    load,
    createThread: (draft: ReviewThreadDraft) =>
      run(() => api.createReviewThread(repositoryId(), number(), headOid(), draft)),
    reply: (root: ReviewComment, body: string, pending: boolean) =>
      run(() => api.replyReviewThread(repositoryId(), number(), root.id, body, pending)),
    edit: (comment: ReviewComment, body: string) =>
      run(() => api.updateReviewComment(repositoryId(), number(), comment.id, body)),
    remove: (comment: ReviewComment) =>
      run(() => api.deleteReviewComment(repositoryId(), number(), comment.id)),
    setResolved: (root: ReviewComment, resolved: boolean) =>
      run(() => api.setReviewThreadResolved(repositoryId(), number(), root.id, resolved)),
  };
}
