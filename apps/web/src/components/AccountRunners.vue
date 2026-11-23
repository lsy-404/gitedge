<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  ColabAccount,
  RunnerOverview,
  RunnerSettings,
} from "../../../../packages/contracts/src/runners";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";
import AccountRunnerServices from "./AccountRunnerServices.vue";
import RunnerActivityTab from "./runners/RunnerActivityTab.vue";
import RunnerConnectionsTab from "./runners/RunnerConnectionsTab.vue";
import RunnerOnDemandTab from "./runners/RunnerOnDemandTab.vue";
import RunnerSlotsTab from "./runners/RunnerSlotsTab.vue";

const tabs = ["activity", "slots", "ondemand", "services", "github"] as const;
type RunnerTab = (typeof tabs)[number];

const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const tablist = ref<HTMLElement | null>(null);
const overview = ref<RunnerOverview | null>(null);
const loading = ref(true);
const loadError = ref("");
let overviewController: AbortController | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let disposed = false;

const activeTab = computed<RunnerTab>(
  () => tabs.find((tab) => tab === route.query.tab) ?? "activity"
);
const needsOverview = computed(() => activeTab.value !== "services");

function selectTab(tab: RunnerTab): Promise<unknown> {
  return router.replace({ query: { ...route.query, tab } });
}

async function focusTab(index: number): Promise<void> {
  const tab = tabs[index];
  await selectTab(tab);
  await nextTick();
  tablist.value?.querySelector<HTMLButtonElement>(`#runner-tab-${tab}`)?.focus();
}

function moveTab(offset: number): Promise<void> {
  const current = tabs.indexOf(activeTab.value);
  return focusTab((current + offset + tabs.length) % tabs.length);
}

function healthTime(value: number): string {
  return d(new Date(value), "short");
}

async function refresh(): Promise<void> {
  if (disposed || document.visibilityState !== "visible") return;
  overviewController?.abort();
  const controller = new AbortController();
  overviewController = controller;
  loading.value = !overview.value;
  loadError.value = "";
  try {
    const next = await api.runnerOverview(controller.signal);
    if (controller.signal.aborted || disposed) return;
    overview.value = next;
  } catch (cause) {
    if (!controller.signal.aborted && !disposed) loadError.value = errorMessage(cause, t);
  } finally {
    if (overviewController === controller) overviewController = null;
    if (!disposed && !controller.signal.aborted) loading.value = false;
  }
}

function patchOverview(patch: Partial<RunnerOverview>): void {
  if (overview.value) overview.value = { ...overview.value, ...patch };
}

function patchRunner(id: string, patch: Partial<RunnerOverview["runners"][number]>): void {
  if (!overview.value) return;
  patchOverview({
    runners: overview.value.runners.map((runner) =>
      runner.id === id ? { ...runner, ...patch } : runner
    ),
  });
}

function removeRunner(id: string): void {
  // An in-flight poll may still return the removed runner.
  overviewController?.abort();
  if (overview.value)
    patchOverview({ runners: overview.value.runners.filter((runner) => runner.id !== id) });
}

function applySettings(settings: RunnerSettings): void {
  if (!overview.value) return;
  patchOverview({
    slotPriority: settings.slotPriority,
    onDemandPriority: settings.onDemandPriority,
    githubIncludedUsd: settings.githubIncludedUsd,
    colab: { ...overview.value.colab, enabled: settings.colabEnabled },
  });
}

function applyAccount(account: ColabAccount | null): void {
  if (overview.value) patchOverview({ colab: { ...overview.value.colab, account } });
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
    <div ref="tablist" class="tab-list" role="tablist" :aria-label="t('runnerTabsLabel')">
      <button
        v-for="tab in tabs"
        :id="`runner-tab-${tab}`"
        :key="tab"
        class="tab"
        type="button"
        role="tab"
        aria-controls="runner-panel"
        :aria-selected="activeTab === tab"
        :tabindex="activeTab === tab ? 0 : -1"
        @click="selectTab(tab)"
        @keydown.left.prevent="moveTab(-1)"
        @keydown.right.prevent="moveTab(1)"
        @keydown.home.prevent="focusTab(0)"
        @keydown.end.prevent="focusTab(tabs.length - 1)"
      >
        {{ t(`runnerTab_${tab}`) }}
      </button>
    </div>
    <div
      id="runner-panel"
      class="runner-panel"
      role="tabpanel"
      :aria-labelledby="`runner-tab-${activeTab}`"
    >
      <AccountRunnerServices v-if="activeTab === 'services'" />
      <div v-else-if="loading && !overview" class="box"><StatusState :loading="true" /></div>
      <template v-else-if="overview && needsOverview">
        <NoticeBar v-if="overview.truncated" intent="warning">{{ t("runnerTruncated") }}</NoticeBar>
        <RunnerActivityTab v-if="activeTab === 'activity'" :overview="overview" />
        <RunnerSlotsTab
          v-else-if="activeTab === 'slots'"
          :overview="overview"
          @labels="(id, labels) => patchRunner(id, { labels })"
          @type="(id, type) => patchRunner(id, { type })"
          @removed="removeRunner"
          @settings="applySettings"
        />
        <RunnerOnDemandTab
          v-else-if="activeTab === 'ondemand'"
          :overview="overview"
          @quota="(githubQuota) => patchOverview({ githubQuota })"
          @account="applyAccount"
          @settings="applySettings"
        />
        <RunnerConnectionsTab v-else :connections="overview.github" />
        <p v-if="activeTab === 'activity' || activeTab === 'slots'" class="row-meta">
          {{ t("runnerHealthSource") }} ·
          {{
            overview.healthSource.availability === "available"
              ? t("runnerHealthSource_available")
              : t("runnerHealthSource_unavailable")
          }}
          · {{ healthTime(overview.healthSource.checkedAt) }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.runner-dashboard,
.runner-panel {
  display: grid;
  gap: var(--space-4);
}
</style>
