<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { renderSVG } from "uqr";
import type { SecuritySummary, TotpEnrollment } from "../../../../packages/contracts/src/security";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import TextField from "./TextField.vue";

const props = defineProps<{ summary: SecuritySummary; locked: boolean }>();
const emit = defineEmits<{ changed: []; codes: [codes: string[]] }>();
const { t } = useI18n();
const enrollment = ref<TotpEnrollment | null>(null);
const code = ref("");
const password = ref("");
const disabling = ref(false);
const busy = ref(false);
const error = ref("");
const qr = computed(() =>
  enrollment.value
    ? renderSVG(enrollment.value.otpauthUri, {
        border: 2,
        whiteColor: "#ffffff",
        blackColor: "#000000",
      })
    : ""
);

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = securityErrorMessage(cause, t, { 401: "reauthRejected", 429: "authRateLimited" });
    emit("changed");
  } finally {
    busy.value = false;
  }
}

const begin = () =>
  run(async () => {
    enrollment.value = await api.enrollTotp();
    code.value = "";
  });

const confirm = () =>
  run(async () => {
    const result = await api.confirmTotp(code.value.trim());
    enrollment.value = null;
    code.value = "";
    if (result.recoveryCodes) emit("codes", result.recoveryCodes);
    emit("changed");
  });

const disable = () =>
  run(async () => {
    await api.disableTotp({
      code: code.value.trim(),
      ...(props.summary.passwordEnabled ? { password: password.value } : {}),
    });
    disabling.value = false;
    code.value = "";
    password.value = "";
    emit("changed");
  });
</script>

<template>
  <section class="box" aria-labelledby="security-totp-title">
    <header class="box-header">
      <h3 id="security-totp-title">{{ t("totpTitle") }}</h3>
      <StatusBadge :tone="summary.totp.enabled ? 'success' : 'neutral'">{{
        t(summary.totp.enabled ? "securityOn" : "securityOff")
      }}</StatusBadge>
    </header>
    <div class="box-form form-stack">
      <p class="muted">{{ t("totpHint") }}</p>
      <p v-if="!summary.totp.available" class="muted">{{ t("totpUnavailable") }}</p>

      <template v-else-if="summary.totp.enabled">
        <form v-if="disabling" class="form-stack" @submit.prevent="disable">
          <TextField
            v-if="summary.passwordEnabled"
            v-model="password"
            type="password"
            required
            autocomplete="current-password"
            >{{ t("password") }}</TextField
          >
          <TextField
            v-model="code"
            required
            autocomplete="one-time-code"
            inputmode="numeric"
            maxlength="6"
            pattern="[0-9]{6}"
            >{{ t("secondFactorTotp") }}</TextField
          >
          <div class="form-actions">
            <FluentButton type="button" @click="disabling = false">{{ t("cancel") }}</FluentButton>
            <FluentButton type="submit" tone="danger" :disabled="locked || busy">{{
              t("totpDisable")
            }}</FluentButton>
          </div>
        </form>
        <div v-else class="form-actions">
          <FluentButton type="button" tone="danger" :disabled="locked" @click="disabling = true">{{
            t("totpDisable")
          }}</FluentButton>
        </div>
      </template>

      <form v-else-if="enrollment" class="form-stack" @submit.prevent="confirm">
        <p>{{ t("totpScan") }}</p>
        <div class="security-qr" role="img" :aria-label="t('totpQrLabel')" v-html="qr"></div>
        <p class="field-hint">{{ t("totpManual") }}</p>
        <code class="settings-code">{{ enrollment.secret }}</code>
        <TextField
          v-model="code"
          required
          autocomplete="one-time-code"
          inputmode="numeric"
          maxlength="6"
          pattern="[0-9]{6}"
          >{{ t("totpConfirmCode") }}</TextField
        >
        <div class="form-actions">
          <FluentButton type="button" @click="enrollment = null">{{ t("cancel") }}</FluentButton>
          <FluentButton type="submit" tone="primary" :disabled="busy">{{
            t("totpEnable")
          }}</FluentButton>
        </div>
      </form>
      <div v-else class="form-actions">
        <FluentButton type="button" tone="primary" :disabled="locked || busy" @click="begin">{{
          t("totpSetup")
        }}</FluentButton>
      </div>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    </div>
  </section>
</template>
