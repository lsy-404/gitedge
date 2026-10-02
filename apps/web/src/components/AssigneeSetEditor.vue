<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import type { Assignee, AssigneeCandidate, AssigneeRef } from "../lib/api";
import { assigneeKey, assigneeRef, parseAssigneeKey } from "../lib/tasks";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";

/**
 * One role's assignee set. Humans and agents are chosen from the same candidate list; each change
 * emits the complete next set because the server replaces a role's set as a whole.
 */
const props = defineProps<{
  label: string;
  addLabel: string;
  emptyText: string;
  assignees: readonly Assignee[];
  candidates: readonly AssigneeCandidate[];
  canEdit: boolean;
  saving?: boolean;
}>();
const emit = defineEmits<{ change: [assignees: AssigneeRef[]] }>();

const { t } = useI18n();
const labelId = useId();
/** The dropdown is remounted after each pick so it returns to its placeholder. */
const pickerKey = ref(0);
const available = computed(() => {
  const taken = new Set(props.assignees.map(assigneeKey));
  return props.candidates.filter((candidate) => !taken.has(assigneeKey(candidate)));
});

function candidateLabel(candidate: AssigneeCandidate): string {
  if (candidate.kind === "user") return candidate.name;
  const owner = candidate.ownerName ? ` (${t("agentOwner", { owner: candidate.ownerName })})` : "";
  return `${candidate.name} · ${t("agent")}${owner}`;
}

function add(value: string) {
  const picked = parseAssigneeKey(value, available.value);
  if (!picked) return;
  pickerKey.value += 1;
  emit("change", [...props.assignees.map(assigneeRef), picked]);
}

function remove(target: Assignee) {
  emit(
    "change",
    props.assignees.filter((entry) => assigneeKey(entry) !== assigneeKey(target)).map(assigneeRef)
  );
}
</script>

<template>
  <div class="assignee-set" role="group" :aria-labelledby="labelId">
    <p :id="labelId" class="eyebrow">{{ label }}</p>
    <ul v-if="assignees.length" class="assignee-list">
      <li v-for="entry in assignees" :key="assigneeKey(entry)">
        <span class="assignee-name">{{ entry.name }}</span>
        <StatusBadge :tone="entry.kind === 'agent' ? 'brand' : 'neutral'">{{
          entry.kind === "agent" ? t("agent") : t("assigneeHuman")
        }}</StatusBadge>
        <fluent-button
          v-if="canEdit"
          type="button"
          appearance="transparent"
          size="small"
          :disabled="saving"
          :aria-label="t('assigneeRemove', { name: entry.name })"
          @click="remove(entry)"
          >×</fluent-button
        >
      </li>
    </ul>
    <p v-else class="muted assignee-empty">{{ emptyText }}</p>
    <SelectField
      v-if="canEdit && available.length"
      :key="pickerKey"
      :model-value="''"
      :label="addLabel"
      :disabled="saving"
      @update:model-value="add"
    >
      <option value="">{{ t("assigneePick") }}</option>
      <option
        v-for="candidate in available"
        :key="assigneeKey(candidate)"
        :value="assigneeKey(candidate)"
      >
        {{ candidateLabel(candidate) }}
      </option>
    </SelectField>
  </div>
</template>

<style scoped>
.assignee-set {
  display: grid;
  gap: var(--spacingVerticalS);
  min-width: 0;
  align-content: start;
}
.assignee-set .eyebrow {
  margin: 0;
}
.assignee-list {
  display: grid;
  gap: var(--spacingVerticalXS);
  margin: 0;
  padding: 0;
  list-style: none;
}
.assignee-list li {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalS);
  min-height: 32px;
}
.assignee-name {
  min-width: 0;
  overflow-wrap: anywhere;
  font-weight: var(--fontWeightSemibold);
}
.assignee-list fluent-button {
  margin-left: auto;
}
.assignee-empty {
  font-size: var(--fontSizeBase200);
}
</style>
