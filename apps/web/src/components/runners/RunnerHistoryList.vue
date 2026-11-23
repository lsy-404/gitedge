<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { RunnerHistoryItem } from "../../../../../packages/contracts/src/runners";
import { api } from "../../lib/api";
import { jobKey } from "../../lib/runner-display";
import StatusBadge from "../StatusBadge.vue";

const props = defineProps<{
  runnerId: string;
  name: string;
  stats: { success: number; failure: number; cancelled: number };
}>();
const { t, d } = useI18n();
const items = ref<RunnerHistoryItem[] | null>(null);
const next = ref<string | null>(null);
const loading = ref(false);
const failed = ref(false);
let controller: AbortController | null = null;
let disposed = false;

function conclusionText(item: RunnerHistoryItem): string {
  return t(
    `runnerConclusion_${item.conclusion ?? (item.startedAt === null ? "queued" : "running")}`
  );
}

async function load(more = false): Promise<void> {
  if (disposed || loading.value || (more && !next.value)) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  failed.value = false;
  try {
    const page = await api.runnerHistory(
      props.runnerId,
      more ? (next.value ?? undefined) : undefined,
      current.signal
    );
    if (current.signal.aborted || disposed) return;
    items.value = more ? [...(items.value ?? []), ...page.items] : page.items;
    next.value = page.nextBefore;
  } catch {
    if (!current.signal.aborted && !disposed) failed.value = true;
  } finally {
    if (controller === current) controller = null;
    if (!disposed && !current.signal.aborted) loading.value = false;
  }
}

function toggle(event: Event): void {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement)) return;
  if (details.open && items.value === null) void load();
  if (!details.open) {
    controller?.abort();
    loading.value = false;
  }
}

onUnmounted(() => {
  disposed = true;
  controller?.abort();
});
</script>

<template>
  <details class="runner-history" @toggle="toggle">
    <summary>
      {{ name }} · {{ stats.success }} / {{ stats.failure }} / {{ stats.cancelled }}
    </summary>
    <p v-if="failed" class="row-meta">{{ t("runnerHistoryError") }}</p>
    <p v-if="items?.length === 0" class="row-meta">{{ t("runnerHistoryEmpty") }}</p>
    <ul v-if="items?.length" class="settings-list">
      <li v-for="item in items" :key="`${item.kind}:${item.id}`" class="box-row runner-row">
        <div>
          <strong>{{ t(jobKey(item.kind)) }} · {{ item.repository }}</strong>
          <span class="row-meta"
            >{{ item.labels.join(", ") }} ·
            {{ item.startedAt ? d(new Date(item.startedAt), "short") : "—" }}</span
          >
        </div>
        <StatusBadge
          :tone="
            item.conclusion === 'success'
              ? 'success'
              : item.conclusion === 'failure'
                ? 'danger'
                : 'neutral'
          "
          >{{ conclusionText(item) }}</StatusBadge
        >
      </li>
    </ul>
    <FluentButton v-if="next" type="button" tone="subtle" :busy="loading" @click="load(true)">{{
      t("runnerLoadMore")
    }}</FluentButton>
  </details>
</template>

<style scoped>
.runner-history {
  border-top: 1px solid var(--border-default);
  padding: var(--space-2) 0;
}
.runner-history summary {
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
}
.runner-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-3);
}
.runner-row > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
@media (max-width: 640px) {
  .runner-row {
    flex-direction: column;
  }
}
</style>
