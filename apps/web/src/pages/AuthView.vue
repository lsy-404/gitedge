<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusBadge from "../components/StatusBadge.vue";
import AppIcon from "../components/AppIcon.vue";
import { BROWSER_ACCOUNT_LIMIT } from "../../../../packages/contracts/src/browser-accounts";
import { api, ApiError, errorMessage } from "../lib/api";
import type { SsoProviderSummary } from "../lib/api";
import { setSession, sessionState } from "../lib/session";
import { notifyBrowserIdentityChanged } from "../lib/browserIdentity";
import TextField from "../components/TextField.vue";
import "../styles/workspace.css";
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const register = computed(() => route.path === "/register");
const addingAccount = computed(() => route.path === "/login" && route.query.add === "1");
const identifier = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const providers = ref<SsoProviderSummary[]>([]);
const providersError = ref(false);
const returnTo = computed(() => safeReturnTo(route.query.redirect));
/** The built-in GitHub OAuth button below owns GitHub; never list it a second time as a federation provider. */
const federationProviders = computed(() =>
  providers.value.filter((item) => !/github/i.test(`${item.id} ${item.label}`))
);
const samlProviders = computed(() =>
  providers.value.filter((item) => item.protocol === "saml" && metadataHref(item.metadataUrl))
);

/** Maps the `error` code the OAuth/SSO callbacks redirect with to a localized message. */
const callbackError = computed(() => {
  const code = Array.isArray(route.query.error) ? route.query.error[0] : route.query.error;
  if (!code) return "";
  if (code === "sso_logout_unavailable") return t("ssoLogoutUnavailable");
  if (code === "github_oauth_failed") return t("githubLoginError");
  if (code === "github_signup_disabled") return t("githubSignupDisabled");
  if (code === "account_limit") return t("browserAccountLimit", { limit: BROWSER_ACCOUNT_LIMIT });
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
  const prompt = addingAccount.value ? "&prompt=select_account" : "";
  return `/api/auth/sso/${encodeURIComponent(providerId)}/start?returnTo=${encodeURIComponent(returnTo.value)}${prompt}`;
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

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const user = register.value
      ? await api.register({ identifier: identifier.value, password: password.value })
      : await api.login({ identifier: identifier.value, password: password.value });
    setSession(user);
    if (addingAccount.value) {
      notifyBrowserIdentityChanged();
      window.location.assign(returnTo.value);
      return;
    }
    await router.push(returnTo.value);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && !register.value)
      error.value = t("browserAccountLimit", { limit: BROWSER_ACCOUNT_LIMIT });
    else
      error.value = errorMessage(
        cause,
        t,
        register.value
          ? {
              400: "registerInvalid",
              403: "registrationDisabled",
              409: "identifierTaken",
              429: "authRateLimited",
            }
          : { 401: "invalidCredentials", 429: "authRateLimited" }
      );
  } finally {
    busy.value = false;
  }
}
function githubLogin() {
  const prompt = addingAccount.value ? "&prompt=select_account" : "";
  window.location.assign(
    `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo.value)}${prompt}`
  );
}
async function cancelAddingAccount() {
  if (sessionState.user) await router.replace(returnTo.value);
}
</script>
<template>
  <section class="workspace-page auth-page">
    <div class="auth-brand">
      <img src="/logo.svg" alt="" width="48" height="48" />
      <h1>
        {{
          addingAccount
            ? t("addingBrowserAccount")
            : register
              ? t("registerTitle")
              : t("loginTitle")
        }}
      </h1>
    </div>
    <div class="auth-card">
      <div class="auth-provider-list">
        <FluentButton
          type="button"
          class="btn auth-provider-choice github-auth-choice"
          @click="githubLogin"
        >
          <span class="provider-mark github-mark"><AppIcon name="github" /></span>
          <strong>{{ t("githubSignIn") }}</strong
          ><StatusBadge>OAuth</StatusBadge>
        </FluentButton>
        <a
          v-for="provider in federationProviders"
          :key="provider.id"
          class="btn auth-provider-choice federation-provider"
          :href="providerHref(provider.id)"
        >
          <span class="provider-mark oidc-mark"><AppIcon name="lock" /></span
          ><strong>{{ t("continueWith", { provider: provider.label }) }}</strong
          ><StatusBadge>{{ provider.protocol.toUpperCase() }}</StatusBadge>
        </a>
        <NoticeBar v-if="providersError" intent="warning">{{ t("ssoProvidersError") }}</NoticeBar>
        <a
          v-for="provider in samlProviders"
          :key="`${provider.id}-metadata`"
          :href="metadataHref(provider.metadataUrl) || undefined"
          target="_blank"
          rel="noreferrer"
          >{{ provider.label }} · {{ t("ssoMetadata") }}</a
        >
      </div>
      <div class="auth-divider">
        <span>{{ t("orContinueWithPassword") }}</span>
      </div>
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
        <button type="submit" class="btn btn-primary block" :disabled="busy">
          {{ busy ? t("loading") : register ? t("signUp") : t("signIn") }}
        </button>
      </form>
      <NoticeBar v-if="callbackError" intent="error">{{ callbackError }}</NoticeBar>
    </div>
    <p v-if="addingAccount && sessionState.user" class="auth-page-footer">
      <button class="btn btn-subtle" @click="cancelAddingAccount">
        {{ t("cancelAddingAccount") }}
      </button>
    </p>
    <p v-else-if="!addingAccount" class="auth-page-footer">
      {{ register ? t("hasAccount") : t("needsAccount") }}
      <AppLink :to="register ? '/login' : '/register'">{{
        register ? t("signIn") : t("signUp")
      }}</AppLink>
    </p>
  </section>
</template>
