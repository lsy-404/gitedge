<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";
import type { SsoProviderSummary } from "../lib/api";
import { setSession } from "../lib/session";
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const register = computed(() => route.path === "/register");
const identifier = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const oauthError = computed(() => String(route.query.error || ""));
const providers = ref<SsoProviderSummary[]>([]);
const providersError = ref(false);
const ssoErrorCodes = [
  "sso_invalid_response",
  "sso_expired",
  "sso_identity_in_use",
  "sso_signup_disabled",
  "sso_configuration",
];
const hasSsoError = computed(() => ssoErrorCodes.includes(String(route.query.error || "")));
const githubOauthError = computed(() => (hasSsoError.value ? "" : oauthError.value));
const returnTo = computed(() => safeReturnTo(route.query.redirect));

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

function githubLogin(access: "identity" | "read") {
  window.location.assign(
    `/api/auth/github/start?access=${access}&returnTo=${encodeURIComponent(returnTo.value)}`
  );
}
async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const user = register.value
      ? await api.register({ identifier: identifier.value, password: password.value })
      : await api.login({ identifier: identifier.value, password: password.value });
    setSession(user);
    await router.push(String(route.query.redirect || "/dashboard"));
  } catch {
    error.value = t("apiError");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="auth-layout">
    <div class="auth-intro">
      <p class="eyebrow">{{ t("brandSub") }} / {{ t("brand") }}</p>
      <h1>{{ t("welcome") }}</h1>
      <p>{{ t("welcomeText") }}</p>
      <div class="terminal">
        <span>~$</span> {{ t("cloneCommand") }}<br /><span>✓</span> <em>{{ t("edge") }}</em>
      </div>
    </div>
    <form class="panel auth-card" @submit.prevent="submit">
      <div>
        <p class="eyebrow">{{ register ? t("registerStep") : t("loginStep") }}</p>
        <h2>{{ register ? t("signUp") : t("signIn") }}</h2>
        <p class="muted">{{ register ? t("registerHint") : t("loginHint") }}</p>
      </div>
      <label
        >{{ t("identifier") }}<input v-model="identifier" required autocomplete="username" /></label
      ><label
        >{{ t("password")
        }}<input
          v-model="password"
          type="password"
          required
          minlength="12"
          autocomplete="current-password"
      /></label>
      <p v-if="error" class="form-error">{{ error }}</p>
      <button class="button primary" :disabled="busy">
        {{ busy ? t("loading") : t("submit") }}
      </button>
      <div class="oauth-divider">
        <span>{{ t("orContinue") }}</span>
      </div>
      <div class="oauth-options">
        <a
          v-for="provider in providers"
          :key="provider.id"
          class="button federation-provider"
          :href="providerHref(provider.id)"
        >
          <span>{{ provider.label }}</span>
          <span class="protocol-badge">{{ provider.protocol.toUpperCase() }}</span>
        </a>
        <p v-if="providersError" class="form-error" role="status">{{ t("ssoProvidersError") }}</p>
        <a
          v-for="provider in providers.filter(
            (item) => item.protocol === 'saml' && metadataHref(item.metadataUrl)
          )"
          :key="`${provider.id}-metadata`"
          class="metadata-link"
          :href="metadataHref(provider.metadataUrl) || undefined"
          target="_blank"
          rel="noreferrer"
        >
          {{ provider.label }} · {{ t("ssoMetadata") }}
        </a>
        <button type="button" class="button github" @click="githubLogin('identity')">
          ◉ {{ t("githubIdentity") }}
        </button>
        <p class="permission-card">
          <strong>{{ t("identityTitle") }}</strong
          ><br />{{ t("identityText") }}
        </p>
        <button type="button" class="button github" @click="githubLogin('read')">
          ◉ {{ t("githubRead") }}
        </button>
        <p class="permission-card">
          <strong>{{ t("readTitle") }}</strong
          ><br />{{ t("readText") }}
        </p>
        <p class="note">{{ t("noWriteScope") }}</p>
      </div>
      <p v-if="hasSsoError" class="form-error" role="alert">{{ t("ssoLoginError") }}</p>
      <p v-else-if="githubOauthError" class="form-error" role="alert">
        {{ t("oauthError", { error: githubOauthError }) }}
      </p>
      <p class="switch-auth">
        {{ register ? t("hasAccount") : t("needsAccount") }}
        <RouterLink :to="register ? '/login' : '/register'">{{
          register ? t("signIn") : t("signUp")
        }}</RouterLink>
      </p>
    </form>
  </section>
</template>
