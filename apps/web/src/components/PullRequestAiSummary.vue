<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { AiSummaryErrorCode, AiSummaryState } from "../../../../packages/contracts/src/index";
import type { Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import "../styles/ai-summary.css";

const props = defineProps<{
  repository: Repository;
  number: number;
  /** Current head of the pull request; a summary of another commit is shown as outdated. */
  headOid: string;
  open: boolean;
}>();
const { t, d } = useI18n();
const POLL_MS = 4000;
const POLL_LIMIT = 45;
const jobErrors: Readonly<Record<AiSummaryErrorCode, string>> = {
  disabled: "aiSummaryErrorDisabled",
  diff_unavailable: "aiSummaryErrorDiff",
  rate_limited: "aiSummaryErrorRate",
  model_error: "aiSummaryErrorModel",
  invalid_output: "aiSummaryErrorOutput",
  timeout: "aiSummaryErrorTimeout",
};

const state = ref<AiSummaryState | null>(null);
const loading = ref(true);
const error = ref("");
const actionError = ref("");
const requesting = ref(false);
let loadVersion = 0;
let timer: number | null = null;
let polls = 0;

const visible = computed(() => state.value !== null && state.value.unavailable === null);
const summary = computed(() => state.value?.summary ?? null);
const job = computed(() => state.value?.job ?? null);
const pending = computed(
  () => requesting.value || job.value?.status === "queued" || job.value?.status === "running"
);
const failure = computed(() => {
  const code = job.value?.status === "failed" ? job.value.errorCode : null;
  return code ? t(jobErrors[code]) : job.value?.status === "failed" ? t("aiSummaryErrorModel") : "";
});
const canRegenerate = computed(
  () => props.repository.canWrite && !props.repository.archived && props.open
);
const stale = computed(
  () => summary.value !== null && props.headOid !== "" && summary.value.headOid !== props.headOid
);
const sections = computed(() =>
  summary.value
    ? (
        [
          ["aiSummaryChanges", summary.value.content.notableChanges],
          ["aiSummaryRisks", summary.value.content.riskAreas],
          ["aiSummaryFocus", summary.value.content.reviewerFocus],
        ] as const
      ).filter(([, items]) => items.length > 0)
    : []
);

function stopPolling() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}
function schedulePoll() {
  stopPolling();
  if (!pending.value || polls >= POLL_LIMIT) return;
  polls++;
  timer = window.setTimeout(() => void refresh(), POLL_MS);
}

async function refresh() {
  const version = loadVersion;
  try {
    const next = await api.aiSummary(props.repository.id, props.number);
    if (version !== loadVersion) return;
    state.value = next;
    error.value = "";
  } catch (cause) {
    if (version !== loadVersion) return;
    error.value = errorMessage(cause, t);
  }
  schedulePoll();
}

async function load() {
  loadVersion++;
  polls = 0;
  loading.value = true;
  state.value = null;
  await refresh();
  loading.value = false;
}

async function regenerate() {
  actionError.value = "";
  requesting.value = true;
  try {
    state.value = await api.regenerateAiSummary(props.repository.id, props.number);
    polls = 0;
  } catch (cause) {
    actionError.value = errorMessage(cause, t, { 409: "aiSummaryRegenerateRejected" });
  } finally {
    requesting.value = false;
  }
  schedulePoll();
}

watch(() => [props.repository.id, props.number], load, { immediate: true });
watch(
  () => props.headOid,
  () => {
    polls = 0;
    void refresh();
  }
);
onBeforeUnmount(() => {
  loadVersion++;
  stopPolling();
});
</script>

<template>
  <section
    v-if="loading || error || visible"
    class="box ai-summary"
    aria-labelledby="ai-summary-title"
  >
    <header class="box-header ai-summary-header">
      <h3 id="ai-summary-title">{{ t("aiSummaryTitle") }}</h3>
      <StatusBadge tone="brand">{{ t("aiSummaryBadge") }}</StatusBadge>
      <FluentButton
        v-if="canRegenerate && visible"
        class="ai-summary-action"
        size="small"
        type="button"
        :disabled="pending"
        @click="regenerate"
      >
        {{ pending ? t("aiSummaryRegenerating") : t("aiSummaryRegenerate") }}
      </FluentButton>
    </header>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <div v-else class="ai-summary-body">
      <p class="ai-summary-disclaimer">{{ t("aiSummaryDisclaimer") }}</p>
      <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
      <NoticeBar v-if="failure" intent="error">{{ failure }}</NoticeBar>
      <p v-if="pending" class="state" role="status">{{ t("aiSummaryPending") }}</p>
      <template v-if="summary">
        <NoticeBar v-if="summary.truncated" intent="warning">{{
          t("aiSummaryTruncated")
        }}</NoticeBar>
        <NoticeBar v-if="stale" intent="info">{{
          t("aiSummaryStale", { oid: summary.headOid.slice(0, 8) })
        }}</NoticeBar>
        <h4>{{ t("aiSummaryOverview") }}</h4>
        <p class="ai-summary-text">{{ summary.content.overview }}</p>
        <template v-for="[title, items] in sections" :key="title">
          <h4>{{ t(title) }}</h4>
          <ul class="ai-summary-list">
            <li v-for="item in items" :key="item">{{ item }}</li>
          </ul>
        </template>
        <p class="ai-summary-meta">
          {{ t("aiSummaryAuthor") }} ·
          {{
            t("aiSummaryMeta", {
              model: summary.model,
              oid: summary.headOid.slice(0, 8),
              date: d(summary.generatedAt, "long"),
            })
          }}
        </p>
      </template>
      <p v-else-if="!pending && !failure" class="state">{{ t("aiSummaryNone") }}</p>
    </div>
  </section>
</template>
