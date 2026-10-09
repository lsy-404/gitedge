<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import TextField from "../components/TextField.vue";
import { ApiError, api, errorMessage } from "../lib/api";
import "../styles/auth.css";

const { t } = useI18n();
const route = useRoute();
const token = computed(() => {
  const value = route.query.token;
  return typeof value === "string" ? value : "";
});
const newPassword = ref("");
const factorNeeded = ref(false);
const factorMethod = ref<"totp" | "recovery">("totp");
const factorCode = ref("");
const busy = ref(false);
const error = ref("");
const done = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await api.confirmPasswordResetEmail({
      token: token.value,
      newPassword: newPassword.value,
      ...(factorNeeded.value
        ? { factor: { method: factorMethod.value, code: factorCode.value.trim() } }
        : {}),
    });
    done.value = true;
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "second_factor_required") {
      factorNeeded.value = true;
      error.value = t("resetNeedsSecondFactor");
    } else {
      error.value = errorMessage(cause, t, {
        400: "resetLinkInvalid",
        401: "secondFactorInvalid",
        429: "authRateLimited",
      });
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="auth-page">
    <div class="auth-brand">
      <img src="/logo.svg" alt="" width="48" height="48" />
      <h1>{{ t("resetPasswordTitle") }}</h1>
    </div>
    <div class="auth-card">
      <NoticeBar v-if="!token" intent="error">{{ t("resetLinkInvalid") }}</NoticeBar>
      <NoticeBar v-else-if="done" intent="success">{{ t("passwordResetDone") }}</NoticeBar>
      <form v-else class="form-stack" @submit.prevent="submit">
        <TextField
          v-model="newPassword"
          type="password"
          required
          minlength="12"
          autocomplete="new-password"
          :hint="t('passwordHint')"
          >{{ t("newPassword") }}</TextField
        >
        <template v-if="factorNeeded">
          <fieldset class="form-stack">
            <legend class="field-label">{{ t("secondFactorTitle") }}</legend>
            <label class="inline-choice"
              ><input v-model="factorMethod" type="radio" value="totp" />
              {{ t("secondFactorTotp") }}</label
            >
            <label class="inline-choice"
              ><input v-model="factorMethod" type="radio" value="recovery" />
              {{ t("secondFactorRecovery") }}</label
            >
          </fieldset>
          <TextField
            v-model="factorCode"
            required
            autocomplete="one-time-code"
            spellcheck="false"
            maxlength="32"
            >{{
              t(factorMethod === "totp" ? "secondFactorTotp" : "secondFactorRecovery")
            }}</TextField
          >
        </template>
        <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
        <button type="submit" class="btn btn-primary auth-submit" :disabled="busy">
          {{ busy ? t("loading") : t("resetPassword") }}
        </button>
      </form>
    </div>
    <p class="auth-page-footer">
      <AppLink to="/login">{{ t("backToSignIn") }}</AppLink>
    </p>
  </section>
</template>
