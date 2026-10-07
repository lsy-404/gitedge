<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { ActionRun, ActionRunSummary, ActionWorkflowFile, GitRef } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
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
const workflowLoading = ref(false);
const saving = ref(false);
const cancelling = ref(false);
const error = ref("");
const runError = ref("");
let pollOwnsError = false;
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
let workflowEpoch = 0;

const selectableRefs = computed(() =>
  refs.value.filter(
    (item) => item.name.startsWith("refs/heads/") || item.name.startsWith("refs/tags/")
  )
);
const branchRefs = computed(() =>
  selectableRefs.value.filter((item) => item.name.startsWith("refs/heads/"))
);
const tagRefs = computed(() =>
  selectableRefs.value.filter((item) => item.name.startsWith("refs/tags/"))
);
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
    !workflowLoading.value &&
    workflowOid.value &&
    workflow?.supported === true &&
    workflow.triggers.includes("workflow_dispatch")
  );
});

function refLabel(name: string): string {
  return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
}

function selectionRef(name: string): string {
  return name.startsWith("refs/heads/") ? refLabel(name) : name;
}

function sourceRef(value: string): string {
  return value.startsWith("refs/tags/") ? value : `refs/heads/${value}`;
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
  const available = selectableRefs.value;
  if (!available.some((item) => selectionRef(item.name) === selectedRef.value)) {
    const preferred = available.find((item) => refLabel(item.name) === props.defaultBranch);
    selectedRef.value = preferred
      ? selectionRef(preferred.name)
      : selectionRef(available[0]?.name ?? "");
  }
}

async function loadWorkflows(): Promise<void> {
  const epoch = ++workflowEpoch;
  const selected = selectedRef.value;
  const selectedSource = refs.value.find((item) => item.name === sourceRef(selected));
  const oid = selectedSource?.peeledOid ?? selectedSource?.oid;
  workflows.value = [];
  workflowOid.value = "";
  selectedWorkflowPath.value = "";
  if (!selected || !oid) {
    workflowLoading.value = false;
    return;
  }
  workflowLoading.value = true;
  error.value = "";
  pollOwnsError = false;
  try {
    const result = await api.actionWorkflows(props.repositoryId, selected, oid);
    if (epoch !== workflowEpoch || selected !== selectedRef.value) return;
    workflows.value = result.workflows;
    workflowOid.value = result.oid;
    selectedWorkflowPath.value = result.workflows[0]?.path ?? "";
  } catch {
    if (epoch === workflowEpoch && selected === selectedRef.value) {
      error.value = t("actionsLoadError");
    }
  } finally {
    if (epoch === workflowEpoch) workflowLoading.value = false;
  }
}

async function loadRuns(): Promise<void> {
  runs.value = await api.actionRuns(props.repositoryId);
  if (!selectedRunId.value && runs.value[0]) selectedRunId.value = runs.value[0].id;
  const runId = selectedRunId.value;
  if (runId && runs.value.some((run) => run.id === runId)) {
    const detail = await api.actionRun(runId);
    if (runId === selectedRunId.value) selectedRun.value = detail;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  pollOwnsError = false;
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
    if (pollOwnsError) {
      error.value = "";
      pollOwnsError = false;
    }
  } catch {
    error.value = t("actionsLoadError");
    pollOwnsError = true;
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
    const detail = await api.actionRun(run.id);
    if (run.id === selectedRunId.value) selectedRun.value = detail;
  } catch (cause) {
    runError.value =
      cause instanceof ApiError && cause.status === 429 && cause.code === "run_limit"
        ? t("actionsRunLimit")
        : errorMessage(cause, t, {}, "actionsRunError");
  } finally {
    saving.value = false;
  }
}

async function openRun(runId: string): Promise<void> {
  selectedRunId.value = runId;
  selectedRun.value = null;
  try {
    const detail = await api.actionRun(runId);
    if (runId === selectedRunId.value) selectedRun.value = detail;
  } catch {
    if (runId === selectedRunId.value) {
      error.value = t("actionsLoadError");
      pollOwnsError = false;
    }
  }
}

async function cancelRun(): Promise<void> {
  if (!selectedRun.value || cancelling.value) return;
  const runId = selectedRun.value.id;
  cancelling.value = true;
  runError.value = "";
  try {
    const cancelled = await api.cancelActionRun(runId);
    if (runId === selectedRunId.value) selectedRun.value = cancelled;
    await refreshRuns();
  } catch {
    runError.value = t("actionsCancelError");
  } finally {
    cancelling.value = false;
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
    if (activeRuns.value && !pollPending && !document.hidden) void refreshRuns();
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
        <details class="actions-syntax">
          <summary>{{ t("actionsSyntaxTitle") }}</summary>
          <ul>
            <li>{{ t("actionsSyntaxTriggers") }}</li>
            <li>{{ t("actionsSyntaxSteps") }}</li>
            <li>{{ t("actionsSyntaxLimits") }}</li>
          </ul>
        </details>
      </div>
      <FluentButton type="button" :disabled="loading" @click="load">{{
        t("actionsRefresh")
      }}</FluentButton>
    </header>

    <StatusState v-if="loading && !runs.length" :loading="true" error="" @retry="load" />
    <StatusState v-else-if="error && !runs.length" :loading="false" :error="error" @retry="load" />

    <div v-else class="actions-layout">
      <div v-if="error" class="actions-load-error" role="alert">
        <p>{{ error }}</p>
        <FluentButton type="button" @click="load">{{ t("actionsRefresh") }}</FluentButton>
      </div>
      <p v-if="actionsNetworkEnabled === false" class="actions-warning actions-network-notice">
        {{ t("actionsNetworkDisabled") }}
      </p>
      <section class="box actions-panel" :aria-label="t('actionsWorkflows')">
        <header class="box-header">
          <h3>{{ t("actionsWorkflows") }}</h3>
        </header>
        <div class="actions-panel-body">
          <div class="actions-toolbar">
            <SelectField
              v-model="selectedRef"
              :label="t('actionsRef')"
              :disabled="loading || !selectableRefs.length"
            >
              <option value="" disabled>{{ t("actionsNoBranches") }}</option>
              <option v-for="item in branchRefs" :key="item.name" :value="selectionRef(item.name)">
                {{ refLabel(item.name) }}
              </option>
              <option v-for="item in tagRefs" :key="item.name" :value="selectionRef(item.name)">
                {{ item.name }}
              </option>
            </SelectField>
            <SelectField
              v-model="selectedWorkflowPath"
              :label="t('actionsWorkflow')"
              :disabled="loading || workflowLoading || !workflows.length"
            >
              <option value="" disabled>{{ t("actionsChooseWorkflow") }}</option>
              <option v-for="workflow in workflows" :key="workflow.path" :value="workflow.path">
                {{ workflow.name }}
              </option>
            </SelectField>
            <FluentButton
              type="button"
              tone="primary"
              :disabled="saving || loading || workflowLoading || !canDispatch"
              @click="startRun"
              >{{ saving ? t("loading") : t("actionsDispatch") }}</FluentButton
            >
          </div>
          <p v-if="!selectableRefs.length" class="actions-empty">{{ t("actionsNoBranches") }}</p>
          <p
            v-else-if="!workflows.length && !loading && !workflowLoading && !error"
            class="actions-empty"
          >
            {{ t("actionsNoWorkflows") }}
          </p>
          <p v-if="chosenWorkflow" class="actions-muted">
            {{ t("actionsTriggers", { triggers: chosenWorkflow.triggers.join(", ") || "-" }) }}
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
        </div>
      </section>

      <section class="box actions-panel" :aria-label="t('actionsRuns')">
        <header class="box-header">
          <h3>{{ t("actionsRuns") }}</h3>
          <FluentButton
            class="header-action"
            type="button"
            size="small"
            :disabled="pollPending"
            @click="refreshRuns"
            >{{ t("actionsRefresh") }}</FluentButton
          >
        </header>
        <p v-if="!runs.length" class="actions-empty actions-panel-body">
          {{ t("actionsNoRuns") }}
        </p>
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
        class="box actions-panel actions-run-detail"
        :aria-label="t('actionsLogs')"
      >
        <header class="box-header actions-run-header">
          <div>
            <h3>{{ selectedRun.workflowName }}</h3>
            <code>{{ selectedRun.commitOid }}</code>
          </div>
          <ConfirmButton
            v-if="canWrite && selectedRunActive"
            tone="secondary"
            :label="cancelling ? t('actionsCancelling') : t('actionsCancel')"
            :prompt="t('confirmCancelRun')"
            :disabled="cancelling"
            @confirm="cancelRun"
          />
        </header>
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
  gap: var(--space-4);
  min-width: 0;
}
.actions-heading,
.actions-toolbar,
.actions-step > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.actions-heading h2,
.actions-job h4 {
  margin: 0;
}
.actions-heading p,
.actions-muted,
.actions-oid,
.actions-empty {
  color: var(--fg-secondary);
}
.actions-layout {
  display: grid;
  gap: var(--space-4);
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
}
.actions-syntax {
  margin-top: var(--space-2);
  color: var(--fg-secondary);
}
.actions-syntax summary {
  cursor: pointer;
}
.actions-syntax ul {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-5);
}
.actions-network-notice,
.actions-load-error {
  grid-column: 1 / -1;
}
.actions-panel {
  min-width: 0;
}
.actions-panel-body {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}
.actions-toolbar {
  align-items: end;
  flex-wrap: wrap;
}
.actions-toolbar > * {
  flex: 1 1 160px;
}
.actions-empty,
.actions-muted,
.actions-warning,
.actions-error,
.actions-oid {
  margin: 0;
}
.actions-warning,
.actions-error,
.actions-load-error {
  padding: var(--space-2) var(--space-3);
  border: 1px solid;
  border-radius: var(--radius-md);
}
.actions-warning {
  color: var(--warning-fg);
  background: var(--warning-subtle);
  border-color: var(--warning-border);
}
.actions-error,
.actions-load-error {
  color: var(--danger-fg);
  background: var(--danger-subtle);
  border-color: var(--danger-border);
}
.actions-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.actions-oid code,
.actions-run-header code {
  overflow-wrap: anywhere;
}
.actions-run-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.actions-run-list li + li {
  border-top: 1px solid var(--border-muted);
}
.actions-run-button {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  width: 100%;
  padding: var(--space-3) var(--space-4);
  text-align: left;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.actions-run-button:hover {
  background: var(--bg-subtle);
}
.actions-run-button[aria-current="true"] {
  background: var(--bg-selected);
  box-shadow: inset 3px 0 var(--accent-strong);
}
.actions-run-name {
  font-weight: var(--font-weight-semibold);
}
.actions-run-ref {
  flex-basis: 100%;
  order: 3;
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-meta);
  overflow-wrap: anywhere;
}
.actions-run-button :deep(.badge) {
  margin-left: auto;
}
.actions-run-detail {
  grid-column: 1 / -1;
}
.actions-run-header {
  justify-content: space-between;
}
.actions-run-header > div {
  display: grid;
  min-width: 0;
}
.actions-run-header h3 {
  font-size: var(--font-size-body);
}
.actions-job {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}
.actions-job + .actions-job {
  border-top: 1px solid var(--border-muted);
}
.actions-step {
  min-width: 0;
}
.actions-step > header {
  justify-content: flex-start;
}
.actions-step pre {
  max-height: 360px;
  overflow: auto;
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  color: var(--fg-default);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  font-size: var(--font-size-meta);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 760px) {
  .actions-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .actions-run-detail,
  .actions-network-notice,
  .actions-load-error {
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
