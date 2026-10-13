<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorMessage } from "../lib/api";
import type { MergeCandidate } from "../../../../packages/contracts/src/merge-candidates";
import NoticeBar from "./NoticeBar.vue";
const props = defineProps<{
  repositoryId: string;
  number: number;
  baseOid: string;
  headOid: string;
}>();
const { t } = useI18n();
const candidate = ref<MergeCandidate | null>(null);
const error = ref("");
let version = 0;
async function load() {
  const current = ++version;
  try {
    const result = await api.mergeCandidate(props.repositoryId, props.number);
    if (current !== version) return;
    candidate.value = result;
    error.value = "";
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  }
}
watch(
  () => [props.repositoryId, props.number, props.baseOid, props.headOid],
  () => {
    candidate.value = null;
    void load();
  },
  { immediate: true }
);
const timer = setInterval(() => {
  void load();
}, 15_000);
onUnmounted(() => {
  version++;
  clearInterval(timer);
});
</script>

<template>
  <section v-if="candidate" class="box">
    <div class="box-header">
      <strong>{{ t("mergeCandidateTitle") }}</strong>
    </div>
    <div class="box-row">
      <p>{{ t(`mergeCandidate_${candidate.status}`) }}</p>
      <p class="muted">
        {{ candidate.baseOid.slice(0, 12) }} + {{ candidate.headOid.slice(0, 12) }}
      </p>
      <code v-if="candidate.resultOid">{{ candidate.resultOid.slice(0, 12) }}</code>
      <NoticeBar
        v-if="candidate.baseOid !== baseOid || candidate.headOid !== headOid"
        intent="warning"
        >{{ t("mergeCandidateStale") }}</NoticeBar
      >
      <ul v-if="candidate.checks.length">
        <li v-for="check in candidate.checks" :key="check.name">
          {{ check.name }} · {{ t(`mergeCandidateCheck_${check.conclusion ?? check.status}`) }}
        </li>
      </ul>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
    </div>
  </section>
</template>
