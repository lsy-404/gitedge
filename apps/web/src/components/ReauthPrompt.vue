<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SecuritySummary } from "../../../../packages/contracts/src/security";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import SecurityReauth from "./SecurityReauth.vue";
import StatusState from "./StatusState.vue";
import "../styles/security.css";

const emit = defineEmits<{ confirmed: [] }>();
const { t } = useI18n();
const summary = ref<SecuritySummary | null>(null);
const error = ref("");

onMounted(async () => {
  try {
    summary.value = await api.security();
  } catch (cause) {
    error.value = errorMessage(cause, t);
  }
});
</script>

<template>
  <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  <SecurityReauth v-else-if="summary" :summary="summary" @confirmed="emit('confirmed')" />
  <StatusState v-else :loading="true" />
</template>
