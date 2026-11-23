<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  GithubQuota,
  RunnerOverview,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import HostedRunnerSettings from "../HostedRunnerSettings.vue";
import ColabRunnerCard from "./ColabRunnerCard.vue";
import GithubQuotaCard from "./GithubQuotaCard.vue";

const props = defineProps<{ overview: RunnerOverview }>();
defineEmits<{ quota: [quota: GithubQuota]; settings: [settings: RunnerSettings] }>();
const { t } = useI18n();
const settings = computed<RunnerSettings>(() => ({
  typePriority: props.overview.typePriority,
  githubIncludedUsd: props.overview.githubIncludedUsd,
  colabEnabled: props.overview.colab.enabled,
}));
</script>

<template>
  <div class="on-demand">
    <p class="row-meta">{{ t("runnerOnDemandRule") }}</p>
    <HostedRunnerSettings :connections="overview.github" />
    <GithubQuotaCard
      :quota="overview.githubQuota"
      :settings="settings"
      @quota="$emit('quota', $event)"
      @settings="$emit('settings', $event)"
    />
    <p class="row-meta">{{ t("colabTierRule") }}</p>
    <ColabRunnerCard
      :colab="overview.colab"
      :settings="settings"
      :generated-at="overview.generatedAt"
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
