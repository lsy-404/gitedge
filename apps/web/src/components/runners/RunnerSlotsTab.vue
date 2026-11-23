<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import {
  RUNNER_TYPES,
  type RunnerOverview,
  type RunnerSettings,
  type RunnerType,
} from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import { availableSlots, typeKey } from "../../lib/runner-display";
import NoticeBar from "../NoticeBar.vue";
import RunnerCard from "./RunnerCard.vue";

const props = defineProps<{ overview: RunnerOverview }>();
const emit = defineEmits<{
  labels: [id: string, labels: string[]];
  type: [id: string, type: "owned" | "rented"];
  removed: [id: string];
  settings: [settings: RunnerSettings];
}>();
const { t } = useI18n();

const order = ref<RunnerType[]>([...props.overview.typePriority]);
const saving = ref(false);
const error = ref(false);
const dirty = computed(() => order.value.join() !== props.overview.typePriority.join());

watch(
  () => props.overview.typePriority,
  (next) => {
    if (!saving.value) order.value = [...next];
  }
);

const groups = computed(() =>
  RUNNER_TYPES.map((type) => ({
    type,
    runners: props.overview.runners.filter((runner) => runner.type === type),
    available: availableSlots(props.overview.runners, type),
  }))
);

function move(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= order.value.length) return;
  const next = [...order.value];
  [next[index], next[target]] = [next[target], next[index]];
  order.value = next;
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = false;
  try {
    const result = await api.updateRunnerSettings({
      typePriority: order.value,
      githubIncludedUsd: props.overview.githubIncludedUsd,
    });
    emit("settings", result);
  } catch {
    error.value = true;
  } finally {
    saving.value = false;
  }
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

    <section class="box runner-section">
      <h3>{{ t("runnerPriorityTitle") }}</h3>
      <p class="row-meta">{{ t("runnerPriorityHelp") }}</p>
      <ol class="priority-list">
        <li v-for="(type, index) in order" :key="type" class="priority-item">
          <span class="priority-rank">{{ index + 1 }}</span>
          <span class="priority-name">{{ t(typeKey(type)) }}</span>
          <FluentButton
            type="button"
            tone="subtle"
            :disabled="index === 0"
            :aria-label="`${t('runnerMoveUp')} · ${t(typeKey(type))}`"
            @click="move(index, -1)"
            >↑</FluentButton
          >
          <FluentButton
            type="button"
            tone="subtle"
            :disabled="index === order.length - 1"
            :aria-label="`${t('runnerMoveDown')} · ${t(typeKey(type))}`"
            @click="move(index, 1)"
            >↓</FluentButton
          >
        </li>
      </ol>
      <NoticeBar v-if="error" intent="error">{{ t("runnerSettingsError") }}</NoticeBar>
      <FluentButton type="button" :disabled="!dirty" :busy="saving" @click="save">{{
        t("runnerPrioritySave")
      }}</FluentButton>
    </section>

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
.runner-section {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-4);
}
.runner-section h3,
.runner-section p,
.group-title {
  margin: 0;
}
.group-title {
  padding: var(--space-3) var(--space-4) 0;
  font-size: 1rem;
}
.priority-list {
  display: grid;
  gap: var(--space-2);
  width: 100%;
  max-width: 28rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.priority-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.priority-rank {
  color: var(--fg-muted);
}
.priority-name {
  flex: 1;
}
.empty-state {
  padding: 0 var(--space-4) var(--space-4);
  color: var(--fg-muted);
}
</style>
