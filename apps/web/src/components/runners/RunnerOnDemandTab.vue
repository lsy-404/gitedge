<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  ColabAccount,
  GithubQuota,
  OnDemandRunnerType,
  RunnerOverview,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import HostedRunnerSettings from "../HostedRunnerSettings.vue";
import ColabRunnerCard from "./ColabRunnerCard.vue";
import GithubQuotaCard from "./GithubQuotaCard.vue";
import RunnerPriorityBox from "./RunnerPriorityBox.vue";

const props = defineProps<{ overview: RunnerOverview }>();
const emit = defineEmits<{
  quota: [quota: GithubQuota];
  settings: [settings: RunnerSettings];
  account: [account: ColabAccount | null];
}>();
const { t } = useI18n();
const settings = computed<RunnerSettings>(() => ({
  slotPriority: props.overview.slotPriority,
  onDemandPriority: props.overview.onDemandPriority,
  githubIncludedUsd: props.overview.githubIncludedUsd,
  colabEnabled: props.overview.colab.enabled,
}));

async function savePriority(order: OnDemandRunnerType[]): Promise<void> {
  emit("settings", await api.updateRunnerSettings({ ...settings.value, onDemandPriority: order }));
}
</script>

<template>
  <div class="on-demand">
    <p class="row-meta">{{ t("runnerOnDemandRule") }}</p>
    <RunnerPriorityBox
      :title="t('runnerOnDemandPriorityTitle')"
      :saved="overview.onDemandPriority"
      :save="savePriority"
    />
    <template v-for="type in overview.onDemandPriority" :key="type">
      <template v-if="type === 'github-hosted'">
        <HostedRunnerSettings :connections="overview.github" />
        <GithubQuotaCard
          :quota="overview.githubQuota"
          :settings="settings"
          @quota="emit('quota', $event)"
          @settings="emit('settings', $event)"
        />
      </template>
      <ColabRunnerCard
        v-else-if="type === 'colab'"
        :colab="overview.colab"
        :settings="settings"
        @settings="emit('settings', $event)"
        @account="emit('account', $event)"
      />
    </template>
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
