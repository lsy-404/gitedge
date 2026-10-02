<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { api } from "../lib/api";
import type { SsoProviderSummary } from "../lib/api";
import { setSession } from "../lib/session";
import TextField from "../components/TextField.vue";
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const register = computed(() => route.path === "/register");
const identifier = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const providers = ref<SsoProviderSummary[]>([]);
const providersError = ref(false);
const returnTo = computed(() => safeReturnTo(route.query.redirect));
const samlProviders = computed(() =>
  providers.value.filter((item) => item.protocol === "saml" && metadataHref(item.metadataUrl))
);

/** Maps the `error` code the OAuth/SSO callbacks redirect with to a localized message. */
const callbackError = computed(() => {
  const code = Array.isArray(route.query.error) ? route.query.error[0] : route.query.error;
  if (!code) return "";
  if (code === "sso_logout_unavailable") return t("ssoLogoutUnavailable");
  if (code === "github_oauth_failed") return t("githubLoginError");
  if (code.startsWith("sso_")) return t("ssoLoginError");
  return t("oauthGenericError");
});

function safeReturnTo(candidate: unknown): string {
  const fallback = "/dashboard";
  if (typeof candidate !== "string" || !candidate.startsWith("/")) return fallback;
  try {
    const target = new URL(candidate, window.location.origin);
    if (target.origin !== window.location.origin || candidate.startsWith("//")) return fallback;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return fallback;
  }
}

function providerHref(providerId: string): string {
  return `/api/auth/sso/${encodeURIComponent(providerId)}/start?returnTo=${encodeURIComponent(returnTo.value)}`;
}

function metadataHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const target = new URL(url);
    return target.protocol === "https:" ? target.href : null;
  } catch {
    return null;
  }
}

onMounted(async () => {
  try {
    providers.value = await api.ssoProviders();
  } catch {
    providersError.value = true;
  }
});

function githubLogin() {
  window.location.assign(`/api/auth/github/start?returnTo=${encodeURIComponent(returnTo.value)}`);
}
async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const user = register.value
      ? await api.register({ identifier: identifier.value, password: password.value })
      : await api.login({ identifier: identifier.value, password: password.value });
    setSession(user);
    await router.push(returnTo.value);
  } catch {
    error.value = t("apiError");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="auth">
    <img class="auth-logo" src="/logo.svg" alt="" width="48" height="48" />
    <h1>{{ register ? t("registerTitle") : t("loginTitle") }}</h1>
    <div class="box auth-card form-stack">
      <form class="form-stack" @submit.prevent="submit">
        <TextField
          v-model="identifier"
          required
          autocomplete="username"
          :pattern="register ? '[A-Za-z0-9][A-Za-z0-9-]{2,62}' : undefined"
          :maxlength="register ? 63 : 64"
          >{{ t(register ? "registrationIdentifier" : "identifier") }}</TextField
        >
        <TextField
          v-model="password"
          type="password"
          required
          minlength="12"
          :autocomplete="register ? 'new-password' : 'current-password'"
          >{{ t("password") }}</TextField
        >
        <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
        <fluent-button type="submit" appearance="primary" class="block" :disabled="busy">
          {{ busy ? t("loading") : register ? t("signUp") : t("signIn") }}
        </fluent-button>
      </form>
      <fluent-divider>{{ t("orContinue") }}</fluent-divider>
      <div class="oauth">
        <fluent-anchor-button
          v-for="provider in providers"
          :key="provider.id"
          class="federation-provider block"
          :href="providerHref(provider.id)"
        >
          {{ t("continueWith", { provider: provider.label }) }}
          <StatusBadge slot="end">{{ provider.protocol.toUpperCase() }}</StatusBadge>
        </fluent-anchor-button>
        <NoticeBar v-if="providersError" intent="warning">{{ t("ssoProvidersError") }}</NoticeBar>
        <fluent-link
          v-for="provider in samlProviders"
          :key="`${provider.id}-metadata`"
          :href="metadataHref(provider.metadataUrl) || undefined"
          target="_blank"
          rel="noreferrer"
        >
          {{ provider.label }} · {{ t("ssoMetadata") }}
        </fluent-link>
        <fluent-button type="button" class="block" @click="githubLogin">
          {{ t("githubSignIn") }}
        </fluent-button>
      </div>
      <NoticeBar v-if="callbackError" intent="error">{{ callbackError }}</NoticeBar>
    </div>
    <p class="auth-switch">
      {{ register ? t("hasAccount") : t("needsAccount") }}
      <AppLink :to="register ? '/login' : '/register'">{{
        register ? t("signIn") : t("signUp")
      }}</AppLink>
    </p>
  </section>
</template>
