<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ReviewComment } from "../lib/api";
import { splitSuggestions, type ReviewThreadGroup } from "../lib/reviewThreads";
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
}>();
const emit = defineEmits<{
  reply: [root: ReviewComment, body: string];
  edit: [comment: ReviewComment, body: string];
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
    (props.canModerate ||
      props.isPullAuthor ||
      (props.viewerKey !== null && ownKey(root.value) === props.viewerKey))
);

function ownKey(comment: ReviewComment): string {
  return `${comment.actor.kind}:${comment.actor.id}`;
}
function own(comment: ReviewComment): boolean {
  return props.viewerKey !== null && ownKey(comment) === props.viewerKey;
}
function startEdit(comment: ReviewComment) {
  editingId.value = comment.id;
  editBody.value = comment.body;
}
function saveEdit(comment: ReviewComment) {
  if (!editBody.value.trim()) return;
  emit("edit", comment, editBody.value);
  editingId.value = "";
}
function sendReply() {
  if (!replyBody.value.trim()) return;
  emit("reply", root.value, replyBody.value);
  replyBody.value = "";
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
              :source="segment.text"
            />
            <figure v-else class="thread-suggestion">
              <figcaption>{{ t("suggestedChange") }}</figcaption>
              <p v-if="!segment.lines.length" class="muted">{{ t("emptySuggestion") }}</p>
              <pre
                v-else
              ><code v-for="(line, lineIndex) in segment.lines" :key="lineIndex">+ {{ line }}</code></pre>
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
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  background: var(--success-subtle);
  color: var(--success-fg);
  font: var(--font-size-meta) / 20px var(--font-mono);
}
.thread-suggestion code {
  display: block;
  font: inherit;
  white-space: pre;
}
.thread-reply {
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
}
</style>
