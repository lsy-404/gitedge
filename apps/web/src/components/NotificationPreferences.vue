<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentSwitch } from "@platform-kit/fluent/vue";
import {
  NotificationReasons,
  type NotificationReason,
} from "../../../../packages/contracts/src/notifications";
import { api } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const { t } = useI18n();
const muted = ref<ReadonlySet<NotificationReason>>(new Set());
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const notice = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    muted.value = new Set((await api.notificationPreferences()).mutedReasons);
  } catch {
    error.value = t("notificationPreferencesLoadError");
  } finally {
    loading.value = false;
  }
}

function setEnabled(reason: NotificationReason, enabled: boolean): void {
  const next = new Set(muted.value);
  if (enabled) next.delete(reason);
  else next.add(reason);
  muted.value = next;
  notice.value = "";
}

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.saveNotificationPreferences({ mutedReasons: [...muted.value] });
    notice.value = t("notificationPreferencesSaved");
  } catch {
    error.value = t("notificationPreferencesSaveError");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-panel" aria-labelledby="notification-preferences-title">
    <header class="settings-header">
      <div>
        <h2 id="notification-preferences-title">{{ t("notificationPreferencesTitle") }}</h2>
        <p>{{ t("notificationPreferencesHint") }}</p>
      </div>
    </header>
    <StatusState
      v-if="loading || (error && !notice)"
      :loading="loading"
      :error="error"
      @retry="load"
    />
    <div v-else class="box">
      <div v-for="reason in NotificationReasons" :key="reason" class="box-row settings-row">
        <div class="row-copy">
          <span>{{ t(`notificationReason_${reason}`) }}</span>
        </div>
        <FluentSwitch
          :model-value="!muted.has(reason)"
          :label="t(`notificationReason_${reason}`)"
          @update:model-value="setEnabled(reason, $event)"
        />
      </div>
      <div class="box-form form-stack">
        <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
        <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
        <div class="form-actions">
          <FluentButton type="button" tone="primary" :busy="saving" @click="save">{{
            t("notificationPreferencesSave")
          }}</FluentButton>
        </div>
      </div>
    </div>
  </section>
</template>
