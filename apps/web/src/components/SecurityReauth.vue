<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SecuritySummary } from "../../../../packages/contracts/src/security";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import { passkeyPromptCancelled, promptPasskeyAuthentication } from "../lib/webauthn";
import NoticeBar from "./NoticeBar.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ summary: SecuritySummary }>();
const emit = defineEmits<{ confirmed: [] }>();
const { t } = useI18n();

type Method = SecuritySummary["recentAuth"]["methods"][number];
const available = computed(() => props.summary.recentAuth.methods);
const method = ref<Method>(available.value[0] ?? "password");
const value = ref("");
const busy = ref(false);
const error = ref("");

const labels = {
  password: "password",
  totp: "secondFactorTotp",
  passkey: "secondFactorPasskey",
  recovery: "secondFactorRecovery",
} as const;

async function submit(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    if (method.value === "password") {
      await api.reauthenticate({ method: "password", password: value.value });
    } else if (method.value === "passkey") {
      const { options } = await api.reauthPasskeyOptions();
      const response = await promptPasskeyAuthentication(options);
      await api.reauthenticate({ method: "passkey", response });
    } else {
      await api.reauthenticate({ method: method.value, code: value.value.trim() });
    }
    value.value = "";
    emit("confirmed");
  } catch (cause) {
    error.value = passkeyPromptCancelled(cause)
      ? t("passkeyCancelled")
      : securityErrorMessage(cause, t, { 401: "reauthRejected", 429: "authRateLimited" });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="box" aria-labelledby="reauth-title">
    <header class="box-header">
      <h3 id="reauth-title">{{ t("reauthTitle") }}</h3>
    </header>
    <p v-if="!available.length" class="box-form muted">{{ t("reauthUnavailable") }}</p>
    <form v-else class="box-form form-stack" @submit.prevent="submit">
      <p class="muted">{{ t("reauthDescription") }}</p>
      <fieldset v-if="available.length > 1" class="security-choices">
        <legend class="field-label">{{ t("reauthMethod") }}</legend>
        <label v-for="item in available" :key="item" class="inline-choice">
          <input
            v-model="method"
            type="radio"
            name="reauth-method"
            :value="item"
            @change="value = ''"
          />
          {{ t(labels[item]) }}
        </label>
      </fieldset>
      <TextField
        v-if="method !== 'passkey'"
        :key="method"
        v-model="value"
        required
        :type="method === 'password' ? 'password' : 'text'"
        :autocomplete="method === 'password' ? 'current-password' : 'one-time-code'"
        spellcheck="false"
        >{{ t(labels[method]) }}</TextField
      >
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="submit" tone="primary" :disabled="busy">
          {{ busy ? t("loading") : t("reauthConfirm") }}
        </FluentButton>
      </div>
    </form>
  </section>
</template>
