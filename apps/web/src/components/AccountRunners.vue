<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  RunnerHistoryItem,
  RunnerOverview,
  RunnerOverviewRunner,
} from "../../../../packages/contracts/src/runners";
import { isRunnerSystemLabel } from "../../../../packages/contracts/src/runners";
import { api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import AccountRunnerServices from "./AccountRunnerServices.vue";

const { t, d } = useI18n();
const overview = ref<RunnerOverview | null>(null);
const loading = ref(true);
const loadError = ref("");
const histories = ref(new Map<string, RunnerHistoryItem[]>());
const nextBefore = ref(new Map<string, string>());
const historyLoading = ref(new Set<string>());
const historyErrors = ref(new Set<string>());
const labelDrafts = ref(new Map<string, string>());
const savingLabels = ref(new Set<string>());
const labelErrors = ref(new Set<string>());
const removingRunners = ref(new Set<string>());
const removeErrors = ref(new Set<string>());
const historyControllers = new Map<string, AbortController>();
let overviewController: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let disposed = false;

const queueAge = computed(() => {
  const oldest = overview.value?.queue[0]?.createdAt;
  return oldest === undefined ? null : Math.max(0, Date.now() - oldest);
});

const runnerCounts = computed(() => {
  const runners = overview.value?.runners ?? [];
  const count = (...states: RunnerOverviewRunner["state"][]): number =>
    runners.filter((runner) => states.includes(runner.state)).length;
  return {
    online: count("idle", "busy"),
    busy: count("busy"),
    held: count("held"),
    offline: count("offline"),
  };
});

function stateTone(
  state: RunnerOverviewRunner["state"]
): "neutral" | "success" | "danger" | "brand" | "warning" {
  if (state === "idle") return "success";
  if (state === "busy") return "brand";
  if (state === "held") return "warning";
  if (state === "offline") return "danger";
  return "neutral";
}

function loadPath(points: RunnerOverviewRunner["samples"]): string {
  const finite = points
    .map((point) => point.load1)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (finite.length < 2) return "";
  const max = Math.max(1, ...finite);
  return finite
    .map(
      (value, index) =>
        `${index ? "L" : "M"} ${(index * 100) / (finite.length - 1)} ${32 - (Math.min(value, max) / max) * 28}`
    )
    .join(" ");
}

function reasonText(code: string): string {
  const [kind, detail] = code.split(":", 2);
  const key = `runnerReason_${kind.replaceAll("-", "_")}`;
  if (kind === "label") return t(key, { label: detail });
  if (kind === "tool") return t(key, { tool: detail });
  return t(key);
}

function conclusionText(item: RunnerHistoryItem): string {
  return t(
    `runnerConclusion_${item.conclusion ?? (item.startedAt === null ? "queued" : "running")}`
  );
}

function jobText(kind: "gitedge" | "github"): string {
  return t(kind === "github" ? "runnerGitHubJob" : "runnerGitEdgeJob");
}

async function refresh(): Promise<void> {
  if (disposed || document.visibilityState !== "visible") return;
  overviewController?.abort();
  const controller = new AbortController();
  overviewController = controller;
  loading.value = !overview.value;
  loadError.value = "";
  try {
    const nextOverview = await api.runnerOverview(controller.signal);
    if (controller.signal.aborted || disposed) return;
    overview.value = nextOverview;
    const drafts = new Map(labelDrafts.value);
    for (const runner of nextOverview.runners) {
      if (!drafts.has(runner.id))
        drafts.set(
          runner.id,
          runner.labels.filter((label) => !isRunnerSystemLabel(label)).join(", ")
        );
    }
    labelDrafts.value = drafts;
  } catch (cause) {
    if (!controller.signal.aborted && !disposed) loadError.value = errorMessage(cause, t);
  } finally {
    if (overviewController === controller) overviewController = null;
    if (!disposed && !controller.signal.aborted) loading.value = false;
  }
}

function setLabelDraft(runnerId: string, value: string): void {
  labelDrafts.value = new Map(labelDrafts.value).set(runnerId, value);
}

async function saveRunnerLabels(runner: RunnerOverviewRunner): Promise<void> {
  if (savingLabels.value.has(runner.id)) return;
  const labels = (labelDrafts.value.get(runner.id) ?? "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
  savingLabels.value = new Set(savingLabels.value).add(runner.id);
  labelErrors.value = new Set([...labelErrors.value].filter((id) => id !== runner.id));
  try {
    const result = await api.updateRunnerLabels(runner.id, labels);
    if (!overview.value) return;
    overview.value = {
      ...overview.value,
      runners: overview.value.runners.map((item) =>
        item.id === runner.id ? { ...item, labels: result.labels } : item
      ),
    };
    setLabelDraft(
      runner.id,
      result.labels.filter((label) => !isRunnerSystemLabel(label)).join(", ")
    );
  } catch {
    labelErrors.value = new Set(labelErrors.value).add(runner.id);
  } finally {
    savingLabels.value = new Set([...savingLabels.value].filter((id) => id !== runner.id));
  }
}

async function removeRunner(runner: RunnerOverviewRunner): Promise<void> {
  if (removingRunners.value.has(runner.id)) return;
  removingRunners.value = new Set(removingRunners.value).add(runner.id);
  removeErrors.value = new Set([...removeErrors.value].filter((id) => id !== runner.id));
  try {
    await api.removeRunner(runner.id);
    // An in-flight poll may still return the removed runner.
    overviewController?.abort();
    if (overview.value)
      overview.value = {
        ...overview.value,
        runners: overview.value.runners.filter((item) => item.id !== runner.id),
      };
  } catch {
    removeErrors.value = new Set(removeErrors.value).add(runner.id);
  } finally {
    removingRunners.value = new Set([...removingRunners.value].filter((id) => id !== runner.id));
  }
}

async function loadHistory(runnerId: string, more = false): Promise<void> {
  if (disposed || historyLoading.value.has(runnerId)) return;
  const before = more ? nextBefore.value.get(runnerId) : undefined;
  if (more && !before) return;
  historyControllers.get(runnerId)?.abort();
  const controller = new AbortController();
  historyControllers.set(runnerId, controller);
  historyLoading.value = new Set(historyLoading.value).add(runnerId);
  historyErrors.value = new Set([...historyErrors.value].filter((id) => id !== runnerId));
  try {
    const page = await api.runnerHistory(runnerId, before, controller.signal);
    if (controller.signal.aborted || disposed) return;
    histories.value = new Map(histories.value).set(
      runnerId,
      more ? [...(histories.value.get(runnerId) ?? []), ...page.items] : page.items
    );
    const cursorMap = new Map(nextBefore.value);
    if (page.nextBefore) cursorMap.set(runnerId, page.nextBefore);
    else cursorMap.delete(runnerId);
    nextBefore.value = cursorMap;
  } catch (cause) {
    if (!controller.signal.aborted && !disposed)
      historyErrors.value = new Set(historyErrors.value).add(runnerId);
  } finally {
    if (historyControllers.get(runnerId) === controller) historyControllers.delete(runnerId);
    if (!disposed && !controller.signal.aborted)
      historyLoading.value = new Set([...historyLoading.value].filter((id) => id !== runnerId));
  }
}

function historyToggle(runnerId: string, event: Event): void {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement)) return;
  if (details.open && !histories.value.has(runnerId)) void loadHistory(runnerId);
  if (!details.open) {
    historyControllers.get(runnerId)?.abort();
    historyLoading.value = new Set([...historyLoading.value].filter((id) => id !== runnerId));
  }
}

function visibilityChanged(): void {
  if (document.visibilityState === "visible") void refresh();
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 15_000);
  document.addEventListener("visibilitychange", visibilityChanged);
});
onUnmounted(() => {
  disposed = true;
  if (timer !== null) clearInterval(timer);
  document.removeEventListener("visibilitychange", visibilityChanged);
  overviewController?.abort();
  for (const controller of historyControllers.values()) controller.abort();
  historyControllers.clear();
});
</script>

<template>
  <section class="settings-panel runner-dashboard">
    <header class="settings-header">
      <div>
        <h2>{{ t("runnerDashboardTitle") }}</h2>
        <p>{{ t("runnerDashboardDescription") }}</p>
      </div>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="refresh">{{
        t("refresh")
      }}</FluentButton>
    </header>
    <NoticeBar v-if="loadError" intent="error">{{ loadError }}</NoticeBar>
    <div v-if="overview" class="runner-summary" :aria-label="t('runnerDashboardTitle')">
      <span
        >{{ t("runnerOnline") }} <strong>{{ runnerCounts.online }}</strong></span
      >
      <span
        >{{ t("runnerBusy") }} <strong>{{ runnerCounts.busy }}</strong></span
      >
      <span
        >{{ t("runnerHeld") }} <strong>{{ runnerCounts.held }}</strong></span
      >
      <span
        >{{ t("runnerOffline") }} <strong>{{ runnerCounts.offline }}</strong></span
      >
      <span
        >{{ t("runnerQueue") }} <strong>{{ overview.queue.length }}</strong></span
      >
      <span v-if="queueAge !== null"
        >{{ t("runnerOldestQueue") }} <strong>{{ Math.floor(queueAge / 60_000) }}m</strong></span
      >
    </div>
    <AccountRunnerServices />
    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <template v-else-if="overview">
      <NoticeBar v-if="overview.truncated" intent="warning">{{ t("runnerTruncated") }}</NoticeBar>
      <section class="box" :aria-label="t('runnerDashboardTitle')">
        <p v-if="overview.runners.length === 0" class="empty-state">{{ t("runnerEmpty") }}</p>
        <article v-for="runner in overview.runners" :key="runner.id" class="runner-card">
          <header class="runner-card-header">
            <div>
              <h3>{{ runner.name }}</h3>
              <StatusBadge :tone="stateTone(runner.state)">{{
                t(`runnerState_${runner.state}`)
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              {{ t("runnerScope") }}: {{ runner.scope.owner
              }}<template v-if="runner.scope.repository">/{{ runner.scope.repository }}</template>
            </div>
          </header>
          <div v-if="runner.state !== 'idle' && runner.state !== 'busy'" class="runner-remove">
            <ConfirmButton
              :label="t('runnerRemove')"
              :accessible-name="`${t('runnerRemove')} · ${runner.name}`"
              :prompt="t('runnerRemovePrompt')"
              :busy="removingRunners.has(runner.id)"
              @confirm="removeRunner(runner)"
            />
            <p v-if="removeErrors.has(runner.id)" class="row-meta" role="alert">
              {{ t("runnerRemoveError") }}
            </p>
          </div>
          <div class="runner-labels">
            <StatusBadge v-for="label in runner.labels" :key="label">{{ label }}</StatusBadge>
          </div>
          <form class="runner-label-editor" @submit.prevent="saveRunnerLabels(runner)">
            <label :for="`runner-labels-${runner.id}`">{{ t("runnerCustomLabels") }}</label>
            <div class="runner-label-editor-row">
              <input
                :id="`runner-labels-${runner.id}`"
                :value="labelDrafts.get(runner.id) ?? ''"
                :placeholder="t('runnerCustomLabelsHint')"
                @input="setLabelDraft(runner.id, ($event.target as HTMLInputElement).value)"
              />
              <FluentButton type="submit" tone="subtle" :busy="savingLabels.has(runner.id)">
                {{ t("runnerCustomLabelsSave") }}
              </FluentButton>
            </div>
            <p class="row-meta">{{ t("runnerCustomLabelsHelp") }}</p>
            <p v-if="labelErrors.has(runner.id)" class="row-meta" role="alert">
              {{ t("runnerCustomLabelsError") }}
            </p>
          </form>
          <div v-if="runner.capacity" class="runner-metrics">
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
                <path
                  :d="loadPath(runner.samples)"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                />
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
            {{ t("runnerCurrentJob") }} · {{ jobText(runner.current.kind) }} ·
            {{ runner.current.repository }} ·
            {{ Math.max(0, Math.floor((Date.now() - runner.current.startedAt) / 60_000)) }}m
          </p>
          <p v-if="runner.state === 'held' && runner.heldUntil" class="row-meta">
            {{ t("runnerHeldUntil", { time: d(new Date(runner.heldUntil), "short") }) }} ·
            {{ t("runnerFailures", { count: runner.consecutiveFailures }) }}
          </p>
          <details class="runner-history" @toggle="historyToggle(runner.id, $event)">
            <summary>
              {{ t("runnerHistory") }} · {{ runner.stats24h.success }} /
              {{ runner.stats24h.failure }} / {{ runner.stats24h.cancelled }}
            </summary>
            <p v-if="historyErrors.has(runner.id)" class="row-meta">
              {{ t("runnerHistoryError") }}
            </p>
            <p v-if="histories.get(runner.id)?.length === 0" class="row-meta">
              {{ t("runnerHistoryEmpty") }}
            </p>
            <ul v-if="histories.get(runner.id)?.length" class="settings-list">
              <li
                v-for="item in histories.get(runner.id)"
                :key="`${item.kind}:${item.id}`"
                class="box-row runner-history-item"
              >
                <div>
                  <strong>{{ jobText(item.kind) }} · {{ item.repository }}</strong
                  ><span class="row-meta"
                    >{{ item.labels.join(", ") }} ·
                    {{ item.startedAt ? d(new Date(item.startedAt), "short") : "—" }}</span
                  >
                </div>
                <StatusBadge
                  :tone="
                    item.conclusion === 'success'
                      ? 'success'
                      : item.conclusion === 'failure'
                        ? 'danger'
                        : 'neutral'
                  "
                  >{{ conclusionText(item) }}</StatusBadge
                >
              </li>
            </ul>
            <FluentButton
              v-if="nextBefore.has(runner.id)"
              type="button"
              tone="subtle"
              :busy="historyLoading.has(runner.id)"
              @click="loadHistory(runner.id, true)"
              >{{ t("runnerLoadMore") }}</FluentButton
            >
          </details>
        </article>
      </section>

      <section class="box runner-section">
        <h3>{{ t("runnerConnection") }}</h3>
        <p v-if="overview.github.length === 0" class="empty-state">
          {{ t("runnerNoConnections") }}
        </p>
        <ul class="settings-list">
          <li
            v-for="connection in overview.github"
            :key="connection.connectionId"
            class="box-row settings-item"
          >
            <div class="settings-item-copy">
              <div class="row-title">{{ connection.repository }} · {{ connection.remote }}</div>
              <div class="row-meta">
                {{
                  connection.errorCode
                    ? t("runnerSyncErrorCode", { code: connection.errorCode })
                    : connection.enabled
                      ? t("settingsActive")
                      : t("runnerConnectionDisabled")
                }}
                · {{ t("runnerFailureCount", { count: connection.failureCount }) }} ·
                {{ t("runnerQueue") }}: {{ connection.queued }} ·
                {{ t("runnerPendingCleanup", { count: connection.pendingCleanup }) }}
              </div>
              <div class="row-meta">
                {{ t("runnerLastSynced") }}:
                {{ connection.lastSyncedAt ? d(new Date(connection.lastSyncedAt), "short") : "—" }}
                · {{ t("runnerLastJob") }}:
                {{ connection.lastJobAt ? d(new Date(connection.lastJobAt), "short") : "—" }}
              </div>
            </div>
          </li>
        </ul>
      </section>

      <section class="box runner-section">
        <h3>{{ t("runnerQueueTitle") }}</h3>
        <p v-if="overview.queue.length === 0" class="empty-state">{{ t("runnerQueue") }} · 0</p>
        <ul class="settings-list">
          <li
            v-for="job in overview.queue"
            :key="`${job.kind}:${job.id}`"
            class="box-row runner-queue-item"
          >
            <div>
              <strong>{{ jobText(job.kind) }} · {{ job.repository }}</strong>
              <div class="row-meta">
                {{ job.labels.join(", ") }} · {{ d(new Date(job.createdAt), "short") }}
              </div>
              <div class="runner-claim">
                <strong>{{ t("runnerClaim") }}:</strong>
                <span>{{
                  t("runnerClaimMemory", {
                    value:
                      job.claim.memMb >= 1024
                        ? `${job.claim.memMb / 1024} GB`
                        : `${job.claim.memMb} MB`,
                  })
                }}</span>
                <span>{{ t("runnerClaimCpu", { value: job.claim.cpus }) }}</span>
                <span v-if="job.claim.diskMb">{{
                  t("runnerClaimDisk", { value: `${job.claim.diskMb} MB` })
                }}</span>
                <span v-if="job.claim.gpuVendor || job.claim.vramMb">{{
                  t("runnerClaimGpu", {
                    value: job.claim.gpuVendor?.toUpperCase() ?? t("runnerGpuAny"),
                  })
                }}</span>
                <span v-if="job.claim.vramMb">{{
                  t("runnerClaimVram", { value: `${job.claim.vramMb} MiB` })
                }}</span>
                <span v-if="job.claim.tools.length">{{
                  t("runnerClaimTools", { value: job.claim.tools.join(", ") })
                }}</span>
                <span>{{ t("runnerClaimTime", { value: job.claim.minutes }) }}</span>
              </div>
              <div v-if="Object.keys(job.blockedBy).length" class="runner-reasons">
                <strong>{{ t("runnerBlockedBy") }}</strong
                ><span v-for="[id, reasons] in Object.entries(job.blockedBy)" :key="id"
                  >{{ overview.runners.find((runner) => runner.id === id)?.name ?? id }}:
                  {{ reasons.map(reasonText).join(", ") }}</span
                >
              </div>
            </div>
            <StatusBadge>{{ jobText(job.kind) }}</StatusBadge>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.runner-dashboard {
  display: grid;
  gap: 1rem;
}
.runner-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
  padding: 0.8rem 1rem;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 0.75rem;
}
.runner-summary span {
  display: flex;
  gap: 0.4rem;
}
.runner-remove {
  display: grid;
  gap: var(--space-2);
}
.runner-card {
  display: grid;
  gap: 0.65rem;
  padding: 1rem;
  border-bottom: 1px solid var(--color-border, #d1d5db);
}
.runner-card:last-child {
  border-bottom: 0;
}
.runner-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.runner-card-header > div:first-child {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.runner-card h3,
.runner-section h3 {
  margin: 0;
  font-size: 1rem;
}
.runner-labels,
.runner-claim {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.runner-label-editor {
  display: grid;
  gap: 0.35rem;
  max-width: 36rem;
}
.runner-label-editor-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.runner-label-editor-row input {
  flex: 1 1 16rem;
}
.runner-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0.5rem 1rem;
}
.runner-metrics > div {
  display: grid;
  gap: 0.3rem;
}
.runner-metrics svg {
  width: 8rem;
  height: 2rem;
  color: var(--color-accent, #d97706);
}
.runner-current,
.runner-section > h3 {
  margin: 0.3rem 0;
}
.runner-history {
  border-top: 1px solid var(--color-border, #d1d5db);
  padding-top: 0.5rem;
}
.runner-history summary {
  cursor: pointer;
  font-weight: 600;
}
.runner-history-item,
.runner-queue-item {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  align-items: flex-start;
}
.runner-history-item > div,
.runner-queue-item > div {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}
.runner-claim,
.runner-reasons {
  margin-top: 0.4rem;
}
.runner-reasons {
  display: grid;
  gap: 0.25rem;
}
.runner-section {
  padding: 1rem;
}
.empty-state {
  color: var(--color-text-secondary, #6b7280);
}
@media (max-width: 640px) {
  .runner-queue-item,
  .runner-history-item {
    flex-direction: column;
  }
}
</style>
