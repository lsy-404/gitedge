<script setup lang="ts">
import { useI18n } from "vue-i18n";
import TextField from "./TextField.vue";

defineProps<{
  branch: string;
  pullsEnabled: boolean;
  protectedBranch: boolean;
  targetBranch: string;
  targetBranchValid: boolean;
  saved?: boolean;
}>();
const message = defineModel<string>("message", { required: true });
const newBranch = defineModel<string>("newBranch", { required: true });
const createPull = defineModel<boolean>("createPull", { required: true });
const { t } = useI18n();
</script>

<template>
  <TextField v-model="message" required maxlength="500">{{ t("codeCommitMessage") }}</TextField>
  <div v-if="protectedBranch" class="branch-guidance" role="status">
    <strong>{{ t("codeProtectedEditNeedsBranch") }}</strong>
    <p>{{ t("codeProtectedBranchSource", { name: branch }) }}</p>
    <TextField v-model="newBranch" required maxlength="251">{{ t("codeNewBranchName") }}</TextField>
    <small v-if="!saved && newBranch && !targetBranchValid" class="field-error">{{
      t("codeBranchNameInvalidOrExists")
    }}</small>
  </div>
  <template v-else>
    <TextField v-model="newBranch" maxlength="251">{{ t("codeOptionalNewBranch") }}</TextField>
    <small v-if="!saved && newBranch && !targetBranchValid" class="field-error">{{
      t("codeBranchNameInvalidOrExists")
    }}</small>
  </template>
  <FluentCheckbox v-if="pullsEnabled && targetBranch && targetBranchValid" v-model="createPull">
    <slot name="pull-label">{{ t("codeCreatePullAfterSave") }}</slot>
  </FluentCheckbox>
</template>

<style scoped>
.branch-guidance {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
</style>
