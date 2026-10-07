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
  <section class="preference-panel">
    <div class="settings-section-heading">
      <div>
        <h2 class="settings-page-title">{{ t("settingsSessions") }}</h2>
        <p class="muted">{{ t("settingsSessionDescription") }}</p>
      </div>
      <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
        {{ t("refresh") }}
      </FluentButton>
    </div>
    <NoticeBar v-if="loadingError" intent="error">{{ loadingError }}</NoticeBar>
    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
    <StatusState v-if="loading" :loading="true" />
    <div v-else-if="!loadingError && !sessions.length" class="settings-surface muted">
      {{ t("empty") }}
    </div>
    <div v-else class="credential-list">
      <article v-for="session in sessions" :key="session.id" class="settings-surface">
        <div class="credential-row">
          <div>
            <h3>{{ t("settingsOtherSession") }}</h3>
            <p class="muted">
              {{ t("settingsSessionCreated") }} · {{ d(session.createdAt, "long") }}
            </p>
            <p class="muted">
              {{ t("settingsSessionExpires") }} · {{ d(session.expiresAt, "long") }}
            </p>
            <StatusBadge :tone="session.isCurrent ? 'brand' : 'neutral'">
              {{ session.isCurrent ? t("settingsCurrentSession") : t("settingsOtherSession") }}
            </StatusBadge>
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
        </div>
      </article>
    </div>
  </section>
</template>
