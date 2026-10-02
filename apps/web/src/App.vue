<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import AppLink from "./components/AppLink.vue";
import { api } from "./lib/api";
import { clearSession, refreshSession, sessionState } from "./lib/session";

const { t, locale } = useI18n();
const router = useRouter();
const accountName = computed(
  () => sessionState.user?.externalIdentity?.login || sessionState.user?.identifier || ""
);
function toggleLocale() {
  locale.value = locale.value === "zh-CN" ? "en" : "zh-CN";
}
async function signOut() {
  await api.logout();
  clearSession();
  await router.push("/login");
}
refreshSession();
</script>

<template>
  <div class="app-shell">
    <a class="skip-link" href="#main">{{ t("skipToContent") }}</a>
    <header class="topbar">
      <RouterLink class="brand" to="/dashboard">
        <img class="brand-mark" src="/logo.svg" alt="" width="28" height="28" />
        {{ t("brand") }}
      </RouterLink>
      <nav v-if="sessionState.user" class="top-actions" :aria-label="t('mainNav')">
        <AppLink to="/dashboard" button="subtle">{{ t("dashboard") }}</AppLink>
        <AppLink to="/organizations" button="subtle">{{ t("organizations") }}</AppLink>
        <AppLink to="/settings/agents" button="subtle">{{ t("agents") }}</AppLink>
        <fluent-button appearance="subtle" type="button" @click="toggleLocale">
          {{ locale === "zh-CN" ? "EN" : "中文" }}
        </fluent-button>
        <fluent-menu>
          <fluent-button
            slot="trigger"
            appearance="subtle"
            type="button"
            class="account-summary"
            :aria-label="accountName"
          >
            <fluent-avatar slot="start" size="24" :name="accountName">
              <img
                v-if="sessionState.user.externalIdentity?.avatarUrl"
                :src="sessionState.user.externalIdentity.avatarUrl"
                alt=""
              />
            </fluent-avatar>
            <span class="account-name">{{ accountName }}</span>
          </fluent-button>
          <fluent-menu-list>
            <fluent-menu-item @click="router.push('/settings/account')">{{
              t("account")
            }}</fluent-menu-item>
            <fluent-menu-item @click="signOut">{{ t("signOut") }}</fluent-menu-item>
          </fluent-menu-list>
        </fluent-menu>
      </nav>
      <fluent-button v-else appearance="subtle" type="button" @click="toggleLocale">
        {{ locale === "zh-CN" ? "EN" : "中文" }}
      </fluent-button>
    </header>
    <main id="main" tabindex="-1"><RouterView /></main>
    <footer>
      <span>{{ t("brand") }}</span>
      <span>{{ t("edge") }}</span>
    </footer>
  </div>
</template>
