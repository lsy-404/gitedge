<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  ColabDispatchState,
  RunnerOverviewColab,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import { COLAB_WAKER_STALE_MS } from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import type { BadgeTone } from "../../lib/runner-display";
import NoticeBar from "../NoticeBar.vue";
import StatusBadge from "../StatusBadge.vue";

const props = defineProps<{
  colab: RunnerOverviewColab;
  settings: RunnerSettings;
  generatedAt: number;
}>();
const emit = defineEmits<{ settings: [settings: RunnerSettings] }>();
const { t, d } = useI18n();
const saving = ref(false);
const error = ref(false);

const online = (lastSeenAt: number): boolean =>
  props.generatedAt - lastSeenAt < COLAB_WAKER_STALE_MS;
const tone = (state: ColabDispatchState): BadgeTone =>
  state === "finished"
    ? "success"
    : state === "failed"
      ? "danger"
      : state === "cancelled"
        ? "neutral"
        : state === "running"
          ? "brand"
          : "warning";

async function toggle(): Promise<void> {
  saving.value = true;
  error.value = false;
  try {
    emit(
      "settings",
      await api.updateRunnerSettings({ ...props.settings, colabEnabled: !props.colab.enabled })
    );
  } catch {
    error.value = true;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="box colab-card">
    <header class="colab-header">
      <h3>{{ t("colabTitle") }}</h3>
      <StatusBadge :tone="colab.enabled ? 'success' : 'neutral'">{{
        colab.enabled ? t("colabEnabled") : t("colabDisabled")
      }}</StatusBadge>
    </header>
    <p class="row-meta">{{ t("colabDescription") }}</p>
    <NoticeBar v-if="error" intent="error">{{ t("runnerSettingsError") }}</NoticeBar>
    <FluentButton
      type="button"
      :tone="colab.enabled ? 'subtle' : undefined"
      :busy="saving"
      @click="toggle"
      >{{ colab.enabled ? t("colabDisable") : t("colabEnable") }}</FluentButton
    >
    <h4>{{ t("colabWakers") }}</h4>
    <p v-if="colab.wakers.length === 0" class="row-meta">{{ t("colabNoWakers") }}</p>
    <ul v-else class="colab-list">
      <li v-for="waker in colab.wakers" :key="waker.runnerId">
        <span>{{ waker.name }}</span>
        <StatusBadge :tone="online(waker.lastSeenAt) ? 'success' : 'danger'">{{
          online(waker.lastSeenAt) ? t("colabWakerOnline") : t("colabWakerOffline")
        }}</StatusBadge>
        <span class="row-meta">{{ d(new Date(waker.lastSeenAt), "short") }}</span>
      </li>
    </ul>
    <h4>{{ t("colabRecent") }}</h4>
    <p v-if="colab.recent.length === 0" class="row-meta">{{ t("colabNoRecent") }}</p>
    <ul v-else class="colab-list">
      <li v-for="item in colab.recent" :key="`${item.jobId}-${item.createdAt}`">
        <StatusBadge :tone="tone(item.state)">{{ t(`colabState_${item.state}`) }}</StatusBadge>
        <code>{{ item.jobId }}</code>
        <span class="row-meta">{{ d(new Date(item.createdAt), "short") }}</span>
        <span v-if="item.error" class="row-meta">{{ item.error }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.colab-card {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-4);
}
.colab-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.colab-card h3,
.colab-card h4,
.colab-card p {
  margin: 0;
}
.colab-card h4 {
  font-size: var(--font-size-body);
}
.colab-list {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}
.colab-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.colab-list code {
  overflow-wrap: anywhere;
}
</style>
