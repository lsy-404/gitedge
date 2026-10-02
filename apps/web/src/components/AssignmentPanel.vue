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
} from "../lib/api";
import { api } from "../lib/api";
import { sessionState } from "../lib/session";
import { errorMessage } from "../lib/tasks";
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
const currentTask = ref<Task | null>(null);
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

/**
 * Issues and pull requests do not carry their task, so the owner is found through the task
 * details that have linked items.
 */
async function loadTasks(version: number) {
  try {
    const list = await api.tasks(props.repository.id);
    const linked = list.filter((task) => task.progress.total > 0);
    const details = await Promise.all(
      linked.map((task) => api.task(props.repository.id, task.number))
    );
    if (version !== loadVersion) return;
    tasks.value = list;
    const owner = details.find((detail) =>
      detail.links.some((link) => link.kind === props.kind && link.number === props.item.number)
    );
    currentTask.value = owner ? (list.find((task) => task.number === owner.number) ?? null) : null;
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

/** Moves the item between tasks. An item belongs to at most one task, so it is unlinked first. */
async function moveToTask(value: string) {
  const target = value ? Number(value) : null;
  const previous = currentTask.value;
  if ((previous?.number ?? null) === target) return;
  saving.value = true;
  error.value = "";
  try {
    if (previous)
      await api.detachTaskLink(props.repository.id, previous.number, props.kind, props.item.number);
    currentTask.value = null;
    if (target !== null) {
      try {
        await api.attachTaskLink(props.repository.id, target, {
          kind: props.kind,
          number: props.item.number,
        });
      } catch (cause) {
        if (previous)
          await api
            .attachTaskLink(props.repository.id, previous.number, {
              kind: props.kind,
              number: props.item.number,
            })
            .catch(() => undefined);
        throw cause;
      }
    }
    await loadTasks(loadVersion);
  } catch (cause) {
    error.value = errorMessage(cause, t, { 409: "taskLinkConflict" });
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
          <fluent-option value="">{{ t("taskSelectNone") }}</fluent-option>
          <fluent-option
            v-for="task in taskOptions"
            :key="task.number"
            :value="String(task.number)"
            :title="task.title"
            >#{{ task.number }} [{{ task.type }}] {{ truncate(task.title) }}</fluent-option
          >
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
  gap: var(--spacingVerticalM);
  margin-top: var(--spacingVerticalL);
  padding-top: var(--spacingVerticalL);
  border-top: var(--strokeWidthThin) solid var(--colorNeutralStroke2);
}
.assignment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--spacingVerticalL) var(--spacingHorizontalXL);
}
.task-select {
  display: grid;
  gap: var(--spacingVerticalS);
  align-content: start;
  min-width: 0;
}
.task-select .eyebrow {
  margin: 0;
}
.task-current {
  min-height: 32px;
  overflow-wrap: anywhere;
  font-weight: var(--fontWeightSemibold);
}
p.task-current {
  font-weight: var(--fontWeightRegular);
  font-size: var(--fontSizeBase200);
}
.agent-note {
  font-size: var(--fontSizeBase200);
}
</style>
