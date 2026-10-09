<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AutoMergeStatus, MergeMethod, PullMergeQueueStatus } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import { mergePolicyCode } from "../lib/mergePolicy";
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

/** Blockers outside the shared merge-policy messages that only auto-merge reports. */
const autoMergeBlockerCodes = ["draft", "forbidden", "review_limit", "check_limit"] as const;
const METHOD_KEYS: Record<MergeMethod, string> = {
  merge: "repoMergeMethodMerge",
  squash: "repoMergeMethodSquash",
  rebase: "repoMergeMethodRebase",
};

const queued = computed(() => queue.value?.position != null);
function blockerText(code: string | null | undefined): string | null {
  const policy = mergePolicyCode(code);
  if (policy) return t(`mergeError_${policy}`);
  const own = autoMergeBlockerCodes.find((candidate) => candidate === code);
  return own ? t(`autoMergeBlocked_${own}`) : null;
}
const waitingReason = computed(
  () => blockerText(autoMerge.value?.waitingOn?.code) ?? t("autoMergeBlocked_other")
);
const enabledMethod = computed(() =>
  autoMerge.value?.method ? t(METHOD_KEYS[autoMerge.value.method]) : ""
);

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

function failureText(cause: unknown, fallback: string, busyKey?: string): string {
  if (cause instanceof ApiError) {
    if (cause.code === "queue_full") return t("mergeQueueFull");
    if (cause.code === "stale_commit") return t("autoMergeStale");
    if (busyKey && cause.code === "conflict" && cause.status === 409) return t(busyKey);
    const blocker = blockerText(cause.code);
    if (blocker) return `${fallback} ${blocker}`;
  }
  return `${fallback} ${errorMessage(cause, t)}`;
}

async function run(
  action: () => Promise<unknown>,
  fallback: string,
  busyKey?: string
): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    await action();
    await refresh();
    emit("changed");
  } catch (cause) {
    error.value = failureText(cause, fallback, busyKey);
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
        @click="run(() => api.enqueuePull(repositoryId, number, payload()), t('mergeQueueFailed'))"
      >
        {{ t("mergeQueueAdd") }}
      </FluentButton>
      <FluentButton
        v-else
        type="button"
        :disabled="busy || queue.processing"
        @click="
          run(() => api.dequeuePull(repositoryId, number), t('mergeQueueFailed'), 'mergeQueueBusy')
        "
      >
        {{ t("mergeQueueRemove") }}
      </FluentButton>
    </section>
    <section v-if="!queued" class="merge-automation-section">
      <h4>{{ t("autoMergeTitle") }}</h4>
      <template v-if="autoMerge.enabled">
        <p>
          {{ t("autoMergeEnabledBy", { name: autoMerge.enabledBy, method: enabledMethod }) }}
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
          @click="run(() => api.disableAutoMerge(repositoryId, number), t('autoMergeFailed'))"
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
            run(() => api.enableAutoMerge(repositoryId, number, payload()), t('autoMergeFailed'))
          "
        >
          {{ t("autoMergeEnable") }}
        </FluentButton>
      </template>
    </section>
    <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
  </div>
</template>
