<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { api } from "../lib/api";
import AuditLogList from "./AuditLogList.vue";

const { t } = useI18n();
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsActivity") }}</h2>
        <p>{{ t("auditAccountHint") }}</p>
      </div>
    </header>
    <section class="box" aria-labelledby="activity-title">
      <header class="box-header">
        <h3 id="activity-title">{{ t("auditLogTitle") }}</h3>
      </header>
      <AuditLogList :load="(cursor) => api.accountAuditLog(cursor)" reload-key="account" />
    </section>
  </section>
</template>
