<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { parsePatch } from "diff";
import type { ReviewComment, ReviewThreadDraft } from "../lib/api";
import type { ReviewThreadGroup } from "../lib/reviewThreads";
import ReviewComposer from "./ReviewComposer.vue";
import ReviewThread from "./ReviewThread.vue";

type Side = "LEFT" | "RIGHT";
const props = defineProps<{
  patch: string;
  path?: string;
  /** Line commenting; omit for a plain read-only diff. */
  review?: {
    threads: ReviewThreadGroup[];
    canComment: boolean;
    canModerate: boolean;
    isPullAuthor: boolean;
    viewerKey: string | null;
    hasPendingReview: boolean;
    busy: boolean;
  };
}>();
const emit = defineEmits<{
  create: [draft: ReviewThreadDraft];
  reply: [root: ReviewComment, body: string];
  edit: [comment: ReviewComment, body: string];
  remove: [comment: ReviewComment];
  resolve: [root: ReviewComment, resolved: boolean];
}>();
const { t } = useI18n();
const HUNK_CONTEXT_LINES = 6;
interface DiffLine {
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
  kind: string;
  /** Side and number a comment on this row attaches to. */
  anchor: { side: Side; line: number } | null;
  context: string;
}
const hunks = computed(() => {
  try {
    return parsePatch(props.patch).flatMap((file) =>
      file.hunks.map((hunk) => {
        let oldLine = hunk.oldStart,
          newLine = hunk.newStart;
        const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
        const lines: DiffLine[] = hunk.lines.map((text) => {
          const kind = text.startsWith("+")
            ? "addition"
            : text.startsWith("-")
              ? "deletion"
              : text.startsWith("\\")
                ? "note"
                : "context";
          const oldNumber = kind === "addition" || kind === "note" ? null : oldLine++;
          const newNumber = kind === "deletion" || kind === "note" ? null : newLine++;
          const anchor =
            kind === "deletion" && oldNumber !== null
              ? { side: "LEFT" as const, line: oldNumber }
              : newNumber !== null
                ? { side: "RIGHT" as const, line: newNumber }
                : null;
          return { text, kind, oldNumber, newNumber, anchor, context: "" };
        });
        lines.forEach((line, index) => {
          line.context = [
            header,
            ...lines
              .slice(Math.max(0, index - HUNK_CONTEXT_LINES + 1), index + 1)
              .map((row) => row.text),
          ].join("\n");
        });
        return { header, lines };
      })
    );
  } catch {
    return [];
  }
});

interface Compose {
  side: Side;
  line: number;
  startLine?: number;
  context: string;
}
const compose = ref<Compose | null>(null);

function startCompose(line: DiffLine, event: MouseEvent) {
  const anchor = line.anchor;
  if (!anchor || !props.review?.canComment) return;
  const current = compose.value;
  if (event.shiftKey && current && current.side === anchor.side) {
    const start = Math.min(current.startLine ?? current.line, anchor.line);
    const end = Math.max(current.line, anchor.line);
    compose.value = { ...current, startLine: start === end ? undefined : start, line: end };
    return;
  }
  compose.value = { side: anchor.side, line: anchor.line, context: line.context.slice(-4000) };
}
function composeAt(line: DiffLine): Compose | null {
  const current = compose.value;
  const anchor = line.anchor;
  return current && anchor && current.side === anchor.side && current.line === anchor.line
    ? current
    : null;
}
function threadsAt(line: DiffLine): ReviewThreadGroup[] {
  const anchor = line.anchor;
  if (!anchor || !props.review) return [];
  return props.review.threads.filter(
    (thread) =>
      !thread.root.outdated && thread.root.side === anchor.side && thread.root.line === anchor.line
  );
}
function submit(body: string, pending: boolean) {
  const current = compose.value;
  if (!current || !props.path) return;
  emit("create", {
    body,
    path: props.path,
    side: current.side,
    line: current.line,
    startLine: current.startLine,
    diffHunk: current.context,
    pending,
  });
  compose.value = null;
}
function composeLabelAt(line: DiffLine): string {
  const current = composeAt(line);
  if (!current) return "";
  return current.startLine === undefined
    ? t("commentOnLine", { line: current.line })
    : t("commentOnRange", { start: current.startLine, end: current.line });
}
</script>
<template>
  <div class="diff-viewer" tabindex="0" role="region" :aria-label="path ?? t('diff')">
    <table v-if="hunks.length">
      <thead class="visually-hidden">
        <tr>
          <th scope="col">{{ t("diffOldLine") }}</th>
          <th scope="col">{{ t("diffNewLine") }}</th>
          <th scope="col">{{ t("diffChange") }}</th>
        </tr>
      </thead>
      <tbody v-for="(hunk, index) in hunks" :key="index">
        <tr class="diff-hunk">
          <td></td>
          <td></td>
          <td>
            <code>{{ hunk.header }}</code>
          </td>
        </tr>
        <template v-for="(line, lineIndex) in hunk.lines" :key="lineIndex">
          <tr :class="`diff-${line.kind}`">
            <td class="diff-number">
              <button
                v-if="review?.canComment && path && line.anchor?.side === 'LEFT'"
                type="button"
                class="diff-comment-button"
                :aria-label="t('addLineComment', { line: line.anchor.line })"
                @click="startCompose(line, $event)"
              >
                +
              </button>
              {{ line.oldNumber }}
            </td>
            <td class="diff-number">
              <button
                v-if="review?.canComment && path && line.anchor?.side === 'RIGHT'"
                type="button"
                class="diff-comment-button"
                :aria-label="t('addLineComment', { line: line.anchor.line })"
                @click="startCompose(line, $event)"
              >
                +
              </button>
              {{ line.newNumber }}
            </td>
            <td class="diff-code">
              <code>{{ line.text }}</code>
            </td>
          </tr>
          <tr v-for="thread in threadsAt(line)" :key="thread.root.id" class="diff-thread-row">
            <td colspan="3">
              <div class="diff-thread">
                <ReviewThread
                  v-if="review"
                  :thread="thread"
                  :viewer-key="review.viewerKey"
                  :can-comment="review.canComment"
                  :can-moderate="review.canModerate"
                  :is-pull-author="review.isPullAuthor"
                  :busy="review.busy"
                  @reply="(root, body) => emit('reply', root, body)"
                  @edit="(comment, body) => emit('edit', comment, body)"
                  @remove="(comment) => emit('remove', comment)"
                  @resolve="(root, resolved) => emit('resolve', root, resolved)"
                />
              </div>
            </td>
          </tr>
          <tr v-if="composeAt(line) && review" class="diff-thread-row">
            <td colspan="3">
              <div class="diff-thread">
                <ReviewComposer
                  :label="composeLabelAt(line)"
                  :busy="review.busy"
                  :has-pending-review="review.hasPendingReview"
                  @submit="submit"
                  @cancel="compose = null"
                />
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <pre v-else>{{ patch }}</pre>
  </div>
</template>
<style scoped>
.diff-viewer {
  width: 100%;
  max-height: 70vh;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-canvas);
  container-type: inline-size;
}
.diff-viewer:focus-visible {
  outline-offset: -2px;
}
table {
  min-width: 100%;
  border-collapse: collapse;
  font: var(--font-size-meta) / 20px var(--font-mono);
}
td {
  padding: 0 var(--space-3);
  vertical-align: top;
}
.diff-number {
  position: relative;
  width: 48px;
  min-width: 48px;
  color: var(--fg-muted);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--border-muted);
}
.diff-comment-button {
  position: absolute;
  inset-block: 1px;
  inset-inline-start: 2px;
  display: grid;
  place-items: center;
  width: 20px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--control-bg);
  color: var(--fg-default);
  font: inherit;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
}
tr:hover .diff-comment-button,
.diff-comment-button:focus-visible {
  opacity: 1;
}
.diff-comment-button:hover {
  background: var(--control-bg-hover);
}
@media (hover: none) {
  .diff-comment-button {
    opacity: 1;
  }
}
.diff-code {
  width: 100%;
}
code {
  font: inherit;
  white-space: pre;
  color: inherit;
}
.diff-addition {
  background: light-dark(#dafbe1, #12261e);
}
.diff-addition .diff-number {
  background: light-dark(#aceebb, #143e26);
}
.diff-deletion {
  background: light-dark(#ffebe9, #311c1f);
}
.diff-deletion .diff-number {
  background: light-dark(#ffd8d3, #522329);
}
.diff-hunk {
  color: var(--fg-muted);
  background: light-dark(#ddf4ff, #182b40);
}
.diff-hunk td {
  padding-block: var(--space-1);
}
.diff-thread-row td {
  padding: 0;
  background: var(--bg-canvas);
  font-family: var(--font-sans);
}
.diff-thread {
  position: sticky;
  inset-inline-start: 0;
  box-sizing: border-box;
  width: min(100cqw, 760px);
  padding: var(--space-2) var(--space-3);
  white-space: normal;
}
pre {
  margin: 0;
  padding: var(--space-3);
  font: var(--font-size-meta) / 20px var(--font-mono);
}
</style>
