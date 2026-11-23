<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type {
  RunnerOverview,
  RunnerOverviewRunner,
} from "../../../../../packages/contracts/src/runners";
import { jobKey } from "../../lib/runner-display";
import StatusBadge from "../StatusBadge.vue";
import RunnerHistoryList from "./RunnerHistoryList.vue";

const props = defineProps<{ overview: RunnerOverview }>();
const { t, d } = useI18n();

const queueAge = computed(() => {
  const oldest = props.overview.queue[0]?.createdAt;
  return oldest === undefined ? null : Math.max(0, Date.now() - oldest);
});

const counts = computed(() => {
  const count = (...states: RunnerOverviewRunner["state"][]): number =>
    props.overview.runners.filter((runner) => states.includes(runner.state)).length;
  return {
    online: count("idle", "busy"),
    busy: count("busy"),
    held: count("held"),
    offline: count("offline"),
  };
});

function reasonText(code: string): string {
  const [kind, detail] = code.split(":", 2);
  const key = `runnerReason_${kind.replaceAll("-", "_")}`;
  if (kind === "label") return t(key, { label: detail });
  if (kind === "tool") return t(key, { tool: detail });
  return t(key);
}
</script>

<template>
  <div class="runner-activity">
    <div class="runner-summary" :aria-label="t('runnerTab_activity')">
      <span
        >{{ t("runnerOnline") }} <strong>{{ counts.online }}</strong></span
      >
      <span
        >{{ t("runnerBusy") }} <strong>{{ counts.busy }}</strong></span
      >
      <span
        >{{ t("runnerHeld") }} <strong>{{ counts.held }}</strong></span
      >
      <span
        >{{ t("runnerOffline") }} <strong>{{ counts.offline }}</strong></span
      >
      <span
        >{{ t("runnerQueue") }} <strong>{{ overview.queue.length }}</strong></span
      >
      <span v-if="queueAge !== null"
        >{{ t("runnerOldestQueue") }} <strong>{{ Math.floor(queueAge / 60_000) }}m</strong></span
      >
    </div>

    <section class="box runner-section">
      <h3>{{ t("runnerQueueTitle") }}</h3>
      <p v-if="overview.queue.length === 0" class="empty-state">{{ t("runnerQueue") }} · 0</p>
      <ul class="settings-list">
        <li
          v-for="job in overview.queue"
          :key="`${job.kind}:${job.id}`"
          class="box-row runner-queue-item"
        >
          <div>
            <strong>{{ t(jobKey(job.kind)) }} · {{ job.repository }}</strong>
            <div class="row-meta">
              {{ job.labels.join(", ") }} · {{ d(new Date(job.createdAt), "short") }}
            </div>
            <div class="runner-claim">
              <strong>{{ t("runnerClaim") }}:</strong>
              <span>{{
                t("runnerClaimMemory", {
                  value:
                    job.claim.memMb >= 1024
                      ? `${job.claim.memMb / 1024} GB`
                      : `${job.claim.memMb} MB`,
                })
              }}</span>
              <span>{{ t("runnerClaimCpu", { value: job.claim.cpus }) }}</span>
              <span v-if="job.claim.diskMb">{{
                t("runnerClaimDisk", { value: `${job.claim.diskMb} MB` })
              }}</span>
              <span v-if="job.claim.gpuVendor || job.claim.vramMb">{{
                t("runnerClaimGpu", {
                  value: job.claim.gpuVendor?.toUpperCase() ?? t("runnerGpuAny"),
                })
              }}</span>
              <span v-if="job.claim.vramMb">{{
                t("runnerClaimVram", { value: `${job.claim.vramMb} MiB` })
              }}</span>
              <span v-if="job.claim.tools.length">{{
                t("runnerClaimTools", { value: job.claim.tools.join(", ") })
              }}</span>
              <span>{{ t("runnerClaimTime", { value: job.claim.minutes }) }}</span>
            </div>
            <div v-if="Object.keys(job.blockedBy).length" class="runner-reasons">
              <strong>{{ t("runnerBlockedBy") }}</strong
              ><span v-for="[id, reasons] in Object.entries(job.blockedBy)" :key="id"
                >{{ overview.runners.find((runner) => runner.id === id)?.name ?? id }}:
                {{ reasons.map(reasonText).join(", ") }}</span
              >
            </div>
          </div>
          <StatusBadge>{{ t(jobKey(job.kind)) }}</StatusBadge>
        </li>
      </ul>
    </section>

    <section class="box runner-section">
      <h3>{{ t("runnerRecentRuns") }}</h3>
      <p v-if="overview.runners.length === 0" class="empty-state">{{ t("runnerEmpty") }}</p>
      <RunnerHistoryList
        v-for="runner in overview.runners"
        :key="runner.id"
        :runner-id="runner.id"
        :name="runner.name"
        :stats="runner.stats24h"
      />
    </section>
  </div>
</template>

<style scoped>
.runner-activity {
  display: grid;
  gap: var(--space-4);
}
.runner-summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-5);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.runner-summary span {
  display: flex;
  gap: var(--space-2);
}
.runner-section {
  padding: var(--space-4);
}
.runner-section h3 {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
}
.runner-queue-item {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: flex-start;
}
.runner-queue-item > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.runner-claim {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.runner-reasons {
  display: grid;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
.empty-state {
  color: var(--fg-muted);
}
@media (max-width: 640px) {
  .runner-queue-item {
    flex-direction: column;
  }
}
</style>
