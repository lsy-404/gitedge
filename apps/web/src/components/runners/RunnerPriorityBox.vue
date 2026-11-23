<script setup lang="ts" generic="T extends string">
import { computed, ref, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import { typeKey } from "../../lib/runner-display";
import NoticeBar from "../NoticeBar.vue";

const props = defineProps<{
  title: string;
  help?: string;
  saved: readonly T[];
  save: (order: T[]) => Promise<void>;
}>();
const { t } = useI18n();

const order = ref([...props.saved]) as Ref<T[]>;
const saving = ref(false);
const error = ref(false);
const dirty = computed(() => order.value.join() !== props.saved.join());

watch(
  () => props.saved,
  (next) => {
    if (!saving.value) order.value = [...next];
  }
);

function move(index: number, offset: -1 | 1): void {
  const target = index + offset;
  if (target < 0 || target >= order.value.length) return;
  const next = [...order.value];
  [next[index], next[target]] = [next[target], next[index]];
  order.value = next;
}

async function submit(): Promise<void> {
  saving.value = true;
  error.value = false;
  try {
    await props.save(order.value);
  } catch {
    error.value = true;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="box priority-box">
    <h3>{{ title }}</h3>
    <p v-if="help" class="row-meta">{{ help }}</p>
    <ol class="priority-list">
      <li v-for="(type, index) in order" :key="type" class="priority-item">
        <span class="priority-rank">{{ index + 1 }}</span>
        <span class="priority-name">{{ t(typeKey(type as never)) }}</span>
        <FluentButton
          type="button"
          tone="subtle"
          :disabled="index === 0"
          :aria-label="`${t('runnerMoveUp')} · ${t(typeKey(type as never))}`"
          @click="move(index, -1)"
          >↑</FluentButton
        >
        <FluentButton
          type="button"
          tone="subtle"
          :disabled="index === order.length - 1"
          :aria-label="`${t('runnerMoveDown')} · ${t(typeKey(type as never))}`"
          @click="move(index, 1)"
          >↓</FluentButton
        >
      </li>
    </ol>
    <NoticeBar v-if="error" intent="error">{{ t("runnerSettingsError") }}</NoticeBar>
    <FluentButton type="button" :disabled="!dirty" :busy="saving" @click="submit">{{
      t("runnerPrioritySave")
    }}</FluentButton>
  </section>
</template>

<style scoped>
.priority-box {
  display: grid;
  justify-items: start;
  gap: var(--space-3);
  padding: var(--space-4);
}
.priority-box h3,
.priority-box p {
  margin: 0;
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
</style>
