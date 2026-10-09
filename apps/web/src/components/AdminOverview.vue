<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminStats } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import StatusState from "./StatusState.vue";

const { t } = useI18n();
const stats = ref<AdminStats | null>(null);
const loading = ref(true);
const error = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    stats.value = await api.adminStats();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="box" aria-labelledby="admin-stats-title">
    <header class="box-header">
      <h2 id="admin-stats-title">{{ t("adminStats") }}</h2>
    </header>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <dl v-else-if="stats" class="admin-stats">
      <div>
        <dt>{{ t("adminStatUsers") }}</dt>
        <dd>{{ stats.users.total }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatDisabled") }}</dt>
        <dd>{{ stats.users.disabled }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatDeleted") }}</dt>
        <dd>{{ stats.users.deleted }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatOrganizations") }}</dt>
        <dd>{{ stats.organizations }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatPublic") }}</dt>
        <dd>{{ stats.repositories.public }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatPrivate") }}</dt>
        <dd>{{ stats.repositories.private }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatRemoved") }}</dt>
        <dd>{{ stats.repositories.deleted }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatInvitations") }}</dt>
        <dd>{{ stats.pendingInvitations }}</dd>
      </div>
      <div>
        <dt>{{ t("adminStatAudit") }}</dt>
        <dd>{{ stats.auditEventsLast24Hours }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.admin-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-4);
  margin: 0;
  padding: var(--space-4);
}
.admin-stats dt {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.admin-stats dd {
  margin: 0;
  font-size: var(--font-size-section);
  font-weight: var(--font-weight-semibold);
}
</style>
