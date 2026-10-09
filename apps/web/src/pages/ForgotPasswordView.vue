<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import AppLink from "../components/AppLink.vue";
import NoticeBar from "../components/NoticeBar.vue";
import TextField from "../components/TextField.vue";
import { api, errorMessage } from "../lib/api";
import "../styles/auth.css";

const { t } = useI18n();
const emailReset = ref(false);
const identifier = ref("");
const recoveryCode = ref("");
const newPassword = ref("");
const email = ref("");
const busy = ref(false);
const recoveryError = ref("");
const emailError = ref("");
const resetDone = ref(false);
const emailSent = ref(false);

onMounted(async () => {
  try {
    emailReset.value = (await api.recoveryOptions()).emailReset;
  } catch {
    emailReset.value = false;
  }
});

async function resetWithCode(): Promise<void> {
  busy.value = true;
  recoveryError.value = "";
  try {
    await api.resetPasswordWithRecoveryCode({
      identifier: identifier.value,
      recoveryCode: recoveryCode.value.trim(),
      newPassword: newPassword.value,
    });
    resetDone.value = true;
    newPassword.value = "";
    recoveryCode.value = "";
  } catch (cause) {
    recoveryError.value = errorMessage(cause, t, {
      400: "registerInvalid",
      401: "recoveryInvalid",
      429: "authRateLimited",
    });
  } finally {
    busy.value = false;
  }
}

async function sendEmail(): Promise<void> {
  busy.value = true;
  emailError.value = "";
  try {
    await api.requestPasswordResetEmail(email.value.trim());
    emailSent.value = true;
  } catch (cause) {
    emailError.value = errorMessage(cause, t, { 429: "authRateLimited" });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="auth-page">
    <div class="auth-brand">
      <img src="/logo.svg" alt="" width="48" height="48" />
      <h1>{{ t("forgotPasswordTitle") }}</h1>
    </div>
    <div class="auth-card">
      <NoticeBar v-if="resetDone" intent="success">{{ t("passwordResetDone") }}</NoticeBar>
      <form
        v-else
        class="form-stack"
        aria-labelledby="recovery-code-title"
        @submit.prevent="resetWithCode"
      >
        <h2 id="recovery-code-title" class="auth-step-title">{{ t("recoveryCodeReset") }}</h2>
        <p class="muted">{{ t("recoveryCodeResetHint") }}</p>
        <TextField v-model="identifier" required autocomplete="username" maxlength="64">{{
          t("registrationIdentifier")
        }}</TextField>
        <TextField
          v-model="recoveryCode"
          required
          autocomplete="off"
          spellcheck="false"
          maxlength="32"
          >{{ t("secondFactorRecovery") }}</TextField
        >
        <TextField
          v-model="newPassword"
          type="password"
          required
          minlength="12"
          autocomplete="new-password"
          :hint="t('passwordHint')"
          >{{ t("newPassword") }}</TextField
        >
        <NoticeBar v-if="recoveryError" intent="error">{{ recoveryError }}</NoticeBar>
        <button type="submit" class="btn btn-primary auth-submit" :disabled="busy">
          {{ busy ? t("loading") : t("resetPassword") }}
        </button>
      </form>
    </div>
    <div v-if="emailReset" class="auth-card auth-card-secondary">
      <NoticeBar v-if="emailSent" intent="info">{{ t("resetEmailSent") }}</NoticeBar>
      <form
        v-else
        class="form-stack"
        aria-labelledby="email-reset-title"
        @submit.prevent="sendEmail"
      >
        <h2 id="email-reset-title" class="auth-step-title">{{ t("emailReset") }}</h2>
        <p class="muted">{{ t("emailResetHint") }}</p>
        <TextField v-model="email" type="email" required autocomplete="email" maxlength="254">{{
          t("emailAddress")
        }}</TextField>
        <NoticeBar v-if="emailError" intent="error">{{ emailError }}</NoticeBar>
        <button type="submit" class="btn auth-submit" :disabled="busy">
          {{ busy ? t("loading") : t("sendResetLink") }}
        </button>
      </form>
    </div>
    <p class="auth-page-footer">
      <AppLink to="/login">{{ t("backToSignIn") }}</AppLink>
    </p>
  </section>
</template>
