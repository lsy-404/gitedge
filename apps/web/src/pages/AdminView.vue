<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { sessionState } from "../lib/session";
import AdminOverview from "../components/AdminOverview.vue";
import AdminRepositories from "../components/AdminRepositories.vue";
import AdminUsers from "../components/AdminUsers.vue";
import NoticeBar from "../components/NoticeBar.vue";
import "../styles/workspace.css";

const { t } = useI18n();
const route = useRoute();
const tabs = ["overview", "users", "repositories"] as const;
const tab = computed(() => tabs.find((value) => value === route.query.tab) ?? "overview");
const allowed = computed(() => sessionState.user?.siteAdmin === true);
</script>

<template>
  <section class="workspace-page admin-page">
    <header class="workspace-page-heading">
      <div>
        <h1>{{ t("adminTitle") }}</h1>
        <p class="muted">{{ t("adminIntro") }}</p>
      </div>
    </header>
    <NoticeBar v-if="!allowed" intent="error">{{ t("adminForbidden") }}</NoticeBar>
    <template v-else>
      <nav class="admin-tabs" :aria-label="t('adminNavigation')">
        <RouterLink
          v-for="value in tabs"
          :key="value"
          class="btn btn-sm"
          :to="{ path: '/admin', query: { tab: value } }"
          :aria-current="tab === value ? 'page' : undefined"
          >{{ t(`adminTab_${value}`) }}</RouterLink
        >
      </nav>
      <AdminOverview v-if="tab === 'overview'" />
      <AdminUsers v-else-if="tab === 'users'" />
      <AdminRepositories v-else />
    </template>
  </section>
</template>

<style scoped>
.admin-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
</style>
