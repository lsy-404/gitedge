<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  RegisteredRunnerType,
  RunnerOverview,
  RunnerSettings,
} from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import { availableSlots, typeKey } from "../../lib/runner-display";
import RunnerPriorityBox from "./RunnerPriorityBox.vue";
import RunnerCard from "./RunnerCard.vue";

const props = defineProps<{ overview: RunnerOverview }>();
const emit = defineEmits<{
  labels: [id: string, labels: string[]];
  type: [id: string, type: "owned" | "rented"];
  removed: [id: string];
  settings: [settings: RunnerSettings];
}>();
const { t } = useI18n();

const groups = computed(() =>
  props.overview.slotPriority.map((type) => ({
    type,
    runners: props.overview.runners.filter((runner) => runner.type === type),
    available: availableSlots(props.overview.runners, type),
  }))
);

async function savePriority(order: RegisteredRunnerType[]): Promise<void> {
  emit(
    "settings",
    await api.updateRunnerSettings({
      slotPriority: order,
      onDemandPriority: props.overview.onDemandPriority,
      githubIncludedUsd: props.overview.githubIncludedUsd,
      colabEnabled: props.overview.colab.enabled,
    })
  );
}
</script>

<template>
  <div class="runner-slots">
    <ul class="slot-strip" :aria-label="t('runnerAvailableSlots')">
      <li v-for="group in groups" :key="group.type">
        <span>{{ t(typeKey(group.type)) }}</span>
        <strong>{{ group.available }}</strong>
      </li>
    </ul>

    <RunnerPriorityBox
      :title="t('runnerSlotPriorityTitle')"
      :help="t('runnerSlotPriorityHelp')"
      :saved="overview.slotPriority"
      :save="savePriority"
    />

    <section v-for="group in groups" :key="group.type" class="box">
      <h3 class="group-title">{{ t(typeKey(group.type)) }}</h3>
      <p v-if="group.runners.length === 0" class="empty-state">{{ t("runnerGroupEmpty") }}</p>
      <RunnerCard
        v-for="runner in group.runners"
        :key="runner.id"
        :runner="runner"
        @labels="(id, labels) => emit('labels', id, labels)"
        @type="(id, type) => emit('type', id, type)"
        @removed="(id) => emit('removed', id)"
      />
    </section>
  </div>
</template>

<style scoped>
.runner-slots {
  display: grid;
  gap: var(--space-4);
}
.slot-strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  margin: 0;
  padding: var(--space-3) var(--space-4);
  list-style: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.slot-strip li {
  display: flex;
  gap: var(--space-2);
}
.group-title {
  margin: 0;
  padding: var(--space-3) var(--space-4) 0;
  font-size: 1rem;
}
.empty-state {
  padding: 0 var(--space-4) var(--space-4);
  color: var(--fg-muted);
}
</style>
