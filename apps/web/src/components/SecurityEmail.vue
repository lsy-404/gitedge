<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SecuritySummary } from "../../../../packages/contracts/src/security";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import TextField from "./TextField.vue";

defineProps<{ summary: SecuritySummary; locked: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const email = ref("");
const busy = ref(false);
const error = ref("");
const sent = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  sent.value = false;
  try {
    await api.setEmail(email.value.trim());
    sent.value = true;
    email.value = "";
  } catch (cause) {
    error.value = securityErrorMessage(cause, t);
  } finally {
    busy.value = false;
    emit("changed");
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await api.removeEmail();
    sent.value = false;
  } catch (cause) {
    error.value = securityErrorMessage(cause, t);
  } finally {
    busy.value = false;
    emit("changed");
  }
}
</script>

<template>
  <section class="box" aria-labelledby="security-email-title">
    <header class="box-header">
      <h3 id="security-email-title">{{ t("emailAddress") }}</h3>
    </header>
    <div class="box-form form-stack">
      <p class="muted">{{ t("securityEmailHint") }}</p>
      <p v-if="!summary.emailAvailable" class="muted">{{ t("emailUnavailable") }}</p>
      <div v-if="summary.email" class="settings-actions">
        <strong>{{ summary.email.address }}</strong>
        <StatusBadge :tone="summary.email.verified ? 'success' : 'neutral'">{{
          t(summary.email.verified ? "emailVerifiedBadge" : "emailUnverifiedBadge")
        }}</StatusBadge>
        <ConfirmButton
          :label="t('emailRemove')"
          :prompt="t('confirmRemoveEmail')"
          :disabled="locked || busy"
          @confirm="remove"
        />
      </div>
      <form v-if="summary.emailAvailable" class="form-stack" @submit.prevent="submit">
        <TextField
          v-model="email"
          type="email"
          required
          autocomplete="email"
          maxlength="254"
          :disabled="locked"
          >{{ t(summary.email ? "emailChange" : "emailAdd") }}</TextField
        >
        <NoticeBar v-if="sent" intent="info">{{ t("emailVerificationSent") }}</NoticeBar>
        <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
        <div class="form-actions">
          <FluentButton type="submit" tone="primary" :disabled="locked || busy">
            {{ busy ? t("loading") : t("emailSendVerification") }}
          </FluentButton>
        </div>
      </form>
    </div>
  </section>
</template>
