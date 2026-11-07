<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  HostedRunnerSettings,
  RunnerOverviewGithubConnection,
} from "../../../../packages/contracts/src/runners";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";

const props = defineProps<{ connections: RunnerOverviewGithubConnection[] }>();
const { t } = useI18n();
const settings = ref<HostedRunnerSettings | null>(null);
const selected = ref("");
const confirmed = ref(false);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const connections = computed(() => props.connections.filter((connection) => connection.enabled));
const repositoryUrl = computed(() =>
  settings.value
    ? `https://github.com/${settings.value.repository.split("/").map(encodeURIComponent).join("/")}`
    : ""
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    settings.value = (await api.hostedRunnerSettings()).settings;
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

async function save(enable: boolean): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    if (enable) {
      await api.enableHostedRunner(selected.value);
      settings.value = (await api.hostedRunnerSettings()).settings;
    } else {
      await api.disableHostedRunner();
      settings.value = null;
      confirmed.value = false;
    }
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
onMounted(() => void load());
</script>

<template>
  <section class="box hosted-runner">
    <h3>{{ t("hostedRunnerTitle") }}</h3>
    <p>{{ t("hostedRunnerDescription") }}</p>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <template v-if="!loading && !error">
      <template v-if="settings">
        <p>
          {{ t("hostedRunnerEnabled") }} ·
          <a :href="repositoryUrl" target="_blank" rel="noopener noreferrer">{{
            settings.repository
          }}</a>
        </p>
        <FluentButton type="button" tone="subtle" :busy="busy" @click="save(false)">{{
          t("hostedRunnerDisable")
        }}</FluentButton>
      </template>
      <template v-else>
        <p v-if="!connections.length">{{ t("hostedRunnerNoConnections") }}</p>
        <template v-else>
          <label for="hosted-runner-connection">{{ t("hostedRunnerConnection") }}</label>
          <select id="hosted-runner-connection" v-model="selected">
            <option value="" disabled>{{ t("hostedRunnerChooseConnection") }}</option>
            <option
              v-for="connection in connections"
              :key="connection.connectionId"
              :value="connection.connectionId"
            >
              {{ connection.remote }}
            </option>
          </select>
          <label
            ><input v-model="confirmed" type="checkbox" />
            {{ t("hostedRunnerBudgetConfirmation") }}</label
          >
          <FluentButton
            type="button"
            :disabled="!selected || !confirmed"
            :busy="busy"
            @click="save(true)"
            >{{ t("hostedRunnerEnable") }}</FluentButton
          >
        </template>
      </template>
    </template>
    <FluentButton v-if="error" type="button" tone="subtle" @click="load">{{
      t("retry")
    }}</FluentButton>
  </section>
</template>

<style scoped>
.hosted-runner {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
  padding: 1rem;
}
.hosted-runner h3,
.hosted-runner p {
  margin: 0;
}
</style>
