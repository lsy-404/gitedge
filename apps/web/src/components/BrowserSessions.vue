<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { BrowserSession } from "../../../../packages/contracts/src/credentials";
import { api, errorMessage } from "../lib/api";
import { clearSession } from "../lib/session";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const router = useRouter();
const sessions = ref<BrowserSession[]>([]);
const loading = ref(true);
const loadingError = ref("");
const actionError = ref("");
const revokingId = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadingError.value = "";
  try {
    sessions.value = await api.browserSessions();
  } catch (cause) {
    loadingError.value = errorMessage(cause, t);
  } finally {
    loading.value = false;
  }
}

async function signOut(session: BrowserSession): Promise<void> {
  if (revokingId.value) return;
  revokingId.value = session.id;
  actionError.value = "";
  try {
    const result = await api.revokeBrowserSession(session.id);
    if (!result.revoked) throw new Error(t("apiError"));
    if (result.isCurrent) {
      clearSession();
      await router.replace("/login");
      return;
    }
    await load();
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    revokingId.value = "";
  }
}

onMounted(load);
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsSessions") }}</h2>
        <p>{{ t("settingsSessionDescription") }}</p>
      </div>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
        {{ t("refresh") }}
      </FluentButton>
    </header>
    <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
    <div v-if="loading" class="box"><StatusState :loading="true" /></div>
    <section v-else-if="!loadingError" class="box" :aria-label="t('settingsSessions')">
      <p v-if="!sessions.length" class="settings-empty">{{ t("empty") }}</p>
      <ul v-else class="settings-list">
        <li v-for="session in sessions" :key="session.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ t("settingsOtherSession") }}
              <StatusBadge v-if="session.isCurrent" tone="brand">{{
                t("settingsCurrentSession")
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t("settingsSessionCreated") }} · {{ d(session.createdAt, "long") }}</span>
              <span>{{ t("settingsSessionExpires") }} · {{ d(session.expiresAt, "long") }}</span>
            </div>
          </div>
          <div class="settings-actions">
            <ConfirmButton
              :label="t('settingsSessionSignOut')"
              :prompt="
                session.isCurrent ? t('confirmSignOutCurrentSession') : t('confirmSignOutSession')
              "
              :busy="revokingId === session.id"
              :disabled="Boolean(revokingId)"
              @confirm="signOut(session)"
            />
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>
