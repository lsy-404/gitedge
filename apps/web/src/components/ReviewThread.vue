<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ReviewComment } from "../lib/api";
import { splitSuggestions, suggestedLines, type ReviewThreadGroup } from "../lib/reviewThreads";
import { reviewActorKey } from "../../../../packages/contracts/src/review-comments";
import ConfirmButton from "./ConfirmButton.vue";
import MarkdownContent from "./MarkdownContent.vue";
import StatusBadge from "./StatusBadge.vue";
import TextAreaField from "./TextAreaField.vue";

const props = defineProps<{
  thread: ReviewThreadGroup;
  /** Identity key (kind:id) of the signed-in viewer, null when anonymous. */
  viewerKey: string | null;
  canComment: boolean;
  /** The viewer may resolve any thread and delete any comment. */
  canModerate: boolean;
  /** The viewer authored the pull request and may resolve its threads. */
  isPullAuthor: boolean;
  busy: boolean;
  showContext?: boolean;
  /** Resolve true once saved; the typed text stays when saving fails. */
  onReply?: (root: ReviewComment, body: string) => Promise<boolean>;
  onEdit?: (comment: ReviewComment, body: string) => Promise<boolean>;
}>();
const emit = defineEmits<{
  remove: [comment: ReviewComment];
  resolve: [root: ReviewComment, resolved: boolean];
}>();
const { t, d } = useI18n();
const root = computed(() => props.thread.root);
const comments = computed(() => [props.thread.root, ...props.thread.replies]);
const resolved = computed(() => root.value.resolvedAt !== null);
const expanded = ref(false);
const open = computed(() => !resolved.value || expanded.value);
const replyBody = ref("");
const editingId = ref("");
const editBody = ref("");

const location = computed(() =>
  root.value.startLine !== null && root.value.startLine !== root.value.line
    ? t("threadRange", {
        path: root.value.path,
        start: root.value.startLine,
        end: root.value.line,
      })
    : t("threadLocation", { path: root.value.path, line: root.value.line })
);
const canResolve = computed(
  () =>
    props.canComment &&
    !root.value.pending &&
    (props.canModerate || props.isPullAuthor || own(root.value))
);
/** Lines a suggestion replaces, taken from the stored diff context of the thread. */
const replacedLines = computed(() => suggestedLines(root.value));

function own(comment: ReviewComment): boolean {
  return props.viewerKey !== null && reviewActorKey(comment.actor) === props.viewerKey;
}
function startEdit(comment: ReviewComment) {
  editingId.value = comment.id;
  editBody.value = comment.body;
}
async function saveEdit(comment: ReviewComment) {
  if (!editBody.value.trim() || !props.onEdit) return;
  if (await props.onEdit(comment, editBody.value)) editingId.value = "";
}
async function sendReply() {
  const body = replyBody.value;
  if (!body.trim() || !props.onReply) return;
  if (await props.onReply(root.value, body)) replyBody.value = "";
}
function actorLabel(comment: ReviewComment): string {
  return comment.actor.kind === "agent"
    ? `${comment.actor.name} · ${t("agent")}`
    : comment.actor.name;
}
</script>

<template>
  <article
    :id="`review-thread-${root.id}`"
    class="review-thread"
    :class="{ 'is-resolved': resolved, 'is-outdated': root.outdated }"
    :aria-label="location"
  >
    <header class="thread-header">
      <code v-if="showContext" class="thread-location">{{ location }}</code>
      <StatusBadge v-if="root.pending" tone="neutral">{{ t("threadPending") }}</StatusBadge>
      <StatusBadge v-if="root.outdated" tone="warning">{{ t("threadOutdated") }}</StatusBadge>
      <StatusBadge v-if="resolved" tone="done">{{ t("threadResolved") }}</StatusBadge>
      <span v-if="resolved && root.resolvedBy" class="muted thread-resolver">{{
        t("threadResolvedBy", { name: root.resolvedBy.name })
      }}</span>
      <FluentButton
        v-if="resolved"
        type="button"
        tone="subtle"
        size="small"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? t("hideThread") : t("showThread") }}
      </FluentButton>
    </header>
    <pre
      v-if="showContext && root.diffHunk && open"
      class="thread-hunk"
    ><span class="visually-hidden">{{ t("originalContext") }}: </span>{{ root.diffHunk }}</pre>
    <template v-if="open">
      <div v-for="comment in comments" :key="comment.id" class="thread-comment">
        <div class="thread-comment-head">
          <strong>{{ actorLabel(comment) }}</strong>
          <span class="muted">{{ d(comment.createdAt, "long") }}</span>
          <span class="thread-comment-actions">
            <FluentButton
              v-if="own(comment) && canComment"
              type="button"
              tone="subtle"
              size="small"
              :disabled="busy"
              @click="startEdit(comment)"
            >
              {{ t("edit") }}
            </FluentButton>
            <ConfirmButton
              v-if="canComment && (own(comment) || canModerate)"
              :label="t('delete')"
              :prompt="t('removeCommentPrompt')"
              tone="subtle"
              size="small"
              :busy="busy"
              @confirm="emit('remove', comment)"
            />
          </span>
        </div>
        <form
          v-if="editingId === comment.id"
          class="form-stack"
          @submit.prevent="saveEdit(comment)"
        >
          <TextAreaField v-model="editBody" rows="3" :label="t('writeComment')" required />
          <div class="form-actions">
            <FluentButton type="submit" tone="primary" size="small" :disabled="busy">{{
              t("save")
            }}</FluentButton>
            <FluentButton type="button" size="small" @click="editingId = ''">{{
              t("cancel")
            }}</FluentButton>
          </div>
        </form>
        <template v-else>
          <template
            v-for="(segment, index) in splitSuggestions(comment.body)"
            :key="`${comment.id}-${index}`"
          >
            <MarkdownContent
              v-if="segment.kind === 'markdown'"
              class="body-content"
              mentions
              :source="segment.text"
            />
            <figure v-else class="thread-suggestion">
              <figcaption>{{ t("suggestedChange") }}</figcaption>
              <p v-if="!segment.lines.length" class="muted">{{ t("emptySuggestion") }}</p>
              <pre><code
                v-for="(line, lineIndex) in replacedLines"
                :key="`old-${lineIndex}`"
                class="suggestion-removed"
              >- {{ line }}</code><code
                v-for="(line, lineIndex) in segment.lines"
                :key="`new-${lineIndex}`"
                class="suggestion-added"
              >+ {{ line }}</code></pre>
            </figure>
          </template>
        </template>
      </div>
      <form v-if="canComment" class="thread-reply form-stack" @submit.prevent="sendReply">
        <TextAreaField
          v-model="replyBody"
          rows="2"
          :placeholder="t('replyPlaceholder')"
          :label="t('replyPlaceholder')"
        />
        <div class="form-actions">
          <FluentButton type="submit" size="small" :disabled="busy || !replyBody.trim()">{{
            t("replyToThread")
          }}</FluentButton>
          <FluentButton
            v-if="canResolve"
            type="button"
            tone="subtle"
            size="small"
            :disabled="busy"
            @click="emit('resolve', root, !resolved)"
          >
            {{ resolved ? t("unresolveThread") : t("resolveThread") }}
          </FluentButton>
        </div>
      </form>
    </template>
  </article>
</template>

<style scoped>
.review-thread {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  color: var(--fg-default);
  font: var(--font-size-body) / var(--line-height-body) var(--font-sans);
}
.review-thread.is-resolved {
  background: var(--bg-subtle);
}
.thread-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.thread-location {
  font: var(--font-size-meta) / 20px var(--font-mono);
  overflow-wrap: anywhere;
}
.thread-hunk {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--fg-secondary);
  font: var(--font-size-meta) / 20px var(--font-mono);
}
.thread-comment {
  display: grid;
  gap: var(--space-1);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
}
.thread-comment:first-of-type {
  padding-top: 0;
  border-top: 0;
}
.thread-comment-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-meta);
}
.thread-comment-actions {
  display: inline-flex;
  gap: var(--space-1);
  margin-inline-start: auto;
}
.thread-suggestion {
  margin: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.thread-suggestion figcaption {
  padding: var(--space-1) var(--space-3);
  background: var(--bg-subtle);
  color: var(--fg-secondary);
  font-size: var(--font-size-meta);
}
.thread-suggestion pre {
  margin: 0;
  overflow: auto;
  font: var(--font-size-meta) / 20px var(--font-mono);
}
.thread-suggestion code {
  display: block;
  padding-inline: var(--space-3);
  font: inherit;
  white-space: pre;
}
.suggestion-removed {
  background: var(--danger-subtle);
  color: var(--danger-fg);
}
.suggestion-added {
  background: var(--success-subtle);
  color: var(--success-fg);
}
.thread-reply {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
}
</style>
