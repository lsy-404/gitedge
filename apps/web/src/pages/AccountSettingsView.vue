<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import AccountProfilePanel from "../components/AccountProfilePanel.vue";
import AccountConnections from "../components/AccountConnections.vue";
import CredentialSettings from "../components/CredentialSettings.vue";
import SettingsSidebar from "../components/SettingsSidebar.vue";
import SigningKeySettings from "../components/SigningKeySettings.vue";
import AccountSecuritySettings from "../components/AccountSecuritySettings.vue";
import BrowserSessions from "../components/BrowserSessions.vue";
import "../styles/settings.css";
const route = useRoute();
const sections = [
  "profile",
  "preferences",
  "security",
  "credentials",
  "signing",
  "sessions",
  "connections",
] as const;
const section = computed(() =>
  route.query.sso || route.query.error
    ? "connections"
    : (sections.find((value) => value === route.query.section) ?? "profile")
);
</script>
<template>
  <section class="settings-page">
    <SettingsSidebar :active="section" />
    <div class="settings-content">
      <AccountProfilePanel
        v-if="section === 'profile' || section === 'preferences'"
        :section="section"
      />
      <AccountSecuritySettings v-else-if="section === 'security'" />
      <CredentialSettings v-else-if="section === 'credentials'" />
      <SigningKeySettings v-else-if="section === 'signing'" />
      <BrowserSessions v-else-if="section === 'sessions'" />
      <AccountConnections v-else />
    </div>
  </section>
</template>
