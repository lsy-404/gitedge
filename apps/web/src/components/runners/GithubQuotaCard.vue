<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { GithubQuota, RunnerSettings } from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import NoticeBar from "../NoticeBar.vue";
import StatusBadge from "../StatusBadge.vue";

const props = defineProps<{
  quota: GithubQuota;
  settings: RunnerSettings;
}>();
const emit = defineEmits<{
  quota: [quota: GithubQuota];
  settings: [settings: RunnerSettings];
}>();
const { t, d } = useI18n();

const included = ref(props.settings.githubIncludedUsd?.toString() ?? "");
const refreshing = ref(false);
const saving = ref(false);
const refreshError = ref(false);
const saveError = ref(false);

watch(
  () => props.settings.githubIncludedUsd,
  (value) => {
    if (!saving.value) included.value = value?.toString() ?? "";
  }
);

const tone = (state: GithubQuota["state"]): "success" | "warning" | "danger" =>
  state === "ok" ? "success" : state === "exhausted" ? "warning" : "danger";
const usd = (value: number): string => `$${value.toFixed(2)}`;

async function refresh(): Promise<void> {
  refreshing.value = true;
  refreshError.value = false;
  try {
    emit("quota", await api.refreshGithubQuota());
  } catch {
    refreshError.value = true;
  } finally {
    refreshing.value = false;
  }
}

async function save(): Promise<void> {
  const text = String(included.value).trim();
  const value = text === "" ? null : Number(text);
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    saveError.value = true;
    return;
  }
  saving.value = true;
  saveError.value = false;
  try {
    emit(
      "settings",
      await api.updateRunnerSettings({ ...props.settings, githubIncludedUsd: value })
    );
  } catch {
    saveError.value = true;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="box quota-card">
    <header class="quota-header">
      <h3>{{ t("githubQuotaTitle") }}</h3>
      <StatusBadge :tone="tone(quota.state)">{{
        t(`githubQuotaState_${quota.state.replaceAll("-", "_")}`)
      }}</StatusBadge>
    </header>
    <NoticeBar v-if="quota.state === 'no-token'" intent="warning">{{
      t("githubQuotaNoToken")
    }}</NoticeBar>
    <NoticeBar v-else-if="quota.state === 'forbidden'" intent="warning">{{
      t("githubQuotaForbidden")
    }}</NoticeBar>
    <NoticeBar v-else-if="quota.state === 'error' && quota.message" intent="error">{{
      quota.message
    }}</NoticeBar>
    <dl class="quota-figures">
      <div>
        <dt>{{ t("githubQuotaUsed") }}</dt>
        <dd>{{ usd(quota.includedUsedUsd) }}</dd>
      </div>
      <div>
        <dt>{{ t("githubQuotaPaid") }}</dt>
        <dd>{{ usd(quota.paidUsd) }}</dd>
      </div>
      <div v-for="item in quota.minutes" :key="item.sku">
        <dt>{{ item.sku }} · {{ t("githubQuotaMinutes") }}</dt>
        <dd>{{ item.minutes }}</dd>
      </div>
      <div>
        <dt>{{ t("githubQuotaChecked") }}</dt>
        <dd>{{ quota.checkedAt ? d(new Date(quota.checkedAt), "short") : "—" }}</dd>
      </div>
    </dl>
    <NoticeBar v-if="refreshError" intent="error">{{ t("githubQuotaRefreshError") }}</NoticeBar>
    <FluentButton type="button" tone="subtle" :busy="refreshing" @click="refresh">{{
      t("githubQuotaRefresh")
    }}</FluentButton>
    <form class="quota-form" @submit.prevent="save">
      <label for="github-included-usd">{{ t("githubQuotaIncluded") }}</label>
      <div class="quota-form-row">
        <input
          id="github-included-usd"
          v-model="included"
          type="number"
          inputmode="decimal"
          min="0"
          step="any"
          :placeholder="t('githubQuotaIncludedHint')"
        />
        <FluentButton type="submit" :busy="saving">{{ t("githubQuotaSave") }}</FluentButton>
      </div>
      <p v-if="saveError" class="row-meta" role="alert">{{ t("runnerSettingsError") }}</p>
    </form>
  </section>
</template>

<style scoped>
.quota-card {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-4);
}
.quota-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.quota-header h3,
.quota-form p {
  margin: 0;
}
.quota-figures {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: var(--space-2) var(--space-4);
  width: 100%;
  margin: 0;
}
.quota-figures dt {
  color: var(--fg-muted);
}
.quota-figures dd {
  margin: 0;
  font-weight: var(--font-weight-semibold);
}
.quota-form {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  max-width: 24rem;
}
.quota-form-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.quota-form-row input {
  flex: 1 1 8rem;
}
</style>
