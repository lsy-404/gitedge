<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, errorMessage, type MergeMethod, type MergeRequirements } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{
  repositoryId: string;
  number: number;
  headOid: string;
  method: MergeMethod;
}>();
const emit = defineEmits<{ evaluated: [ready: boolean] }>();
const { t } = useI18n();
const result = ref<MergeRequirements | null>(null);
const loading = ref(false);
const error = ref("");
let version = 0;
async function refresh() {
  const requestVersion = ++version;
  result.value = null;
  loading.value = true;
  error.value = "";
  emit("evaluated", false);
  try {
    const current = await api.mergeRequirements(
      props.repositoryId,
      props.number,
      props.headOid,
      props.method
    );
    if (requestVersion !== version) return;
    result.value = current;
    emit("evaluated", current.ready);
  } catch (cause) {
    if (requestVersion === version) error.value = errorMessage(cause, t);
  } finally {
    if (requestVersion === version) loading.value = false;
  }
}
watch(() => [props.repositoryId, props.number, props.headOid, props.method], refresh, {
  immediate: true,
});
onUnmounted(() => {
  version++;
});
</script>

<template>
  <section class="merge-requirements" :aria-label="t('mergeRequirementsTitle')">
    <h4 class="requirements-title">{{ t("mergeRequirementsTitle") }}</h4>
    <StatusState :loading="loading" :error="error" @retry="refresh" />
    <template v-if="result">
      <ul class="merge-status">
        <li v-for="requirement in result.requirements" :key="requirement.id" class="box-row">
          <AppIcon
            :name="
              requirement.status === 'satisfied'
                ? 'checkCircle'
                : requirement.status === 'unsatisfied'
                  ? 'alert'
                  : 'clock'
            "
            :class="{
              'state-success': requirement.status === 'satisfied',
              'state-danger': requirement.status === 'unsatisfied',
            }"
          />
          <span>
            {{ t(`mergeRequirement_${requirement.id}`) }} —
            {{ t(`mergeRequirementStatus_${requirement.status}`) }}
            <span v-if="requirement.requiredCount !== undefined">
              ·
              {{
                t("mergeApprovalCount", {
                  actual: requirement.actualCount,
                  required: requirement.requiredCount,
                })
              }}</span
            >
            <span v-if="requirement.blockerCode === 'independent_approval_unverified'">
              · {{ t("mergeError_independent_approval_unverified") }}</span
            >
          </span>
        </li>
      </ul>
      <p class="muted requirement-hint">{{ t("mergeRequirementsAtMergeHint") }}</p>
      <ul v-if="result.excludedApprovals.length" class="excluded-approvals">
        <li v-for="entry in result.excludedApprovals" :key="`${entry.name}:${entry.reason}`">
          {{
            t("mergeExcludedApproval", {
              name: entry.name,
              reason: t(`mergeExcluded_${entry.reason}`),
            })
          }}
        </li>
      </ul>
      <FluentButton type="button" size="small" @click="refresh">{{ t("refresh") }}</FluentButton>
    </template>
  </section>
</template>

<style scoped>
.requirements-title {
  margin: var(--space-3) var(--space-4);
}
.state-success {
  color: var(--success-fg);
}
.state-danger {
  color: var(--danger-fg);
}
.requirement-hint,
.excluded-approvals {
  margin: var(--space-3) var(--space-4);
}
.merge-requirements > button {
  margin: 0 var(--space-4) var(--space-3);
}
.merge-status {
  list-style: none;
  margin: 0;
  padding: 0;
}
.merge-status li {
  display: flex;
  gap: var(--space-2);
  align-items: start;
}
</style>
