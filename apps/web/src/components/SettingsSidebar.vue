<script setup lang="ts">
import { useI18n } from "vue-i18n";
import AppIcon from "./AppIcon.vue";

/** `active` is an account section key or "agents". */
defineProps<{ active: string }>();
const { t } = useI18n();
const items = [
  { key: "profile", label: "settingsProfile", icon: "person" },
  { key: "preferences", label: "settingsPreferences", icon: "gear" },
  { key: "tokens", label: "patSettings", icon: "lock" },
  { key: "security", label: "settingsSecurity", icon: "shield" },
  { key: "credentials", label: "settingsCredentials", icon: "lock" },
  { key: "signing", label: "settingsSigning", icon: "checkCircle" },
  { key: "sessions", label: "settingsSessions", icon: "clock" },
  { key: "usage", label: "settingsUsage", icon: "activity" },
  { key: "activity", label: "settingsActivity", icon: "clock" },
  { key: "data", label: "settingsData", icon: "download" },
  { key: "connections", label: "settingsConnections", icon: "link" },
] as const;
</script>

<template>
  <aside class="settings-sidebar">
    <h1>{{ t("settings") }}</h1>
    <p class="settings-sidebar-label">{{ t("personalSettings") }}</p>
    <nav class="settings-nav" :aria-label="t('settingsNavigation')">
      <RouterLink
        v-for="item in items"
        :key="item.key"
        class="settings-nav-item"
        :to="{ path: '/settings/account', query: { section: item.key } }"
        :aria-current="active === item.key ? 'page' : undefined"
        ><AppIcon :name="item.icon" />{{ t(item.label) }}</RouterLink
      >
      <RouterLink
        class="settings-nav-item"
        to="/settings/agents"
        :aria-current="active === 'agents' ? 'page' : undefined"
        ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
      >
    </nav>
  </aside>
</template>
