<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";
import { api } from "../lib/api";
import "../styles/auth.css";

const { t } = useI18n();
const route = useRoute();
const state = ref<"working" | "verified" | "failed">("working");

onMounted(async () => {
  const token = typeof route.query.token === "string" ? route.query.token : "";
  try {
    await api.verifyEmail(token);
    state.value = "verified";
  } catch {
    state.value = "failed";
  }
});
</script>

<template>
  <section class="auth-page">
    <div class="auth-brand">
      <img src="/logo.svg" alt="" width="48" height="48" />
      <h1>{{ t("verifyEmailTitle") }}</h1>
    </div>
    <div class="auth-card" aria-live="polite">
      <StatusState v-if="state === 'working'" :loading="true" />
      <NoticeBar v-else-if="state === 'verified'" intent="success">{{
        t("emailVerified")
      }}</NoticeBar>
      <NoticeBar v-else intent="error">{{ t("verifyLinkInvalid") }}</NoticeBar>
    </div>
    <p class="auth-page-footer">
      <AppLink to="/settings/account?section=security">{{ t("settingsSecurity") }}</AppLink>
    </p>
  </section>
</template>
