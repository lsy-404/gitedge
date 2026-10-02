<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import AppIcon from "../components/AppIcon.vue";
import AccountProfilePanel from "../components/AccountProfilePanel.vue";
import AccountConnections from "../components/AccountConnections.vue";
import CredentialSettings from "../components/CredentialSettings.vue";
import SigningKeySettings from "../components/SigningKeySettings.vue";
import BrowserSessions from "../components/BrowserSessions.vue";
import "../styles/workspace.css";
import "../styles/settings.css";
const { t } = useI18n();
const route = useRoute();
const sections = [
  "profile",
  "preferences",
  "credentials",
  "signing",
  "sessions",
  "connections",
] as const;
const labels = {
  profile: "settingsProfile",
  preferences: "settingsPreferences",
  credentials: "settingsCredentials",
  signing: "settingsSigning",
  sessions: "settingsSessions",
  connections: "settingsConnections",
};
const section = computed(() =>
  route.query.sso || route.query.error
    ? "connections"
    : (sections.find((value) => value === route.query.section) ?? "profile")
);
</script>
<template>
  <section class="workspace-page settings-page account-settings-page">
    <aside class="settings-sidebar">
      <h1>{{ t("settings") }}</h1>
      <p class="settings-sidebar-label">{{ t("personalSettings") }}</p>
      <nav :aria-label="t('settingsNavigation')">
        <RouterLink
          v-for="item in sections"
          :key="item"
          class="workspace-nav-item"
          :class="{ 'is-selected': section === item }"
          :to="{ path: '/settings/account', query: { section: item } }"
          :aria-current="section === item ? 'page' : undefined"
          ><AppIcon
            :name="
              item === 'profile'
                ? 'person'
                : item === 'credentials'
                  ? 'lock'
                  : item === 'signing'
                    ? 'checkCircle'
                    : item === 'sessions'
                      ? 'clock'
                      : item === 'connections'
                        ? 'link'
                        : 'gear'
            "
          />{{ t(labels[item]) }}</RouterLink
        >
        <RouterLink class="workspace-nav-item" to="/settings/agents"
          ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
        >
      </nav>
    </aside>
    <div class="settings-content">
      <AccountProfilePanel
        v-if="section === 'profile' || section === 'preferences'"
        :section="section"
      />
      <CredentialSettings v-else-if="section === 'credentials'" />
      <SigningKeySettings v-else-if="section === 'signing'" />
      <BrowserSessions v-else-if="section === 'sessions'" />
      <AccountConnections v-else />
    </div>
  </section>
</template>
