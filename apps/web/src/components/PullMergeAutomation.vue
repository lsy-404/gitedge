<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AutoMergeStatus, MergeMethod, PullMergeQueueStatus } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";

const props = defineProps<{
  repositoryId: string;
  number: number;
  headOid: string;
  method: MergeMethod;
  draft: boolean;
}>();
const emit = defineEmits<{ queueRequired: [required: boolean]; changed: [] }>();
const { t } = useI18n();
const autoMerge = ref<AutoMergeStatus | null>(null);
const queue = ref<PullMergeQueueStatus | null>(null);
const busy = ref(false);
const error = ref("");

const queued = computed(() => queue.value?.position != null);
const waitingReason = computed(() => {
  const code = autoMerge.value?.waitingOn?.code;
  if (!code) return "";
  if (code === "draft") return t("autoMergeBlocked_draft");
  return autoMerge.value?.waitingOn?.message ?? t("autoMergeBlocked_other");
});

async function refresh(): Promise<void> {
  try {
    [autoMerge.value, queue.value] = await Promise.all([
      api.autoMerge(props.repositoryId, props.number),
      api.pullMergeQueue(props.repositoryId, props.number),
    ]);
    emit("queueRequired", queue.value.required);
  } catch (cause) {
    error.value = errorMessage(cause, t);
  }
}

async function run(action: () => Promise<void>, fallback: string): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await action();
    await refresh();
    emit("changed");
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.code === "queue_full"
        ? t("mergeQueueFull")
        : cause instanceof ApiError && cause.code === "conflict" && cause.status === 409
          ? t("mergeQueueBusy")
          : `${fallback} ${errorMessage(cause, t)}`;
  } finally {
    busy.value = false;
  }
}

const payload = () => ({ method: props.method, expectedHeadOid: props.headOid });

watch(() => [props.repositoryId, props.number, props.headOid], refresh, { immediate: true });
</script>

<template>
  <div v-if="autoMerge && queue" class="merge-automation">
    <section v-if="queue.required || queued" class="merge-automation-section">
      <h4>{{ t("mergeQueueTitle") }}</h4>
      <p v-if="queue.required && !queued" class="muted">{{ t("mergeQueueRequired") }}</p>
      <p v-if="queued">
        {{ t("mergeQueuePosition", { position: queue.position, length: queue.length }) }}
        <span v-if="queue.processing" class="muted"> · {{ t("mergeQueueMerging") }}</span>
      </p>
      <FluentButton
        v-if="!queued"
        type="button"
        tone="primary"
        :disabled="busy || draft || !headOid"
        @click="
          run(
            () => api.enqueuePull(repositoryId, number, payload()).then(() => undefined),
            t('mergeQueueFailed')
          )
        "
      >
        {{ t("mergeQueueAdd") }}
      </FluentButton>
      <FluentButton
        v-else
        type="button"
        :disabled="busy || queue.processing"
        @click="
          run(
            () => api.dequeuePull(repositoryId, number).then(() => undefined),
            t('mergeQueueFailed')
          )
        "
      >
        {{ t("mergeQueueRemove") }}
      </FluentButton>
    </section>
    <section v-if="!queued" class="merge-automation-section">
      <h4>{{ t("autoMergeTitle") }}</h4>
      <template v-if="autoMerge.enabled">
        <p>
          {{ t("autoMergeEnabledBy", { name: autoMerge.enabledBy, method: autoMerge.method }) }}
        </p>
        <p class="muted">
          {{
            autoMerge.waitingOn
              ? t("autoMergeWaiting", { reason: waitingReason })
              : t("autoMergeReady")
          }}
        </p>
        <FluentButton
          type="button"
          :disabled="busy"
          @click="
            run(
              () => api.disableAutoMerge(repositoryId, number).then(() => undefined),
              t('autoMergeFailed')
            )
          "
        >
          {{ t("autoMergeDisable") }}
        </FluentButton>
      </template>
      <template v-else>
        <p class="muted">{{ t("autoMergeDescription") }}</p>
        <p class="muted">{{ t("autoMergeHeadHint") }}</p>
        <FluentButton
          type="button"
          :disabled="busy || draft || !headOid"
          @click="
            run(
              () => api.enableAutoMerge(repositoryId, number, payload()).then(() => undefined),
              t('autoMergeFailed')
            )
          "
        >
          {{ t("autoMergeEnable") }}
        </FluentButton>
      </template>
    </section>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  </div>
</template>
