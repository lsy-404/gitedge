<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SecuritySummary } from "../../../../packages/contracts/src/security";
import { api } from "../lib/api";
import { securityErrorMessage } from "../lib/security";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";

defineProps<{ summary: SecuritySummary; locked: boolean }>();
const emit = defineEmits<{ changed: []; codes: [codes: string[]] }>();
const { t } = useI18n();
const busy = ref(false);
const error = ref("");

async function regenerate(): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    emit("codes", (await api.regenerateRecoveryCodes()).recoveryCodes);
  } catch (cause) {
    error.value = securityErrorMessage(cause, t);
  } finally {
    busy.value = false;
    emit("changed");
  }
}
</script>

<template>
  <section class="box" aria-labelledby="security-recovery-title">
    <header class="box-header">
      <h3 id="security-recovery-title">{{ t("recoveryCodesTitle") }}</h3>
    </header>
    <div class="box-form form-stack">
      <p class="muted">{{ t("recoveryCodesHint") }}</p>
      <p>{{ t("recoveryCodesRemaining", { count: summary.recoveryCodesRemaining }) }}</p>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <div class="form-actions">
        <ConfirmButton
          tone="secondary"
          :label="
            t(summary.recoveryCodesRemaining ? 'recoveryCodesRegenerate' : 'recoveryCodesGenerate')
          "
          :prompt="t('confirmRegenerateCodes')"
          :disabled="locked || busy"
          @confirm="regenerate"
        />
      </div>
    </div>
  </section>
</template>
