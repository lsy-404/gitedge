<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AssigneeCandidate,
  Issue,
  PullRequest,
  Repository,
  TaskDetail,
  TaskDocument,
  TaskDocumentKind,
  TaskLink,
  TaskLinkKind,
} from "../lib/api";
import { ApiError, api } from "../lib/api";
import { sessionState } from "../lib/session";
import {
  assigneeKey,
  errorMessage,
  gitOidPattern,
  parseAssigneeKey,
  revisionActorLabel,
  revisionActorTone,
  taskDocumentKinds,
  taskStatusTone,
  taskStatuses,
  taskTypePattern,
  type DocumentView,
} from "../lib/tasks";
import { oneOf } from "../ui/formEvents";
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import MarkdownDocument from "./MarkdownDocument.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import TextAreaField from "./TextAreaField.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ repository: Repository; number: number }>();
const { t } = useI18n();

const task = ref<TaskDetail | null>(null);
const documents = ref<Record<TaskDocumentKind, TaskDocument> | null>(null);
const candidates = ref<AssigneeCandidate[]>([]);
const loading = ref(true);
const error = ref("");
const notFound = ref(false);
const unavailable = ref(false);
const actionError = ref("");
const saving = ref(false);
const activeDocument = ref<TaskDocumentKind>("plan");
const documentTablist = ref<HTMLElement | null>(null);
const editing = ref(false);
const draft = ref({ type: "", title: "", motivation: "", description: "" });

const showLinkForm = ref(false);
const linkOptions = ref<LinkOption[]>([]);
const linkChoice = ref("");
const linkError = ref("");
const showCommitForm = ref(false);
const commitForm = ref({ oid: "", ref: props.repository.defaultBranch });
const commitError = ref("");
let loadVersion = 0;

const canEdit = computed(() => Boolean(sessionState.user) && props.repository.canWrite);
const tasksPath = computed(() => `/${props.repository.owner}/${props.repository.name}/tasks`);
/** An assignee the caller could not pick again, such as another member's agent, stays listed. */
const assigneeOutsideCandidates = computed(() => {
  const assignee = task.value?.assignee;
  if (!assignee) return null;
  const key = assigneeKey(assignee);
  return candidates.value.some((candidate) => assigneeKey(candidate) === key)
    ? null
    : { key, name: assignee.name };
});
const progress = computed(() => task.value?.progress ?? { total: 0, done: 0, percent: null });

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  unavailable.value = false;
  try {
    const [detail, people] = await Promise.all([
      api.task(props.repository.id, props.number),
      canEdit.value
        ? api.assigneeCandidates(props.repository.id).catch(() => [])
        : Promise.resolve([]),
    ]);
    if (version !== loadVersion) return;
    task.value = detail;
    documents.value = detail.documents;
    candidates.value = people;
    draft.value = {
      type: detail.type,
      title: detail.title,
      motivation: detail.motivation,
      description: detail.description,
    };
  } catch (cause) {
    if (version !== loadVersion) return;
    if (cause instanceof ApiError && cause.status === 404) notFound.value = true;
    else if (cause instanceof ApiError && cause.status === 403) unavailable.value = true;
    else error.value = t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

/**
 * Adopts a task response, documents included: status changes and merges append system entries to
 * progress. An open editor keeps its draft and saves against the revision it started from.
 */
function applyDetail(detail: TaskDetail) {
  task.value = detail;
  documents.value = detail.documents;
}

async function refresh() {
  applyDetail(await api.task(props.repository.id, props.number));
}

async function run(action: () => Promise<void>, overrides: Partial<Record<number, string>> = {}) {
  saving.value = true;
  actionError.value = "";
  try {
    await action();
  } catch (cause) {
    actionError.value = errorMessage(cause, t, overrides);
  } finally {
    saving.value = false;
  }
}

function setStatus(value: string) {
  const current = task.value;
  if (!current) return;
  const status = oneOf(taskStatuses, value, current.status);
  if (status === current.status) return;
  void run(async () => {
    applyDetail(await api.updateTask(props.repository.id, props.number, { status }));
  });
}

function setAssignee(value: string) {
  const current = task.value;
  if (!current) return;
  const next = parseAssigneeKey(value, candidates.value);
  const currentKey = current.assignee ? assigneeKey(current.assignee) : "";
  if (value === currentKey) return;
  void run(
    async () => {
      applyDetail(await api.assignTask(props.repository.id, props.number, next));
    },
    { 400: "assignInvalid", 403: "assignPolicyDenied" }
  );
}

function submitEdit() {
  if (!taskTypePattern.test(draft.value.type)) {
    actionError.value = t("taskTypeInvalid");
    return;
  }
  void run(
    async () => {
      applyDetail(
        await api.updateTask(props.repository.id, props.number, {
          type: draft.value.type,
          title: draft.value.title.trim(),
          motivation: draft.value.motivation,
          description: draft.value.description,
        })
      );
      editing.value = false;
    },
    { 400: "taskInvalid" }
  );
}

async function moveDocument(offset: number) {
  const currentIndex = taskDocumentKinds.indexOf(activeDocument.value);
  const nextIndex = (currentIndex + offset + taskDocumentKinds.length) % taskDocumentKinds.length;
  const nextDocument = taskDocumentKinds[nextIndex];
  if (!nextDocument) return;
  activeDocument.value = nextDocument;
  await nextTick();
  documentTablist.value?.querySelector<HTMLButtonElement>(`#doc-tab-${nextDocument}`)?.focus();
}

function setDocument(kind: TaskDocumentKind, document: DocumentView) {
  const current = documents.value?.[kind];
  if (!documents.value || !current) return;
  documents.value = {
    ...documents.value,
    [kind]: {
      ...current,
      content: document.content,
      revision: document.revision,
      updatedAt: document.updatedAt ?? current.updatedAt,
      actor: document.actor ?? current.actor,
    },
  };
}

interface LinkOption {
  kind: TaskLinkKind;
  number: number;
  title: string;
}

function linkOptionKey(option: LinkOption): string {
  return `${option.kind}:${option.number}`;
}

function openLinkForm() {
  showLinkForm.value = !showLinkForm.value;
  linkError.value = "";
  linkChoice.value = "";
  if (!showLinkForm.value) return;
  void (async () => {
    try {
      const [issues, pulls] = await Promise.all([
        api.issues(props.repository.id),
        api.pulls(props.repository.id),
      ]);
      const linked = new Set(task.value?.links.map((link) => `${link.kind}:${link.number}`));
      linkOptions.value = [
        ...issues.map((row: Issue) => ({
          kind: "issue" as const,
          number: row.number,
          title: row.title,
        })),
        ...pulls.map((row: PullRequest) => ({
          kind: "pull_request" as const,
          number: row.number,
          title: row.title,
        })),
      ].filter((option) => !linked.has(linkOptionKey(option)));
    } catch (cause) {
      linkError.value = errorMessage(cause, t);
    }
  })();
}

async function attachLink() {
  const option = linkOptions.value.find((entry) => linkOptionKey(entry) === linkChoice.value);
  if (!option) return;
  linkError.value = "";
  saving.value = true;
  try {
    await api.attachTaskLink(props.repository.id, props.number, {
      kind: option.kind,
      number: option.number,
    });
    showLinkForm.value = false;
    await refresh();
  } catch (cause) {
    linkError.value = errorMessage(cause, t, { 409: "taskLinkConflict" });
  } finally {
    saving.value = false;
  }
}

function detach(link: TaskLink) {
  void run(async () => {
    await api.detachTaskLink(props.repository.id, props.number, link.kind, link.number);
    await refresh();
  });
}

async function bindCommit() {
  commitError.value = "";
  const oid = commitForm.value.oid.trim().toLowerCase();
  if (!gitOidPattern.test(oid)) {
    commitError.value = t("taskCommitOidInvalid");
    return;
  }
  saving.value = true;
  try {
    await api.bindTaskCommit(props.repository.id, props.number, {
      oid,
      ref: commitForm.value.ref.trim(),
    });
    commitForm.value = { oid: "", ref: props.repository.defaultBranch };
    showCommitForm.value = false;
    await refresh();
  } catch (cause) {
    commitError.value = errorMessage(cause, t, {
      400: "taskCommitRefInvalid",
      404: "taskCommitNotFound",
      409: "taskCommitDuplicate",
    });
  } finally {
    saving.value = false;
  }
}

function unbind(oid: string) {
  void run(async () => {
    await api.unbindTaskCommit(props.repository.id, props.number, oid);
    await refresh();
  });
}

function linkPath(link: TaskLink): string {
  const section = link.kind === "issue" ? "issues" : "pulls";
  return `/${props.repository.owner}/${props.repository.name}/${section}/${link.number}`;
}

function linkTone(state: TaskLink["state"]): "success" | "danger" | "brand" {
  if (state === "open") return "success";
  return state === "merged" ? "brand" : "danger";
}

watch(() => [props.repository.id, props.number], load, { immediate: true });
</script>

<template>
  <section class="task-detail">
    <AppLink class="back-link" :to="tasksPath">← {{ t("tasks") }}</AppLink>
    <StatusState
      v-if="loading || error || notFound"
      :loading="loading"
      :error="error"
      :empty="notFound"
      @retry="load"
    >
      <template #empty>{{ t("resourceNotFound") }}</template>
    </StatusState>
    <NoticeBar v-else-if="unavailable" intent="info">{{ t("tasksUnavailable") }}</NoticeBar>
    <template v-else-if="task && documents">
      <article class="box box-form task-card">
        <div class="task-heading">
          <div class="task-title-block">
            <p class="eyebrow">#{{ task.number }}</p>
            <h2>
              <StatusBadge tone="brand">{{ task.type }}</StatusBadge> {{ task.title }}
            </h2>
          </div>
          <fluent-button
            v-if="canEdit"
            type="button"
            :aria-expanded="editing"
            @click="editing = !editing"
            >{{ editing ? t("cancel") : t("edit") }}</fluent-button
          >
        </div>

        <div class="task-controls">
          <SelectField
            v-if="canEdit"
            :model-value="task.status"
            :label="t('taskStatusLabel')"
            :disabled="saving"
            @update:model-value="setStatus"
          >
            <option v-for="status in taskStatuses" :key="status" :value="status">{{
              t(`taskStatus_${status}`)
            }}</option>
          </SelectField>
          <div v-else class="task-readonly">
            <p class="eyebrow">{{ t("taskStatusLabel") }}</p>
            <StatusBadge :tone="taskStatusTone(task.status)">{{
              t(`taskStatus_${task.status}`)
            }}</StatusBadge>
          </div>
          <SelectField
            v-if="canEdit"
            :model-value="task.assignee ? assigneeKey(task.assignee) : ''"
            :label="t('taskAssignee')"
            :disabled="saving"
            @update:model-value="setAssignee"
          >
            <option value="">{{ t("taskUnassigned") }}</option>
            <option
              v-if="assigneeOutsideCandidates"
              :value="assigneeOutsideCandidates.key"
              >{{ assigneeOutsideCandidates.name }}</option
            >
            <option
              v-for="candidate in candidates"
              :key="assigneeKey(candidate)"
              :value="assigneeKey(candidate)"
              >{{ candidate.name
              }}<template v-if="candidate.kind === 'agent'">
                · {{ t("agent") }}</template
              ></option
            >
          </SelectField>
          <div v-else class="task-readonly">
            <p class="eyebrow">{{ t("taskAssignee") }}</p>
            <span v-if="task.assignee"
              >{{ task.assignee.name
              }}<template v-if="task.assignee.kind === 'agent'"> · {{ t("agent") }}</template></span
            >
            <span v-else class="muted">{{ t("taskUnassigned") }}</span>
          </div>
        </div>

        <div class="actor-line">
          {{ task.actor.name
          }}<template v-if="task.actor.kind === 'agent'"> · {{ t("agent") }}</template> ·
          {{ new Date(task.createdAt).toLocaleString() }}
          <span class="muted"
            >· {{ t("updatedOn", { date: new Date(task.updatedAt).toLocaleString() }) }}</span
          >
        </div>

        <form v-if="editing" class="form-stack task-edit" @submit.prevent="submitEdit">
          <TextField v-model="draft.type" required>{{ t("taskType") }}</TextField>
          <TextField v-model="draft.title" required>{{ t("taskTitle") }}</TextField>
          <TextAreaField v-model="draft.motivation" rows="3" :label="t('taskMotivation')" />
          <TextAreaField v-model="draft.description" rows="5" :label="t('description')" />
          <div class="form-actions">
            <fluent-button type="submit" appearance="primary" :disabled="saving">{{
              t("save")
            }}</fluent-button>
          </div>
        </form>
        <div v-else class="task-overview">
          <div>
            <p class="eyebrow">{{ t("taskMotivation") }}</p>
            <p v-if="task.motivation" class="body-text">{{ task.motivation }}</p>
            <p v-else class="muted">{{ t("taskMotivationEmpty") }}</p>
          </div>
          <div>
            <p class="eyebrow">{{ t("description") }}</p>
            <p v-if="task.description" class="body-text">{{ task.description }}</p>
            <p v-else class="muted">{{ t("taskDescriptionEmpty") }}</p>
          </div>
        </div>
        <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>

        <div class="task-progress-block">
          <p class="eyebrow">{{ t("taskProgress") }}</p>
          <div class="task-progress">
            <progress
              class="bar"
              max="100"
              :value="progress.percent ?? 0"
              :aria-label="t('taskProgress')"
            ></progress>
            <span v-if="progress.total" class="muted">{{
              t("taskProgressCount", { done: progress.done, total: progress.total })
            }}</span>
            <span v-else class="muted">{{ t("taskNoLinks") }}</span>
          </div>
        </div>
      </article>

      <section class="box box-form doc-card" :aria-label="t('taskDocuments')">
        <div
          ref="documentTablist"
          class="doc-tabs"
          role="tablist"
          :aria-label="t('taskDocuments')"
        >
          <button
            v-for="kind in taskDocumentKinds"
            :id="`doc-tab-${kind}`"
            :key="kind"
            class="doc-tab"
            type="button"
            role="tab"
            :aria-selected="activeDocument === kind"
            aria-controls="task-document-panel"
            :tabindex="activeDocument === kind ? 0 : -1"
            @click="activeDocument = kind"
            @keydown.left.prevent="moveDocument(-1)"
            @keydown.right.prevent="moveDocument(1)"
          >
            {{ t(`docKind_${kind}`) }}
          </button>
        </div>
        <div
          id="task-document-panel"
          class="doc-panel"
          role="tabpanel"
          :aria-labelledby="`doc-tab-${activeDocument}`"
        >
          <MarkdownDocument
            :key="activeDocument"
            :title="t(`docKind_${activeDocument}`)"
            :document="documents[activeDocument]"
            :can-edit="canEdit"
            :empty-text="t(`docEmpty_${activeDocument}`)"
            :load-history="() => api.taskDocumentHistory(repository.id, number, activeDocument)"
            :load-revision="
              (revision) =>
                api.taskDocumentRevision(repository.id, number, activeDocument, revision)
            "
            :save="
              (content, expectedRevision) =>
                api.putTaskDocument(repository.id, number, activeDocument, {
                  content,
                  expectedRevision,
                })
            "
            :reload="() => api.taskDocument(repository.id, number, activeDocument)"
            @update="setDocument(activeDocument, $event)"
          />
        </div>
      </section>

      <section class="box box-form links-card" :aria-label="t('taskLinks')">
        <div class="section-head">
          <h3>{{ t("taskLinks") }}</h3>
          <fluent-button
            v-if="canEdit"
            type="button"
            size="small"
            :aria-expanded="showLinkForm"
            @click="openLinkForm"
            ><AppIcon slot="start" name="plus" />{{ t("taskLinkAttach") }}</fluent-button
          >
        </div>
        <form v-if="showLinkForm" class="form-stack inline-form" @submit.prevent="attachLink">
          <SelectField v-if="linkOptions.length" v-model="linkChoice" :label="t('taskLinkSelect')">
            <option value="">{{ t("taskLinkPick") }}</option>
            <option
              v-for="option in linkOptions"
              :key="linkOptionKey(option)"
              :value="linkOptionKey(option)"
              >{{ option.kind === "issue" ? "Issue" : "PR" }} #{{ option.number }}
              {{ option.title }}</option
            >
          </SelectField>
          <p v-else class="muted">{{ t("taskLinkNothing") }}</p>
          <NoticeBar v-if="linkError" intent="error">{{ linkError }}</NoticeBar>
          <div v-if="linkOptions.length" class="form-actions">
            <fluent-button type="submit" appearance="primary" :disabled="saving || !linkChoice">{{
              t("taskLinkAttach")
            }}</fluent-button>
          </div>
        </form>
        <ul v-if="task.links.length" class="plain-list">
          <li v-for="link in task.links" :key="`${link.kind}:${link.number}`">
            <AppIcon :name="link.kind === 'issue' ? 'issue' : 'pr'" />
            <AppLink :to="linkPath(link)">#{{ link.number }} {{ link.title }}</AppLink>
            <StatusBadge :tone="linkTone(link.state)">{{ t(link.state) }}</StatusBadge>
            <fluent-button
              v-if="canEdit"
              type="button"
              size="small"
              appearance="transparent"
              :disabled="saving"
              :aria-label="t('taskLinkDetachLabel', { number: link.number })"
              @click="detach(link)"
              >{{ t("taskLinkDetach") }}</fluent-button
            >
          </li>
        </ul>
        <p v-else class="muted">{{ t("taskLinksEmpty") }}</p>
      </section>

      <section class="box box-form commits-card" :aria-label="t('taskCommits')">
        <div class="section-head">
          <h3>{{ t("taskCommits") }}</h3>
          <fluent-button
            v-if="canEdit"
            type="button"
            size="small"
            :aria-expanded="showCommitForm"
            @click="showCommitForm = !showCommitForm"
            ><AppIcon slot="start" name="plus" />{{ t("taskCommitBind") }}</fluent-button
          >
        </div>
        <form
          v-if="showCommitForm"
          class="form-stack inline-form commit-form"
          @submit.prevent="bindCommit"
        >
          <TextField v-model="commitForm.oid" required>{{ t("commitOid") }}</TextField>
          <TextField v-model="commitForm.ref" required>{{ t("taskCommitRef") }}</TextField>
          <NoticeBar v-if="commitError" intent="error">{{ commitError }}</NoticeBar>
          <div class="form-actions">
            <fluent-button type="submit" appearance="primary" :disabled="saving">{{
              t("taskCommitBind")
            }}</fluent-button>
          </div>
        </form>
        <ul v-if="task.commits.length" class="plain-list commit-list">
          <li v-for="commit in task.commits" :key="commit.oid">
            <RouterLink
              class="commit-oid"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: commit.ref, oid: commit.oid },
              }"
              ><code>{{ commit.oid.slice(0, 8) }}</code></RouterLink
            >
            <span class="commit-summary">{{ commit.summary }}</span>
            <StatusBadge :tone="commit.source === 'pull_request_merge' ? 'brand' : 'neutral'">{{
              t(`taskCommitSource_${commit.source}`)
            }}</StatusBadge>
            <small class="muted commit-meta"
              >{{ commit.author }} · {{ commit.ref }} ·
              {{ t("taskCommitBoundBy", { name: revisionActorLabel(commit.boundBy, t) }) }} ·
              {{ new Date(commit.boundAt).toLocaleString() }}</small
            >
            <fluent-button
              v-if="canEdit"
              type="button"
              size="small"
              appearance="transparent"
              :disabled="saving"
              :aria-label="t('taskCommitUnbindLabel', { oid: commit.oid.slice(0, 8) })"
              @click="unbind(commit.oid)"
              >{{ t("taskCommitUnbind") }}</fluent-button
            >
          </li>
        </ul>
        <p v-else class="muted">{{ t("taskCommitsEmpty") }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.task-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--spacingVerticalL);
}
.task-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacingHorizontalL);
}
.task-heading h2 {
  margin: 0;
  font-size: var(--fontSizeHero700);
  line-height: var(--lineHeightHero700);
  overflow-wrap: anywhere;
}
.task-card {
  display: grid;
  gap: var(--spacingVerticalL);
}
.task-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--spacingHorizontalL);
}
.task-readonly {
  display: grid;
  gap: var(--spacingVerticalXS);
  align-content: start;
}
.task-readonly .eyebrow,
.task-overview .eyebrow,
.task-progress-block .eyebrow {
  margin-bottom: var(--spacingVerticalXS);
}
.actor-line {
  color: var(--colorNeutralForeground3);
  font-size: var(--fontSizeBase200);
}
.task-overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: var(--spacingVerticalL) var(--spacingHorizontalXL);
}
.body-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.task-progress {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalM);
  font-size: var(--fontSizeBase200);
}
.bar {
  width: min(320px, 60%);
  height: 8px;
  flex: none;
  appearance: none;
  border: 0;
  border-radius: var(--borderRadiusCircular);
  background: var(--colorNeutralStroke2);
  overflow: hidden;
}
.bar::-webkit-progress-bar {
  background: var(--colorNeutralStroke2);
}
.bar::-webkit-progress-value {
  background: var(--colorBrandBackground);
}
.bar::-moz-progress-bar {
  background: var(--colorBrandBackground);
}
.doc-tabs {
  display: flex;
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
  margin-bottom: var(--spacingVerticalL);
  border-bottom: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
}
.doc-tab {
  flex: none;
  padding: 10px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--muted, var(--colorNeutralForeground3));
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.doc-tab[aria-selected="true"] {
  border-bottom-color: var(--accent, var(--colorBrandBackground));
  color: var(--text, var(--colorNeutralForeground1));
  font-weight: 600;
}
.doc-tab:focus-visible {
  outline: 2px solid var(--link, var(--colorBrandForegroundLink));
  outline-offset: -2px;
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacingHorizontalM);
  margin-bottom: var(--spacingVerticalM);
}
.section-head h3 {
  margin: 0;
}
.plain-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.plain-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalM);
  min-height: 44px;
  padding: var(--spacingVerticalXS) 0;
  border-bottom: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
}
.plain-list li:last-child {
  border-bottom: 0;
}
.plain-list li fluent-button {
  margin-left: auto;
}
.commit-oid code {
  color: var(--colorBrandForegroundLink);
  font-size: var(--fontSizeBase200);
}
.commit-summary {
  min-width: 0;
  flex: 1 1 200px;
  overflow-wrap: anywhere;
}
.commit-meta {
  flex-basis: 100%;
  order: 5;
}
.inline-form {
  margin-bottom: var(--spacingVerticalL);
}
@media (max-width: 640px) {
  .task-heading {
    flex-direction: column;
  }
  .task-heading h2 {
    font-size: var(--fontSizeBase600);
    line-height: var(--lineHeightBase600);
  }
  .bar {
    width: 100%;
    flex: 1;
  }
}
</style>
