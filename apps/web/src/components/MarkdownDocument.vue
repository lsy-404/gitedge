<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import type { DocumentRevisionSummary } from "../lib/api";
import { ApiError } from "../lib/api";
import {
  errorMessage,
  revisionActorLabel,
  revisionActorTone,
  type DocumentView,
} from "../lib/tasks";
import MarkdownContent from "./MarkdownContent.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import TextAreaField from "./TextAreaField.vue";

/**
 * A Markdown document with optimistic-concurrency editing and a revision history. The parent owns
 * the current document and receives every change through `update`; the loaders are plain async
 * functions so the same pane serves the memory index and each task document.
 */
const props = defineProps<{
  title: string;
  document: DocumentView;
  canEdit: boolean;
  emptyText: string;
  loadHistory: () => Promise<DocumentRevisionSummary[]>;
  loadRevision: (revision: number) => Promise<DocumentView>;
  save: (content: string, expectedRevision: number) => Promise<DocumentView>;
  reload: () => Promise<DocumentView>;
}>();
const emit = defineEmits<{ update: [document: DocumentView] }>();

const { t } = useI18n();
const headingId = useId();
const editing = ref(false);
const draft = ref("");
/** Revision the draft was written against; saving uses it so a changed document yields a conflict. */
const baseRevision = ref(0);
const saving = ref(false);
const error = ref("");
const conflict = ref(false);
const reloadedRevision = ref<number | null>(null);
const showHistory = ref(false);
const history = ref<DocumentRevisionSummary[]>([]);
const historyLoading = ref(false);
const historyError = ref("");
const viewing = ref<DocumentView | null>(null);
const shown = computed(() => viewing.value ?? props.document);

function startEdit(content: string = props.document.content) {
  draft.value = content;
  baseRevision.value = props.document.revision;
  editing.value = true;
  viewing.value = null;
  error.value = "";
  conflict.value = false;
  reloadedRevision.value = null;
}

function cancelEdit() {
  editing.value = false;
  error.value = "";
  conflict.value = false;
  reloadedRevision.value = null;
}

async function submit() {
  saving.value = true;
  error.value = "";
  try {
    const saved = await props.save(draft.value, baseRevision.value);
    emit("update", saved);
    editing.value = false;
    conflict.value = false;
    reloadedRevision.value = null;
    if (showHistory.value) await refreshHistory();
  } catch (cause) {
    conflict.value = cause instanceof ApiError && cause.status === 409;
    error.value = conflict.value ? t("docConflict") : errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}

/** Fetches the newest revision but keeps the draft, so the writer can merge by hand. */
async function loadLatest() {
  saving.value = true;
  try {
    const latest = await props.reload();
    emit("update", latest);
    baseRevision.value = latest.revision;
    conflict.value = false;
    error.value = "";
    reloadedRevision.value = latest.revision;
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}

async function refreshHistory() {
  historyLoading.value = true;
  historyError.value = "";
  try {
    history.value = await props.loadHistory();
  } catch (cause) {
    historyError.value = errorMessage(cause, t);
  } finally {
    historyLoading.value = false;
  }
}

async function toggleHistory() {
  showHistory.value = !showHistory.value;
  if (showHistory.value) await refreshHistory();
  else viewing.value = null;
}

async function viewRevision(revision: number) {
  historyError.value = "";
  try {
    viewing.value =
      revision === props.document.revision ? null : await props.loadRevision(revision);
  } catch (cause) {
    historyError.value = errorMessage(cause, t);
  }
}
</script>

<template>
  <section class="doc" :aria-labelledby="headingId">
    <div class="doc-head">
      <h3 :id="headingId">{{ title }}</h3>
      <StatusBadge>r{{ shown.revision }}</StatusBadge>
      <slot name="meta" />
      <span v-if="shown.actor" class="doc-byline muted">
        {{ revisionActorLabel(shown.actor, t) }}
        <template v-if="shown.updatedAt">
          · {{ new Date(shown.updatedAt).toLocaleString() }}</template
        >
      </span>
      <div class="doc-actions">
        <FluentButton
          v-if="canEdit && !editing && !viewing"
          type="button"
          size="small"
          @click="startEdit()"
          >{{ t("edit") }}</FluentButton
        >
        <FluentButton
          type="button"
          size="small"
          :aria-expanded="showHistory"
          @click="toggleHistory"
          >{{ t("history") }}</FluentButton
        >
      </div>
    </div>

    <form v-if="editing" class="form-stack doc-editor" @submit.prevent="submit">
      <TextAreaField v-model="draft" rows="14" :label="t('docContent')" />
      <NoticeBar v-if="error" intent="error">
        {{ error }}
        <template v-if="conflict" #actions>
          <FluentButton size="small" type="button" :disabled="saving" @click="loadLatest">{{
            t("docLoadLatest")
          }}</FluentButton>
        </template>
      </NoticeBar>
      <NoticeBar v-if="reloadedRevision !== null" intent="info">{{
        t("docLatestLoaded", { revision: reloadedRevision })
      }}</NoticeBar>
      <details v-if="reloadedRevision !== null" class="doc-latest">
        <summary>{{ t("docLatest") }}</summary>
        <MarkdownContent :source="document.content" />
      </details>
      <div class="form-actions">
        <FluentButton type="button" @click="cancelEdit">{{ t("cancel") }}</FluentButton>
        <FluentButton type="submit" tone="primary" :disabled="saving">{{
          saving ? t("loading") : t("save")
        }}</FluentButton>
      </div>
    </form>
    <template v-else>
      <NoticeBar v-if="viewing" intent="info">
        {{ t("docViewing", { revision: viewing.revision }) }}
        <template #actions>
          <FluentButton size="small" type="button" @click="viewing = null">{{
            t("docBackToCurrent")
          }}</FluentButton>
          <FluentButton
            v-if="canEdit"
            size="small"
            type="button"
            @click="startEdit(viewing.content)"
            >{{ t("docRestoreDraft") }}</FluentButton
          >
        </template>
      </NoticeBar>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <MarkdownContent v-if="shown.content.trim()" class="doc-body" :source="shown.content" />
      <p v-else class="doc-empty muted">{{ emptyText }}</p>
    </template>

    <div v-if="showHistory" class="doc-history">
      <p class="eyebrow">{{ t("revisionHistory") }}</p>
      <p v-if="historyLoading" class="muted" role="status">{{ t("loading") }}</p>
      <NoticeBar v-else-if="historyError" intent="error">{{ historyError }}</NoticeBar>
      <p v-else-if="!history.length" class="muted">{{ t("docNoHistory") }}</p>
      <ol v-else class="doc-revisions">
        <li v-for="revision in history" :key="revision.revision">
          <strong>r{{ revision.revision }}</strong>
          <StatusBadge :tone="revisionActorTone(revision.actor)">{{
            revisionActorLabel(revision.actor, t)
          }}</StatusBadge>
          <small class="muted"
            >{{ t("docSize", { size: revision.size }) }} ·
            {{ new Date(revision.updatedAt).toLocaleString() }}</small
          >
          <FluentButton
            type="button"
            size="small"
            :aria-label="`${t('docViewRevision')} r${revision.revision}`"
            :disabled="shown.revision === revision.revision"
            @click="viewRevision(revision.revision)"
            >{{ t("docViewRevision") }}</FluentButton
          >
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.doc {
  display: grid;
  gap: var(--spacingVerticalM);
  min-width: 0;
}
.doc-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalS);
}
.doc-head h3 {
  margin: 0;
}
.doc-byline {
  font-size: var(--fontSizeBase200);
}
.doc-actions {
  display: flex;
  gap: var(--spacingHorizontalS);
  margin-left: auto;
}
.doc-body {
  min-width: 0;
}
.doc-empty {
  padding: var(--spacingVerticalL) 0;
}
.doc-editor :deep(textarea) {
  height: 320px;
  font-family: var(--fontFamilyMonospace);
  resize: vertical;
}
.doc-latest {
  padding: var(--spacingVerticalM);
  border: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground3);
}
.doc-latest summary {
  cursor: pointer;
  margin-bottom: var(--spacingVerticalS);
  font-weight: var(--fontWeightSemibold);
}
.doc-history {
  padding-top: var(--spacingVerticalM);
  border-top: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
}
.doc-revisions {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.doc-revisions li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalM);
  min-height: 44px;
  border-bottom: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
}
.doc-revisions li .fluent-button {
  margin-left: auto;
}
</style>
