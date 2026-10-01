<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api } from "../lib/api";
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
function githubLogin(access: "identity" | "read") {
  const returnTo = String(route.query.redirect || "/dashboard");
  window.location.assign(
    `/api/auth/github/start?access=${access}&returnTo=${encodeURIComponent(returnTo)}`
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
  <section class="auth">
    <img class="auth-logo" src="/logo.svg" alt="" width="48" height="48" />
    <h1>{{ register ? t("registerTitle") : t("loginTitle") }}</h1>
    <form class="box auth-card form-stack" @submit.prevent="submit">
      <label class="field"
        >{{ t("identifier") }}<input v-model="identifier" required autocomplete="username"
      /></label>
      <label class="field"
        >{{ t("password")
        }}<input
          v-model="password"
          type="password"
          required
          minlength="12"
          :autocomplete="register ? 'new-password' : 'current-password'"
      /></label>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="btn primary block" :disabled="busy">
        {{ busy ? t("loading") : register ? t("signUp") : t("signIn") }}
      </button>
      <div class="divider">{{ t("orContinue") }}</div>
      <div class="oauth">
        <button type="button" class="btn block" @click="githubLogin('identity')">
          {{ t("githubIdentity") }}
        </button>
        <p class="oauth-hint">{{ t("identityText") }}</p>
        <button type="button" class="btn block" @click="githubLogin('read')">
          {{ t("githubRead") }}
        </button>
        <p class="oauth-hint">{{ t("readText") }} {{ t("noWriteScope") }}</p>
      </div>
      <p v-if="oauthError" class="form-error" role="alert">
        {{ t("oauthError", { error: oauthError }) }}
      </p>
    </form>
    <p class="auth-switch">
      {{ register ? t("hasAccount") : t("needsAccount") }}
      <RouterLink :to="register ? '/login' : '/register'">{{
        register ? t("signIn") : t("signUp")
      }}</RouterLink>
    </p>
  </section>
</template>
