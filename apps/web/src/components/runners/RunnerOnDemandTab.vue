<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type {
  GithubQuota,
  RunnerOverview,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import HostedRunnerSettings from "../HostedRunnerSettings.vue";
import GithubQuotaCard from "./GithubQuotaCard.vue";

defineProps<{ overview: RunnerOverview }>();
defineEmits<{ quota: [quota: GithubQuota]; settings: [settings: RunnerSettings] }>();
const { t } = useI18n();
</script>

<template>
  <div class="on-demand">
    <p class="row-meta">{{ t("runnerOnDemandRule") }}</p>
    <HostedRunnerSettings :connections="overview.github" />
    <GithubQuotaCard
      :quota="overview.githubQuota"
      :settings="{
        typePriority: overview.typePriority,
        githubIncludedUsd: overview.githubIncludedUsd,
      }"
      @quota="$emit('quota', $event)"
      @settings="$emit('settings', $event)"
    />
  </div>
</template>

<style scoped>
.on-demand {
  display: grid;
  gap: var(--space-4);
}
.on-demand p {
  margin: 0;
}
</style>
