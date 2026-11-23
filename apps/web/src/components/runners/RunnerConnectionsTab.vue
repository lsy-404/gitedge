<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { RunnerOverviewGithubConnection } from "../../../../../packages/contracts/src/runners";

defineProps<{ connections: RunnerOverviewGithubConnection[] }>();
const { t, d } = useI18n();
</script>

<template>
  <section class="box runner-section">
    <h3>{{ t("runnerConnection") }}</h3>
    <p v-if="connections.length === 0" class="empty-state">{{ t("runnerNoConnections") }}</p>
    <ul class="settings-list">
      <li
        v-for="connection in connections"
        :key="connection.connectionId"
        class="box-row settings-item"
      >
        <div class="settings-item-copy">
          <div class="row-title">{{ connection.repository }} · {{ connection.remote }}</div>
          <div class="row-meta">
            {{
              connection.errorCode
                ? t("runnerSyncErrorCode", { code: connection.errorCode })
                : connection.enabled
                  ? t("settingsActive")
                  : t("runnerConnectionDisabled")
            }}
            · {{ t("runnerFailureCount", { count: connection.failureCount }) }} ·
            {{ t("runnerQueue") }}: {{ connection.queued }} ·
            {{ t("runnerPendingCleanup", { count: connection.pendingCleanup }) }}
          </div>
          <div class="row-meta">
            {{ t("runnerLastSynced") }}:
            {{ connection.lastSyncedAt ? d(new Date(connection.lastSyncedAt), "short") : "—" }}
            · {{ t("runnerLastJob") }}:
            {{ connection.lastJobAt ? d(new Date(connection.lastJobAt), "short") : "—" }}
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.runner-section {
  padding: var(--space-4);
}
.runner-section h3 {
  margin: 0 0 var(--space-2);
  font-size: 1rem;
}
.empty-state {
  color: var(--fg-muted);
}
</style>
