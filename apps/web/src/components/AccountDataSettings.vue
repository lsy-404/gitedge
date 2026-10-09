<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import { ApiError, api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import { clearSession, sessionState } from "../lib/session";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import TypeToConfirm from "./TypeToConfirm.vue";

const { t } = useI18n();
const reauth = useReauthRetry();
const exporting = ref(false);
const deleting = ref(false);
const error = ref("");
const exported = ref(false);
const blockedBy = ref<string[]>([]);

async function exportData(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  error.value = "";
  exported.value = false;
  try {
    const blob = await api.exportAccount();
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `gitedge-${sessionState.user?.identifier ?? "account"}-export.json`;
    link.click();
    URL.revokeObjectURL(url);
    exported.value = true;
  } catch (cause) {
    if (reauth.intercept(cause, exportData)) return;
    error.value = errorMessage(cause, t);
  } finally {
    exporting.value = false;
  }
}

async function deleteAccount(): Promise<void> {
  const identifier = sessionState.user?.identifier;
  if (!identifier || deleting.value) return;
  deleting.value = true;
  error.value = "";
  blockedBy.value = [];
  try {
    await api.deleteAccount(identifier);
    clearSession();
    window.location.assign("/login");
  } catch (cause) {
    if (reauth.intercept(cause, deleteAccount)) return;
    if (cause instanceof ApiError && cause.code === "organization_ownership") {
      blockedBy.value = cause.organizations;
      error.value = t("accountDeleteBlocked");
    } else error.value = errorMessage(cause, t);
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsData") }}</h2>
        <p>{{ t("accountDataHint") }}</p>
      </div>
    </header>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
    <NoticeBar v-if="error" intent="error">
      {{ error }}
      <template v-if="blockedBy.length">: {{ blockedBy.join(", ") }}</template>
    </NoticeBar>
    <NoticeBar v-if="exported" intent="success">{{ t("accountExportDone") }}</NoticeBar>
    <section class="box" aria-labelledby="export-title">
      <header class="box-header">
        <h3 id="export-title">{{ t("accountExportTitle") }}</h3>
      </header>
      <div class="box-row settings-row">
        <div class="row-copy">
          <p>{{ t("accountExportHint") }}</p>
        </div>
        <FluentButton type="button" :busy="exporting" @click="exportData">{{
          t("accountExportAction")
        }}</FluentButton>
      </div>
    </section>
    <section class="box box-danger" aria-labelledby="delete-title">
      <header class="box-header">
        <h3 id="delete-title">{{ t("accountDeleteTitle") }}</h3>
      </header>
      <div class="box-row settings-row">
        <div class="row-copy">
          <p>{{ t("accountDeleteHint") }}</p>
        </div>
        <TypeToConfirm
          v-if="sessionState.user"
          :expected="sessionState.user.identifier"
          :action-label="t('accountDeleteAction')"
          :busy="deleting"
          @confirm="deleteAccount"
        />
      </div>
    </section>
  </section>
</template>
