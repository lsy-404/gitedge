<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SecuritySummary } from "../../../../packages/contracts/src/security";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import RecoveryCodesNotice from "./RecoveryCodesNotice.vue";
import SecurityEmail from "./SecurityEmail.vue";
import SecurityPasskeys from "./SecurityPasskeys.vue";
import SecurityPassword from "./SecurityPassword.vue";
import SecurityReauth from "./SecurityReauth.vue";
import SecurityRecoveryCodes from "./SecurityRecoveryCodes.vue";
import SecurityTotp from "./SecurityTotp.vue";
import StatusState from "./StatusState.vue";
import "../styles/security.css";

const { t } = useI18n();
const summary = ref<SecuritySummary | null>(null);
const loading = ref(true);
const error = ref("");
const revealedCodes = ref<string[] | null>(null);
const locked = computed(() => !summary.value?.recentAuth.valid);

async function load(): Promise<void> {
  try {
    summary.value = await api.security();
    error.value = "";
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsSecurity") }}</h2>
        <p>{{ t("settingsSecurityDescription") }}</p>
      </div>
    </header>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <template v-else-if="summary">
      <RecoveryCodesNotice
        v-if="revealedCodes"
        :codes="revealedCodes"
        @dismiss="revealedCodes = null"
      />
      <SecurityReauth v-if="locked" :summary="summary" @confirmed="load" />
      <SecurityPassword v-if="summary.passwordEnabled" :locked="locked" @changed="load" />
      <SecurityEmail :summary="summary" :locked="locked" @changed="load" />
      <SecurityTotp
        :summary="summary"
        :locked="locked"
        @changed="load"
        @codes="revealedCodes = $event"
      />
      <SecurityPasskeys
        :summary="summary"
        :locked="locked"
        @changed="load"
        @codes="revealedCodes = $event"
      />
      <SecurityRecoveryCodes
        :summary="summary"
        :locked="locked"
        @changed="load"
        @codes="revealedCodes = $event"
      />
    </template>
  </section>
</template>
