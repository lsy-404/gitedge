<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import NoticeBar from "../components/NoticeBar.vue";
import ReauthPrompt from "../components/ReauthPrompt.vue";
import StatusState from "../components/StatusState.vue";
import { api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import { sessionState } from "../lib/session";
import "../styles/auth.css";
const { t } = useI18n();
const route = useRoute();
const reauth = useReauthRetry();
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const request = ref<{ clientName: string; scopes: string[] } | null>(null);
const query = new URLSearchParams();
for (const [key, value] of Object.entries(route.query)) {
  if (Array.isArray(value)) for (const item of value) query.append(key, item ?? "");
  else query.append(key, value ?? "");
}
async function decide(approve: boolean): Promise<void> {
  if (busy.value || !request.value) return;
  busy.value = true;
  error.value = "";
  try {
    const input: Record<string, string | boolean> = Object.fromEntries(query.entries());
    input.approve = approve;
    const result = await api.gitOAuthDecision(input);
    window.location.assign(result.redirectUrl);
  } catch (cause) {
    if (reauth.intercept(cause, () => decide(approve))) return;
    error.value = errorMessage(cause, t);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  try {
    request.value = await api.gitOAuthAuthorize(query.toString());
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
});
</script>
<template>
  <main class="auth-page">
    <section class="box box-form form-stack">
      <h1>{{ t("gitAuthorizeTitle") }}</h1>
      <StatusState v-if="loading" :loading="true" />
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
      <template v-if="request">
        <p>{{ t("gitAuthorizeRequest", { client: request.clientName }) }}</p>
        <p>{{ t("gitAuthorizeAccount", { account: sessionState.user?.identifier }) }}</p>
        <ul>
          <li v-if="request.scopes.includes('repo:read')">{{ t("gitAuthorizeRead") }}</li>
          <li v-if="request.scopes.includes('repo:write')">{{ t("gitAuthorizeWrite") }}</li>
        </ul>
        <div class="form-actions">
          <FluentButton
            type="button"
            tone="primary"
            :busy="busy"
            :disabled="busy"
            @click="decide(true)"
            >{{ t("gitAuthorizeAllow") }}</FluentButton
          ><FluentButton type="button" tone="secondary" :disabled="busy" @click="decide(false)">{{
            t("gitAuthorizeDeny")
          }}</FluentButton>
        </div>
      </template>
    </section>
  </main>
</template>
