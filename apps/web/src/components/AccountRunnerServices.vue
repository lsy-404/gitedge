<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRouter } from "vue-router";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const { t } = useI18n();
const router = useRouter();
const repository = ref<Repository | null>(null);
const loading = ref(true);
const creating = ref(false);
const error = ref("");
let controller: AbortController | null = null;
let disposed = false;

function repositoryPath(section: "code" | "actions" | "settings"): string {
  const current = repository.value;
  return current
    ? `/${encodeURIComponent(current.owner)}/${encodeURIComponent(current.slug)}/${section}`
    : "/";
}

function workflowDirectoryPath(): string {
  const current = repository.value;
  return current
    ? `/${encodeURIComponent(current.owner)}/${encodeURIComponent(current.slug)}/tree/.github/workflows`
    : "/";
}

async function load(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.accountRunner(current.signal);
    if (!current.signal.aborted) repository.value = result.repository;
  } catch (cause) {
    if (!current.signal.aborted) error.value = errorMessage(cause, t);
  } finally {
    if (controller === current) controller = null;
    if (!disposed && !current.signal.aborted) loading.value = false;
  }
}

async function create(): Promise<void> {
  creating.value = true;
  error.value = "";
  try {
    repository.value = await api.createAccountRunner();
    await router.push(repositoryPath("actions"));
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    creating.value = false;
  }
}

onMounted(() => void load());
onUnmounted(() => {
  disposed = true;
  controller?.abort();
});
</script>

<template>
  <section class="box account-runner-services" :aria-label="t('accountRunnerTitle')">
    <header class="account-runner-services-header">
      <div>
        <h3>{{ t("accountRunnerTitle") }}</h3>
        <p>{{ t("accountRunnerDescription") }}</p>
      </div>
      <FluentButton
        v-if="!loading && !repository && !error"
        type="button"
        :busy="creating"
        :disabled="creating"
        @click="create"
        >{{ t("accountRunnerCreate") }}</FluentButton
      >
      <FluentButton
        v-else-if="error && !repository"
        type="button"
        tone="subtle"
        :busy="loading"
        @click="load"
        >{{ t("retry") }}</FluentButton
      >
    </header>

    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <NoticeBar v-else-if="error" intent="error">{{ error }}</NoticeBar>
    <div v-else-if="repository" class="account-runner-service-state">
      <div>
        <strong>{{ repository.owner }}/{{ repository.name }}</strong>
        <p>{{ t("accountRunnerPrivateLock") }}</p>
      </div>
      <nav :aria-label="t('accountRunnerLinks')">
        <RouterLink class="btn btn-sm" :to="repositoryPath('code')">{{
          t("accountRunnerOpenCode")
        }}</RouterLink>
        <RouterLink class="btn btn-sm" :to="repositoryPath('actions')">{{
          t("accountRunnerOpenActions")
        }}</RouterLink>
        <RouterLink class="btn btn-sm" :to="workflowDirectoryPath()">{{
          t("accountRunnerEditWorkflows")
        }}</RouterLink>
        <RouterLink class="btn btn-sm" :to="repositoryPath('settings')">{{
          t("accountRunnerSettings")
        }}</RouterLink>
      </nav>
      <p class="muted">{{ t("accountRunnerServiceScope") }}</p>
    </div>
    <p v-else class="empty-state">{{ t("accountRunnerEmpty") }}</p>
  </section>
</template>

<style scoped>
.account-runner-services-header,
.account-runner-service-state {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.account-runner-services-header h3,
.account-runner-services-header p,
.account-runner-service-state p {
  margin-top: 0;
}

.account-runner-service-state {
  flex-direction: column;
}

.account-runner-service-state nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
