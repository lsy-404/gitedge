<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import { isRunnerSystemLabel } from "../../../../../packages/contracts/src/runners";
import type { RunnerOverviewRunner } from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import {
  deviceHealthTone,
  healthPercent,
  jobKey,
  loadPath,
  slotCount,
  stateTone,
} from "../../lib/runner-display";
import ConfirmButton from "../ConfirmButton.vue";
import StatusBadge from "../StatusBadge.vue";

const props = defineProps<{ runner: RunnerOverviewRunner }>();
const emit = defineEmits<{
  labels: [id: string, labels: string[]];
  type: [id: string, type: "owned" | "rented"];
  removed: [id: string];
}>();
const { t, d } = useI18n();

const customLabels = (labels: string[]): string =>
  labels.filter((label) => !isRunnerSystemLabel(label)).join(", ");
const draft = ref(customLabels(props.runner.labels));
const savingLabels = ref(false);
const labelError = ref(false);
const savingType = ref(false);
const typeError = ref(false);
const removing = ref(false);
const removeError = ref(false);
const slots = computed(() => slotCount(props.runner));
const selfHosted = computed(() => props.runner.type !== "github-hosted");

function healthLabel(status: RunnerOverviewRunner["deviceHealth"]["status"]): string {
  return t(`runnerHealth_${status}`);
}

function healthTime(value: number): string {
  return d(new Date(value), "short");
}

async function saveLabels(): Promise<void> {
  if (savingLabels.value) return;
  const labels = draft.value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  savingLabels.value = true;
  labelError.value = false;
  try {
    const result = await api.updateRunnerLabels(props.runner.id, labels);
    emit("labels", props.runner.id, result.labels);
    draft.value = customLabels(result.labels);
  } catch {
    labelError.value = true;
  } finally {
    savingLabels.value = false;
  }
}

async function changeType(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value;
  if (value !== "owned" && value !== "rented") return;
  savingType.value = true;
  typeError.value = false;
  try {
    const result = await api.updateRunnerType(props.runner.id, value);
    emit("type", props.runner.id, result.type);
  } catch {
    typeError.value = true;
    (event.target as HTMLSelectElement).value = props.runner.type;
  } finally {
    savingType.value = false;
  }
}

async function remove(): Promise<void> {
  if (removing.value) return;
  removing.value = true;
  removeError.value = false;
  try {
    await api.removeRunner(props.runner.id);
    emit("removed", props.runner.id);
  } catch {
    removeError.value = true;
  } finally {
    removing.value = false;
  }
}
</script>

<template>
  <article class="runner-card">
    <header class="runner-card-header">
      <div class="runner-title">
        <h4>{{ runner.name }}</h4>
        <StatusBadge :tone="stateTone(runner.state)">{{
          t(`runnerState_${runner.state}`)
        }}</StatusBadge>
        <StatusBadge>{{
          slots
            ? t("runnerSlotsUsed", { used: slots.used, total: slots.total })
            : t("runnerSlotsUnknown")
        }}</StatusBadge>
      </div>
      <div class="row-meta">
        {{ t("runnerScope") }}: {{ runner.scope.owner
        }}<template v-if="runner.scope.repository">/{{ runner.scope.repository }}</template>
      </div>
    </header>

    <div v-if="selfHosted" class="runner-type-editor">
      <label :for="`runner-type-${runner.id}`">{{ t("runnerType") }}</label>
      <select
        :id="`runner-type-${runner.id}`"
        :value="runner.type"
        :disabled="savingType"
        @change="changeType"
      >
        <option value="owned">{{ t("runnerType_owned") }}</option>
        <option value="rented">{{ t("runnerType_rented") }}</option>
      </select>
      <p v-if="typeError" class="row-meta" role="alert">{{ t("runnerTypeError") }}</p>
    </div>

    <div v-if="runner.state !== 'idle' && runner.state !== 'busy'" class="runner-remove">
      <ConfirmButton
        :label="t('runnerRemove')"
        :accessible-name="`${t('runnerRemove')} · ${runner.name}`"
        :prompt="t('runnerRemovePrompt')"
        :busy="removing"
        @confirm="remove"
      />
      <p v-if="removeError" class="row-meta" role="alert">{{ t("runnerRemoveError") }}</p>
    </div>

    <div class="runner-labels">
      <StatusBadge v-for="label in runner.labels" :key="label">
        {{ label.toLowerCase() === "limited-connect" ? t("runnerLimitedConnect") : label }}
      </StatusBadge>
    </div>

    <div class="runner-metrics">
      <div>
        <span>{{ t("runnerHostHealth") }} · {{ runner.deviceHealth.deviceId ?? "—" }}</span>
        <StatusBadge :tone="deviceHealthTone(runner.deviceHealth.status)">
          {{ healthLabel(runner.deviceHealth.status) }}
        </StatusBadge>
      </div>
      <div>
        <span>{{ t("runnerHostCpu") }} · {{ healthPercent(runner.deviceHealth.cpuPercent) }}</span>
      </div>
      <div>
        <span
          >{{ t("runnerHostMemory") }} ·
          {{ healthPercent(runner.deviceHealth.memoryPercent) }}</span
        >
      </div>
      <div v-for="disk in runner.deviceHealth.disks" :key="disk.path">
        <span
          >{{ t("runnerHostDisk") }} · {{ disk.path }} · {{ healthPercent(disk.usedPercent) }} /
          {{ Math.round(disk.totalBytes / 1_073_741_824) }} GB</span
        >
      </div>
      <span class="row-meta"
        >{{ t("runnerHostLastSeen") }} ·
        {{ runner.deviceHealth.lastSeen ? healthTime(runner.deviceHealth.lastSeen) : "—" }}</span
      >
    </div>

    <form class="runner-label-editor" @submit.prevent="saveLabels">
      <label :for="`runner-labels-${runner.id}`">{{ t("runnerCustomLabels") }}</label>
      <div class="runner-label-editor-row">
        <input
          :id="`runner-labels-${runner.id}`"
          v-model="draft"
          :placeholder="t('runnerCustomLabelsHint')"
        />
        <FluentButton type="submit" tone="subtle" :busy="savingLabels">
          {{ t("runnerCustomLabelsSave") }}
        </FluentButton>
      </div>
      <p class="row-meta">{{ t("runnerCustomLabelsHelp") }}</p>
      <p v-if="labelError" class="row-meta" role="alert">{{ t("runnerCustomLabelsError") }}</p>
    </form>

    <div v-if="runner.capacity" class="runner-metrics">
      <strong>{{ t("runnerSchedulingCapacity") }}</strong>
      <div>
        <span
          >{{ t("runnerCpuLoad") }} ·
          {{
            runner.capacity.load1 === null
              ? "—"
              : `${runner.capacity.load1.toFixed(2)} / ${runner.capacity.cpus}`
          }}</span
        ><svg
          v-if="loadPath(runner.samples)"
          viewBox="0 0 100 36"
          role="img"
          :aria-label="t('runnerCpuLoad')"
        >
          <path :d="loadPath(runner.samples)" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
      </div>
      <div>
        <span
          >{{ t("runnerMemoryFree") }} · {{ runner.capacity.memFreeMb }} /
          {{ runner.capacity.memTotalMb }} MB</span
        ><progress
          class="progress-bar"
          :value="runner.capacity.memFreeMb"
          :max="runner.capacity.memTotalMb"
        />
      </div>
      <div>
        <span>{{ t("runnerDiskFree") }} · {{ runner.capacity.diskFreeMb }} MB</span>
      </div>
      <div>
        <span
          >{{ t("runnerGpu") }} ·
          {{
            runner.capacity.gpus == null
              ? t("runnerCapacityUnknown")
              : runner.capacity.gpus.length
                ? runner.capacity.gpus
                    .map(
                      (gpu) =>
                        `${gpu.vendor.toUpperCase()}${gpu.vramMb === null ? "" : ` / ${gpu.vramMb} MiB`}`
                    )
                    .join(", ")
                : t("runnerGpuNone")
          }}</span
        >
      </div>
    </div>
    <p v-else class="row-meta">{{ t("runnerCapacityUnknown") }}</p>

    <div v-if="runner.budget" class="runner-metrics">
      <span
        >{{ t("runnerBudget") }} ·
        {{
          t("runnerUsedMinutes", {
            used: runner.usedMinutes24h,
            limit: runner.budget.dailyMinutes ?? "—",
          })
        }}</span
      >
      <progress
        v-if="runner.budget.dailyMinutes"
        class="progress-bar"
        :value="runner.usedMinutes24h"
        :max="runner.budget.dailyMinutes"
      />
      <span v-if="runner.budget.maxJobMinutes"
        >{{ t("runnerJobLimit") }} · {{ runner.budget.maxJobMinutes }} min</span
      >
    </div>

    <p v-if="runner.current" class="runner-current">
      {{ t("runnerCurrentJob") }} · {{ t(jobKey(runner.current.kind)) }} ·
      {{ runner.current.repository }} ·
      {{ Math.max(0, Math.floor((Date.now() - runner.current.startedAt) / 60_000)) }}m
    </p>
    <p v-if="runner.state === 'held' && runner.heldUntil" class="row-meta">
      {{ t("runnerHeldUntil", { time: d(new Date(runner.heldUntil), "short") }) }} ·
      {{ t("runnerFailures", { count: runner.consecutiveFailures }) }}
    </p>
  </article>
</template>

<style scoped>
.runner-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-default);
}
.runner-card:last-child {
  border-bottom: 0;
}
.runner-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.runner-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.runner-card h4 {
  margin: 0;
  font-size: 1rem;
}
.runner-remove,
.runner-type-editor {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.runner-labels {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.runner-label-editor {
  display: grid;
  gap: var(--space-2);
  max-width: 36rem;
}
.runner-label-editor-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.runner-label-editor-row input {
  flex: 1 1 16rem;
}
.runner-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: var(--space-2) var(--space-4);
}
.runner-metrics > div {
  display: grid;
  gap: var(--space-1);
}
.runner-metrics svg {
  width: 8rem;
  height: 2rem;
  color: var(--accent-fg);
}
.runner-current {
  margin: 0;
}
</style>
