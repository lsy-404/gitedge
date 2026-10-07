<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AssigneeCandidate,
  AssigneeRef,
  AssignmentRole,
  Issue,
  PullRequest,
  Repository,
  Task,
  TaskLinkKind,
  TaskReference,
} from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { sessionState } from "../lib/session";
import AppLink from "./AppLink.vue";
import AssigneeSetEditor from "./AssigneeSetEditor.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";

/** Assignees, reviewers and the owning task of one issue or pull request. */
const props = defineProps<{
  repository: Repository;
  kind: TaskLinkKind;
  item: Issue | PullRequest;
}>();
const emit = defineEmits<{ updated: [item: Issue | PullRequest] }>();

const { t } = useI18n();
const candidates = ref<AssigneeCandidate[]>([]);
const tasks = ref<Task[]>([]);
const currentTask = ref<TaskReference | null>(null);
const saving = ref(false);
const error = ref("");
const canEdit = computed(() => Boolean(sessionState.user) && props.repository.canWrite);
const taskOptions = computed(() =>
  tasks.value.filter(
    (task) => task.status !== "abandoned" || task.number === currentTask.value?.number
  )
);
const titleLimit = 40;
let loadVersion = 0;

function truncate(title: string): string {
  return title.length > titleLimit ? `${title.slice(0, titleLimit - 1)}…` : title;
}

async function loadTasks(version: number) {
  try {
    const [list, owner] = await Promise.all([
      api.tasks(props.repository.id),
      api.itemTask(props.repository.id, props.kind, props.item.number),
    ]);
    if (version !== loadVersion) return;
    tasks.value = list;
    currentTask.value = owner;
  } catch {
    if (version !== loadVersion) return;
    tasks.value = [];
    currentTask.value = null;
  }
}

async function load() {
  const version = ++loadVersion;
  error.value = "";
  if (!canEdit.value) {
    candidates.value = [];
    tasks.value = [];
    currentTask.value = null;
    return;
  }
  const [people] = await Promise.all([
    api.assigneeCandidates(props.repository.id).catch(() => []),
    loadTasks(version),
  ]);
  if (version === loadVersion) candidates.value = people;
}

async function setRole(role: AssignmentRole, assignees: AssigneeRef[]) {
  saving.value = true;
  error.value = "";
  try {
    const payload = { role, assignees };
    const updated =
      props.kind === "issue"
        ? await api.setIssueAssignees(props.repository.id, props.item.number, payload)
        : await api.setPullAssignees(props.repository.id, props.item.number, payload);
    emit("updated", updated);
  } catch (cause) {
    error.value = errorMessage(cause, t, { 400: "assignInvalid", 403: "assignPolicyDenied" });
  } finally {
    saving.value = false;
  }
}

/** Moves the item between tasks in one server operation; an item belongs to at most one task. */
async function moveToTask(value: string) {
  const target = value ? Number(value) : null;
  if ((currentTask.value?.number ?? null) === target) return;
  saving.value = true;
  error.value = "";
  try {
    currentTask.value = await api.moveItemTask(
      props.repository.id,
      props.kind,
      props.item.number,
      target
    );
  } catch (cause) {
    error.value = errorMessage(cause, t);
    await loadTasks(loadVersion);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
watch(() => [props.repository.id, props.item.number, canEdit.value], load);
</script>

<template>
  <section class="assignment-panel" :aria-label="t('assignments')">
    <div class="assignment-grid">
      <AssigneeSetEditor
        :label="t('assignees')"
        :add-label="t('assigneeAdd')"
        :empty-text="t('assigneeNone')"
        :assignees="item.assignees"
        :candidates="candidates"
        :can-edit="canEdit"
        :saving="saving"
        @change="setRole('assignee', $event)"
      />
      <AssigneeSetEditor
        :label="t('reviewers')"
        :add-label="t('reviewerAdd')"
        :empty-text="t('reviewerNone')"
        :assignees="item.reviewers"
        :candidates="candidates"
        :can-edit="canEdit"
        :saving="saving"
        @change="setRole('reviewer', $event)"
      />
      <div v-if="currentTask || (canEdit && tasks.length)" class="task-select">
        <p class="eyebrow">{{ t("taskSelectLabel") }}</p>
        <AppLink
          v-if="currentTask"
          class="task-current"
          :to="`/${repository.owner}/${repository.name}/tasks/${currentTask.number}`"
          >#{{ currentTask.number }} {{ currentTask.title }}</AppLink
        >
        <p v-else class="muted task-current">{{ t("taskSelectNone") }}</p>
        <SelectField
          v-if="canEdit && tasks.length"
          :model-value="currentTask ? String(currentTask.number) : ''"
          :label="t('taskSelectChange')"
          :disabled="saving"
          @update:model-value="moveToTask"
        >
          <option value="">{{ t("taskSelectNone") }}</option>
          <option
            v-for="task in taskOptions"
            :key="task.number"
            :value="String(task.number)"
            :title="task.title"
          >
            #{{ task.number }} [{{ task.type }}] {{ truncate(task.title) }}
          </option>
        </SelectField>
      </div>
    </div>
    <p v-if="canEdit" class="muted agent-note">{{ t("agentReviewNote") }}</p>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  </section>
</template>

<style scoped>
.assignment-panel {
  display: grid;
  gap: var(--space-3);
}
.assignment-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
}
.assignment-grid > * + * {
  padding-top: var(--space-4);
  border-top: 1px solid var(--border-default);
}
.task-select {
  display: grid;
  gap: var(--space-2);
  align-content: start;
  min-width: 0;
}
.task-select .eyebrow {
  margin: 0;
}
.task-current {
  min-height: var(--control-height);
  overflow-wrap: anywhere;
  font-weight: var(--font-weight-semibold);
}
p.task-current {
  font-weight: var(--font-weight-regular);
  font-size: var(--font-size-meta);
}
.agent-note {
  font-size: var(--font-size-meta);
}
</style>
