<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { MemoryIndex, Repository, Task, TaskStatus, TaskTable } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { sessionState } from "../lib/session";
import {
  errorMessage,
  taskStatusTone,
  taskStatuses,
  taskTypePattern,
  type DocumentView,
} from "../lib/tasks";
import { oneOf } from "../ui/formEvents";
import AppIcon from "./AppIcon.vue";
import MarkdownContent from "./MarkdownContent.vue";
import MarkdownDocument from "./MarkdownDocument.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import TaskDetailView from "./TaskDetailView.vue";
import TextAreaField from "./TextAreaField.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ repository: Repository }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

type FilterValue = TaskStatus | "all";
const filterValues = ["all", ...taskStatuses] as const satisfies readonly FilterValue[];

const tasks = ref<Task[]>([]);
const memory = ref<MemoryIndex | null>(null);
const table = ref<TaskTable | null>(null);
const filter = ref<FilterValue>("all");
const view = ref<"list" | "table">("list");
const loading = ref(true);
const listLoading = ref(false);
const error = ref("");
/** Set when the server hides tasks and memory from this viewer (403/404). */
const unavailable = ref(false);
const showForm = ref(false);
const form = ref({ type: "Feature", title: "", motivation: "", description: "" });
const formError = ref("");
const saving = ref(false);
const copied = ref(false);
let loadVersion = 0;
let listVersion = 0;

const detailNumber = computed(() => Number(route.params.number) || 0);
const canWrite = computed(() => Boolean(sessionState.user) && props.repository.canWrite);

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  unavailable.value = false;
  try {
    const [rows, index] = await Promise.all([
      api.tasks(props.repository.id, filter.value === "all" ? undefined : filter.value),
      api.memory(props.repository.id),
    ]);
    if (version !== loadVersion) return;
    tasks.value = rows;
    memory.value = index;
  } catch (cause) {
    if (version !== loadVersion) return;
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404))
      unavailable.value = true;
    else error.value = t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function loadTasks() {
  const version = ++listVersion;
  listLoading.value = true;
  error.value = "";
  try {
    const rows = await api.tasks(
      props.repository.id,
      filter.value === "all" ? undefined : filter.value
    );
    if (version === listVersion) tasks.value = rows;
  } catch (cause) {
    if (version === listVersion) error.value = errorMessage(cause, t);
  } finally {
    if (version === listVersion) listLoading.value = false;
  }
}

async function loadTable() {
  error.value = "";
  try {
    table.value = await api.taskTable(props.repository.id);
  } catch (cause) {
    error.value = errorMessage(cause, t);
  }
}

function setView(next: "list" | "table") {
  view.value = next;
  if (next === "table") void loadTable();
}

function setFilter(value: string) {
  const next = oneOf(filterValues, value, "all");
  if (next === filter.value) return;
  filter.value = next;
  void loadTasks();
}

function setMemory(document: DocumentView) {
  const current = memory.value;
  if (!current) return;
  memory.value = {
    ...current,
    content: document.content,
    revision: document.revision,
    actor: document.actor,
    updatedAt: document.updatedAt,
  };
}

/** The memory revision endpoints also report the guideline version of that revision. */
async function loadMemoryRevision(revision: number): Promise<MemoryIndex> {
  return api.memoryRevision(props.repository.id, revision);
}

async function saveMemory(content: string, expectedRevision: number): Promise<MemoryIndex> {
  const saved = await api.putMemory(props.repository.id, { content, expectedRevision });
  memory.value = saved;
  return saved;
}

async function reloadMemory(): Promise<MemoryIndex> {
  const latest = await api.memory(props.repository.id);
  memory.value = latest;
  return latest;
}

async function createTask() {
  formError.value = "";
  if (!taskTypePattern.test(form.value.type)) {
    formError.value = t("taskTypeInvalid");
    return;
  }
  saving.value = true;
  try {
    const created = await api.createTask(props.repository.id, {
      type: form.value.type,
      title: form.value.title.trim(),
      motivation: form.value.motivation,
      description: form.value.description,
    });
    showForm.value = false;
    form.value = { type: "Feature", title: "", motivation: "", description: "" };
    await router.push(
      `/${props.repository.owner}/${props.repository.name}/tasks/${created.number}`
    );
  } catch (cause) {
    formError.value = errorMessage(cause, t, { 400: "taskInvalid" });
  } finally {
    saving.value = false;
  }
}

async function copyTable() {
  if (!table.value) return;
  try {
    await navigator.clipboard.writeText(table.value.markdown);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

function progressPercent(task: Task): number {
  return task.progress.percent ?? 0;
}

watch(
  () => [props.repository.id, detailNumber.value === 0],
  () => {
    if (detailNumber.value === 0) void load();
  },
  { immediate: true }
);
</script>

<template>
  <TaskDetailView v-if="detailNumber" :repository="repository" :number="detailNumber" />
  <section v-else class="tasks-section">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <NoticeBar v-else-if="unavailable" intent="info">{{ t("tasksUnavailable") }}</NoticeBar>
    <template v-else>
      <div class="box memory-box">
        <MarkdownDocument
          v-if="memory"
          :title="t('memoryTitle')"
          :document="memory"
          :can-edit="canWrite"
          :empty-text="t('memoryEmpty')"
          :load-history="() => api.memoryHistory(repository.id)"
          :load-revision="loadMemoryRevision"
          :save="saveMemory"
          :reload="reloadMemory"
          @update="setMemory"
        >
          <template #meta>
            <StatusBadge tone="brand">{{
              t("guidelineVersion", { version: memory.guidelineVersion })
            }}</StatusBadge>
          </template>
        </MarkdownDocument>
      </div>

      <div class="tasks-toolbar">
        <div class="view-switch" role="group" :aria-label="t('taskViews')">
          <FluentButton
            type="button"
            :tone="view === 'list' ? 'primary' : 'secondary'"
            :aria-pressed="view === 'list'"
            @click="setView('list')"
            >{{ t("taskViewList") }}</FluentButton
          >
          <FluentButton
            type="button"
            :tone="view === 'table' ? 'primary' : 'secondary'"
            :aria-pressed="view === 'table'"
            @click="setView('table')"
            >{{ t("taskViewTable") }}</FluentButton
          >
        </div>
        <SelectField
          v-if="view === 'list'"
          class="status-filter"
          :model-value="filter"
          :label="t('taskStatusLabel')"
          @update:model-value="setFilter"
        >
          <option value="all">{{ t("taskStatusAll") }}</option>
          <option v-for="status in taskStatuses" :key="status" :value="status">
            {{ t(`taskStatus_${status}`) }}
          </option>
        </SelectField>
        <FluentButton
          v-if="canWrite"
          class="new-task"
          type="button"
          tone="primary"
          :aria-expanded="showForm"
          @click="showForm = !showForm"
        >
          <AppIcon name="plus" />{{ t("newTask") }}
        </FluentButton>
      </div>

      <form v-if="showForm" class="box box-form form-stack task-form" @submit.prevent="createTask">
        <TextField v-model="form.type" required>{{ t("taskType") }}</TextField>
        <p class="muted field-hint">{{ t("taskTypeHint") }}</p>
        <TextField v-model="form.title" required>{{ t("taskTitle") }}</TextField>
        <TextAreaField v-model="form.motivation" rows="3" :label="t('taskMotivation')" />
        <TextAreaField v-model="form.description" rows="4" :label="t('description')" />
        <NoticeBar v-if="formError" intent="error">{{ formError }}</NoticeBar>
        <div class="form-actions">
          <FluentButton type="button" @click="showForm = false">{{ t("cancel") }}</FluentButton>
          <FluentButton type="submit" tone="primary" :disabled="saving">{{
            saving ? t("loading") : t("create")
          }}</FluentButton>
        </div>
      </form>

      <div v-if="view === 'table'" class="box box-form table-view">
        <div class="table-head">
          <div>
            <p class="eyebrow">{{ t("taskViewTable") }}</p>
            <p class="muted">{{ t("taskTableHint") }}</p>
          </div>
          <FluentButton v-if="table" type="button" size="small" @click="copyTable">
            <AppIcon name="copy" />{{ copied ? t("copied") : t("copyMarkdown") }}
          </FluentButton>
        </div>
        <p v-if="!table" class="state" role="status">{{ t("loading") }}</p>
        <MarkdownContent v-else :source="table.markdown" />
      </div>
      <div v-else class="box" :aria-busy="listLoading">
        <RouterLink
          v-for="task in tasks"
          :key="task.number"
          class="box-row item-link task-row"
          :to="`/${repository.owner}/${repository.name}/tasks/${task.number}`"
        >
          <AppIcon class="state-icon" name="target" :size="18" />
          <div class="grow">
            <div class="row-title">
              <span class="number">#{{ task.number }}</span>
              <span class="task-title">[{{ task.type }}] {{ task.title }}</span>
              <StatusBadge :tone="taskStatusTone(task.status)">{{
                t(`taskStatus_${task.status}`)
              }}</StatusBadge>
            </div>
            <div class="task-progress">
              <progress
                class="bar"
                max="100"
                :value="progressPercent(task)"
                :aria-label="t('taskProgress')"
              ></progress>
              <span v-if="task.progress.total" class="muted">{{
                t("taskProgressCount", { done: task.progress.done, total: task.progress.total })
              }}</span>
              <span v-else class="muted">{{ t("taskNoLinks") }}</span>
            </div>
            <div class="row-meta">
              <span v-if="task.assignee"
                >{{ task.assignee.name
                }}<template v-if="task.assignee.kind === 'agent'">
                  · {{ t("agent") }}</template
                ></span
              >
              <span v-else>{{ t("taskUnassigned") }}</span>
              <span>{{ t("taskCommitsCount", { count: task.commitCount }) }}</span>
              <span>{{
                t("updatedOn", { date: new Date(task.updatedAt).toLocaleDateString() })
              }}</span>
            </div>
          </div>
        </RouterLink>
        <p v-if="!tasks.length" class="state">
          {{ filter === "all" ? t("tasksEmpty") : t("tasksEmptyFiltered") }}
        </p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.tasks-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--spacingVerticalL);
}
.memory-box {
  padding: var(--spacingVerticalL);
}
.tasks-toolbar {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalM);
}
.view-switch {
  display: flex;
  gap: var(--spacingHorizontalXS);
}
.status-filter {
  width: 220px;
}
.new-task {
  margin-left: auto;
}
.field-hint {
  margin-top: calc(var(--spacingVerticalS) * -1);
  font-size: var(--fontSizeBase200);
}
.item-link {
  color: inherit;
}
.item-link:hover {
  text-decoration: none;
}
.item-link:hover .task-title {
  color: var(--colorBrandForegroundLink);
}
.number {
  color: var(--colorNeutralForeground3);
  font-family: var(--fontFamilyMonospace);
  font-size: var(--fontSizeBase200);
}
.task-progress {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalM);
  margin-top: var(--spacingVerticalS);
  font-size: var(--fontSizeBase200);
}
.bar {
  width: min(240px, 40%);
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
.table-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacingHorizontalL);
  margin-bottom: var(--spacingVerticalL);
}
.table-head .eyebrow {
  margin-bottom: var(--spacingVerticalXXS);
}
@media (max-width: 640px) {
  .status-filter {
    width: 100%;
  }
  .new-task {
    margin-left: 0;
  }
  .bar {
    width: 100%;
    flex: 1;
  }
  .task-progress {
    flex-wrap: wrap;
  }
}
</style>
