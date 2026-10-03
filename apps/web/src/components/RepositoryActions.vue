<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { ActionRun, ActionRunSummary, ActionWorkflowFile, GitRef } from "../lib/api";
import { api } from "../lib/api";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    repositoryId: string;
    defaultBranch: string;
    canWrite?: boolean;
    archived?: boolean;
    actionsNetworkEnabled?: boolean;
  }>(),
  { canWrite: false, archived: false }
);

const { t } = useI18n();
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const runError = ref("");
const workflows = ref<ActionWorkflowFile[]>([]);
const refs = ref<GitRef[]>([]);
const workflowOid = ref("");
const selectedRef = ref("");
const selectedWorkflowPath = ref("");
const runs = ref<ActionRunSummary[]>([]);
const selectedRun = ref<ActionRun | null>(null);
const selectedRunId = ref("");
let pollingTimer: number | undefined;
let pollPending = false;

const branchRefs = computed(() => refs.value.filter((item) => !item.name.startsWith("refs/tags/")));
const chosenWorkflow = computed(
  () => workflows.value.find((workflow) => workflow.path === selectedWorkflowPath.value) ?? null
);
const activeRuns = computed(() => runs.value.some((run) => run.status !== "completed"));
const selectedRunActive = computed(
  () => selectedRun.value?.status === "queued" || selectedRun.value?.status === "running"
);
const canDispatch = computed(() => {
  const workflow = chosenWorkflow.value;
  return Boolean(
    props.canWrite &&
    !props.archived &&
    workflowOid.value &&
    workflow?.supported === true &&
    workflow.triggers.includes("workflow_dispatch")
  );
});

function refLabel(name: string): string {
  return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
}

function statusTone(
  run: Pick<ActionRunSummary, "status" | "conclusion">
): "neutral" | "success" | "danger" | "brand" {
  if (run.status !== "completed") return run.status === "running" ? "brand" : "neutral";
  return run.conclusion === "success"
    ? "success"
    : run.conclusion === "failure"
      ? "danger"
      : "neutral";
}

function statusText(run: Pick<ActionRunSummary, "status" | "conclusion">): string {
  if (run.status !== "completed") return t(`actionsStatus_${run.status}`);
  return run.conclusion ? t(`actionsConclusion_${run.conclusion}`) : t("actionsConclusionPending");
}

async function loadRefs(): Promise<void> {
  refs.value = await api.refs(props.repositoryId);
  const available = branchRefs.value;
  if (!available.some((item) => item.name === selectedRef.value)) {
    const preferred = available.find((item) => refLabel(item.name) === props.defaultBranch);
    selectedRef.value = preferred?.name ?? available[0]?.name ?? "";
  }
}

async function loadWorkflows(): Promise<void> {
  workflows.value = [];
  workflowOid.value = "";
  selectedWorkflowPath.value = "";
  if (!selectedRef.value) return;
  const result = await api.actionWorkflows(props.repositoryId, selectedRef.value);
  workflows.value = result.workflows;
  workflowOid.value = result.oid;
  selectedWorkflowPath.value = result.workflows[0]?.path ?? "";
}

async function loadRuns(): Promise<void> {
  runs.value = await api.actionRuns(props.repositoryId);
  if (!selectedRunId.value && runs.value[0]) selectedRunId.value = runs.value[0].id;
  if (selectedRunId.value) {
    const exists = runs.value.some((run) => run.id === selectedRunId.value);
    if (exists) selectedRun.value = await api.actionRun(selectedRunId.value);
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    await Promise.all([loadRefs(), loadRuns()]);
    await loadWorkflows();
  } catch {
    error.value = t("actionsLoadError");
  } finally {
    loading.value = false;
  }
}

async function refreshRuns(): Promise<void> {
  if (pollPending) return;
  pollPending = true;
  try {
    await loadRuns();
  } catch {
    error.value = t("actionsLoadError");
  } finally {
    pollPending = false;
  }
}

async function startRun(): Promise<void> {
  if (
    !chosenWorkflow.value ||
    !workflowOid.value ||
    !selectedRef.value ||
    !props.canWrite ||
    props.archived
  )
    return;
  saving.value = true;
  runError.value = "";
  try {
    const run = await api.startActionRun(props.repositoryId, {
      workflowPath: chosenWorkflow.value.path,
      ref: selectedRef.value,
      expectedOid: workflowOid.value,
    });
    selectedRunId.value = run.id;
    runs.value = [run, ...runs.value.filter((item) => item.id !== run.id)];
    selectedRun.value = await api.actionRun(run.id);
  } catch {
    runError.value = t("actionsRunError");
  } finally {
    saving.value = false;
  }
}

async function openRun(runId: string): Promise<void> {
  selectedRunId.value = runId;
  selectedRun.value = null;
  try {
    selectedRun.value = await api.actionRun(runId);
  } catch {
    error.value = t("actionsLoadError");
  }
}

async function cancelRun(): Promise<void> {
  if (!selectedRun.value) return;
  runError.value = "";
  try {
    selectedRun.value = await api.cancelActionRun(selectedRun.value.id);
    await refreshRuns();
  } catch {
    runError.value = t("actionsCancelError");
  }
}

watch(selectedRef, async (next, previous) => {
  if (!next || next === previous || loading.value) return;
  try {
    await loadWorkflows();
  } catch {
    workflows.value = [];
    error.value = t("actionsLoadError");
  }
});

onMounted(() => {
  void load();
  pollingTimer = window.setInterval(() => {
    if (activeRuns.value && !pollPending) void refreshRuns();
  }, 2500);
});

onUnmounted(() => clearInterval(pollingTimer));
</script>

<template>
  <section class="repository-actions" aria-labelledby="actions-title">
    <header class="actions-heading">
      <div>
        <h2 id="actions-title">{{ t("actionsTitle") }}</h2>
        <p>{{ t("actionsIntro") }}</p>
      </div>
      <FluentButton type="button" :disabled="loading" @click="load">{{
        t("actionsRefresh")
      }}</FluentButton>
    </header>

    <StatusState v-if="loading && !runs.length" :loading="true" error="" @retry="load" />
    <StatusState v-else-if="error && !runs.length" :loading="false" :error="error" @retry="load" />

    <div v-else class="actions-layout">
      <p v-if="actionsNetworkEnabled === false" class="actions-warning actions-network-notice">
        {{ t("actionsNetworkDisabled") }}
      </p>
      <section class="actions-panel" aria-label="Workflows">
        <div class="actions-toolbar">
          <SelectField
            v-model="selectedRef"
            :label="t('actionsRef')"
            :disabled="loading || !branchRefs.length"
          >
            <option value="" disabled>{{ t("actionsNoBranches") }}</option>
            <option v-for="item in branchRefs" :key="item.name" :value="item.name">
              {{ refLabel(item.name) }}
            </option>
          </SelectField>
          <SelectField
            v-model="selectedWorkflowPath"
            :label="t('actionsWorkflow')"
            :disabled="loading || !workflows.length"
          >
            <option value="" disabled>{{ t("actionsChooseWorkflow") }}</option>
            <option v-for="workflow in workflows" :key="workflow.path" :value="workflow.path">
              {{ workflow.name }}
            </option>
          </SelectField>
          <FluentButton
            type="button"
            tone="primary"
            :disabled="saving || loading || !canDispatch"
            @click="startRun"
            >{{ saving ? t("loading") : t("actionsDispatch") }}</FluentButton
          >
        </div>
        <p v-if="!branchRefs.length" class="actions-empty">{{ t("actionsNoBranches") }}</p>
        <p v-else-if="!workflows.length && !loading" class="actions-empty">
          {{ t("actionsNoWorkflows") }}
        </p>
        <p v-if="chosenWorkflow && !chosenWorkflow.supported" class="actions-warning">
          {{ t("actionsUnsupported", { reason: chosenWorkflow.unsupportedReason }) }}
        </p>
        <p
          v-else-if="chosenWorkflow && !chosenWorkflow.triggers.includes('workflow_dispatch')"
          class="actions-muted"
        >
          {{ t("actionsPushOnly") }}
        </p>
        <p v-if="runError" class="actions-error" role="alert">{{ runError }}</p>
        <p v-if="workflowOid" class="actions-oid">
          {{ t("actionsCommit") }} <code>{{ workflowOid }}</code>
        </p>
      </section>

      <section class="actions-panel" :aria-label="t('actionsRuns')">
        <div class="actions-section-heading">
          <h3>{{ t("actionsRuns") }}</h3>
          <FluentButton type="button" :disabled="pollPending" @click="refreshRuns">{{
            t("actionsRefresh")
          }}</FluentButton>
        </div>
        <p v-if="!runs.length" class="actions-empty">{{ t("actionsNoRuns") }}</p>
        <ol v-else class="actions-run-list">
          <li v-for="run in runs" :key="run.id">
            <button
              class="actions-run-button"
              type="button"
              :aria-current="selectedRunId === run.id ? 'true' : undefined"
              @click="openRun(run.id)"
            >
              <span class="actions-run-name">{{ run.workflowName }}</span>
              <span class="actions-run-ref"
                >{{ refLabel(run.ref) }} · {{ run.commitOid.slice(0, 8) }}</span
              >
              <StatusBadge :tone="statusTone(run)">{{ statusText(run) }}</StatusBadge>
            </button>
          </li>
        </ol>
      </section>

      <section
        v-if="selectedRun"
        class="actions-panel actions-run-detail"
        :aria-label="t('actionsLogs')"
      >
        <div class="actions-section-heading">
          <div>
            <h3>{{ selectedRun.workflowName }}</h3>
            <code>{{ selectedRun.commitOid }}</code>
          </div>
          <FluentButton
            v-if="canWrite && selectedRunActive"
            type="button"
            tone="secondary"
            @click="cancelRun"
            >{{ t("actionsCancel") }}</FluentButton
          >
        </div>
        <div v-for="job in selectedRun.jobs" :key="job.id" class="actions-job">
          <h4>{{ job.name }}</h4>
          <article v-for="step in job.steps" :key="step.name" class="actions-step">
            <header>
              <strong>{{ step.name }}</strong>
              <StatusBadge :tone="statusTone({ status: step.status, conclusion: step.conclusion })">
                {{
                  step.conclusion
                    ? t(`actionsConclusion_${step.conclusion}`)
                    : t(`actionsStatus_${step.status}`)
                }}
              </StatusBadge>
            </header>
            <pre>{{ step.log || t("actionsNoLogs") }}</pre>
            <p v-if="step.outputTruncated" class="actions-warning">
              {{ t("actionsOutputTruncated") }}
            </p>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.repository-actions {
  display: grid;
  gap: 1rem;
  min-width: 0;
}
.actions-heading,
.actions-section-heading,
.actions-toolbar,
.actions-step > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.actions-heading h2,
.actions-section-heading h3,
.actions-job h4 {
  margin: 0;
}
.actions-heading p,
.actions-muted,
.actions-oid,
.actions-empty {
  color: var(--colorNeutralForeground2, #656d76);
}
.actions-layout {
  display: grid;
  gap: 1rem;
  grid-template-columns: minmax(16rem, 0.85fr) minmax(18rem, 1fr);
  align-items: start;
}
.actions-network-notice {
  grid-column: 1 / -1;
}
.actions-panel {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--border, #d1d9e0);
  border-radius: var(--borderRadiusMedium, 0.5rem);
  background: var(--surface, var(--colorNeutralBackground1, #fff));
}
.actions-toolbar {
  align-items: end;
  flex-wrap: wrap;
}
.actions-toolbar > * {
  flex: 1 1 11rem;
}
.actions-empty,
.actions-muted,
.actions-warning,
.actions-error,
.actions-oid {
  margin: 0.75rem 0 0;
}
.actions-warning {
  color: var(--colorPaletteDarkOrangeForeground1, #9a6700);
}
.actions-error {
  color: var(--colorPaletteRedForeground1, #cf222e);
}
.actions-oid code,
.actions-section-heading code {
  overflow-wrap: anywhere;
}
.actions-run-list {
  display: grid;
  gap: 0.375rem;
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
}
.actions-run-button {
  display: grid;
  width: 100%;
  gap: 0.2rem;
  padding: 0.65rem;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 0.4rem;
  cursor: pointer;
}
.actions-run-button:hover,
.actions-run-button[aria-current="true"] {
  background: var(--colorNeutralBackground2, #f6f8fa);
  border-color: var(--border, #d1d9e0);
}
.actions-run-name {
  font-weight: 600;
}
.actions-run-ref {
  font:
    0.8rem ui-monospace,
    monospace;
  color: var(--colorNeutralForeground2, #656d76);
  overflow-wrap: anywhere;
}
.actions-run-button :deep(.badge) {
  justify-self: start;
}
.actions-run-detail {
  grid-column: 1 / -1;
  display: grid;
  gap: 1rem;
}
.actions-job {
  display: grid;
  gap: 0.65rem;
}
.actions-step {
  min-width: 0;
  padding-top: 0.65rem;
  border-top: 1px solid var(--border, #d1d9e0);
}
.actions-step > header {
  justify-content: flex-start;
}
.actions-step pre {
  max-height: 22rem;
  overflow: auto;
  margin: 0.5rem 0 0;
  padding: 0.75rem;
  color: var(--colorNeutralForeground1, #1f2328);
  background: var(--colorNeutralBackground3, #f6f8fa);
  border-radius: 0.35rem;
  font:
    0.82rem/1.5 ui-monospace,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .actions-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .actions-run-detail {
    grid-column: auto;
  }
  .actions-network-notice {
    grid-column: auto;
  }
  .actions-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .actions-toolbar > * {
    flex-basis: auto;
    width: 100%;
  }
}
</style>
