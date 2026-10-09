<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import NoticeBar from "./NoticeBar.vue";
import TextField from "./TextField.vue";

defineProps<{ locked: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t } = useI18n();
const newPassword = ref("");
const busy = ref(false);
const error = ref("");
const saved = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  saved.value = false;
  try {
    await api.changePassword(newPassword.value);
    newPassword.value = "";
    saved.value = true;
  } catch (cause) {
    error.value = securityErrorMessage(cause, t, { 400: "registerInvalid" });
    emit("changed");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="box" aria-labelledby="security-password-title" @submit.prevent="submit">
    <header class="box-header">
      <h3 id="security-password-title">{{ t("password") }}</h3>
    </header>
    <div class="box-form form-stack">
      <p class="muted">{{ t("securityPasswordHint") }}</p>
      <TextField
        v-model="newPassword"
        type="password"
        required
        minlength="12"
        autocomplete="new-password"
        :disabled="locked"
        >{{ t("newPassword") }}</TextField
      >
      <NoticeBar v-if="saved" intent="success">{{ t("securityPasswordChanged") }}</NoticeBar>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="submit" tone="primary" :disabled="locked || busy">
          {{ busy ? t("loading") : t("securityChangePassword") }}
        </FluentButton>
      </div>
    </div>
  </form>
</template>
