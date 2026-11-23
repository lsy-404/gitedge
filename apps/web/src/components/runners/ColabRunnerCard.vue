<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField } from "@platform-kit/fluent/vue";
import type {
  ColabAccount,
  ColabDispatchState,
  RunnerOverviewColab,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import type { BadgeTone } from "../../lib/runner-display";
import NoticeBar from "../NoticeBar.vue";
import StatusBadge from "../StatusBadge.vue";

const props = defineProps<{
  colab: RunnerOverviewColab;
  settings: RunnerSettings;
}>();
const emit = defineEmits<{
  settings: [settings: RunnerSettings];
  account: [account: ColabAccount | null];
}>();
const { t, d } = useI18n();
const saving = ref(false);
const error = ref(false);

const code = ref("");
const awaitingCode = ref(false);
const accountBusy = ref(false);
const accountError = ref(false);

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

async function connect(): Promise<void> {
  accountBusy.value = true;
  accountError.value = false;
  try {
    const { url } = await api.startColabAuthorization();
    window.open(url, "_blank", "noopener");
    awaitingCode.value = true;
  } catch {
    accountError.value = true;
  } finally {
    accountBusy.value = false;
  }
}

async function submitCode(): Promise<void> {
  accountBusy.value = true;
  accountError.value = false;
  try {
    emit("account", await api.connectColabAccount(code.value.trim()));
    code.value = "";
    awaitingCode.value = false;
  } catch {
    accountError.value = true;
  } finally {
    accountBusy.value = false;
  }
}

async function disconnect(): Promise<void> {
  accountBusy.value = true;
  accountError.value = false;
  try {
    await api.disconnectColabAccount();
    emit("account", null);
  } catch {
    accountError.value = true;
  } finally {
    accountBusy.value = false;
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
    <h4>{{ t("colabAccount") }}</h4>
    <NoticeBar v-if="accountError" intent="error">{{ t("colabAccountError") }}</NoticeBar>
    <template v-if="colab.account">
      <NoticeBar v-if="colab.account.error" intent="error">{{
        t("colabAccountReconnect")
      }}</NoticeBar>
      <p>{{ colab.account.email }}</p>
      <p v-if="colab.account.balance !== null" class="row-meta">
        {{ t("colabBalance", { balance: colab.account.balance.toFixed(1) }) }}
        <template v-if="colab.account.rateHourly">{{
          t("colabRate", { rate: colab.account.rateHourly.toFixed(2) })
        }}</template>
      </p>
      <FluentButton type="button" tone="subtle" :busy="accountBusy" @click="disconnect">{{
        t("colabDisconnect")
      }}</FluentButton>
    </template>
    <form v-else-if="awaitingCode" class="colab-code" @submit.prevent="submitCode">
      <FluentField v-model="code" :label="t('colabCodeLabel')" required minlength="10" />
      <FluentButton type="submit" :busy="accountBusy">{{ t("colabCodeSubmit") }}</FluentButton>
    </form>
    <FluentButton v-else type="button" :busy="accountBusy" @click="connect">{{
      t("colabConnect")
    }}</FluentButton>
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
.colab-code {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  max-width: 28rem;
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
