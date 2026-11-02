<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type {
  SigningRequestEntry,
  SigningRequest,
} from "../../../../packages/contracts/src/signing";
import { api, errorMessage } from "../lib/api";
import type { BadgeTone } from "../lib/tasks";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const entries = ref<SigningRequestEntry[]>([]);
const truncated = ref(false);
const loading = ref(true);
const error = ref("");
let controller: AbortController | null = null;

const TONES: Record<SigningRequest["state"], BadgeTone> = {
  accepted: "neutral",
  awaiting_source: "neutral",
  queued: "warning",
  running: "brand",
  succeeded: "success",
  failed: "danger",
  cancelled: "done",
};

async function load(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.recentSigningRequests(current.signal);
    if (current.signal.aborted) return;
    entries.value = result.requests;
    truncated.value = result.truncated;
  } catch (cause) {
    if (!current.signal.aborted) error.value = errorMessage(cause, t);
  } finally {
    if (controller === current) loading.value = false;
  }
}

onMounted(load);
onUnmounted(() => controller?.abort());
</script>

<template>
  <section class="settings-panel">
    <header class="settings-header">
      <div>
        <h2>{{ t("settingsCodeSigning") }}</h2>
        <p>{{ t("codeSigningDescription") }}</p>
      </div>
      <div class="settings-actions">
        <RouterLink
          class="btn"
          :to="{ path: '/settings/account', query: { section: 'runners' } }"
          >{{ t("codeSigningManage") }}</RouterLink
        >
        <FluentButton type="button" tone="subtle" :busy="loading" @click="load">
          {{ t("refresh") }}
        </FluentButton>
      </div>
    </header>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    <div v-if="loading && !entries.length" class="box"><StatusState :loading="true" /></div>
    <section
      v-else-if="!error || entries.length"
      class="box"
      :aria-label="t('settingsCodeSigning')"
    >
      <p v-if="!entries.length" class="settings-empty">{{ t("codeSigningEmpty") }}</p>
      <ul v-else class="settings-list">
        <li
          v-for="{ request, submission } in entries"
          :key="request.id"
          class="box-row settings-item"
        >
          <div class="settings-item-copy">
            <div class="row-title">
              {{ request.profile }}
              <StatusBadge :tone="TONES[request.state]">{{
                t(`codeSigningState_${request.state}`)
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t(`runnerSigningPlatform_${request.platform}`) }}</span>
              <span>{{ t("codeSigningVersion", { version: submission.version }) }}</span>
              <span>{{ t(`codeSigningStage_${request.stage}`) }}</span>
            </div>
            <div class="row-meta">
              <span>{{ t("codeSigningCreated") }} · {{ d(request.createdAt, "long") }}</span>
              <span v-if="request.completedAt !== null"
                >{{ t("codeSigningCompleted") }} · {{ d(request.completedAt, "long") }}</span
              >
            </div>
          </div>
        </li>
      </ul>
      <p v-if="truncated" class="row-meta">
        {{ t("codeSigningTruncated", { count: entries.length }) }}
      </p>
    </section>
  </section>
</template>
