<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { GitBranchSchema } from "../../../../packages/contracts/src/forge";
import { ApiError, api, type RepositoryBranch } from "../lib/api";
import type { Repository } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import TextField from "./TextField.vue";
import StatusBadge from "./StatusBadge.vue";
import NoticeBar from "./NoticeBar.vue";

const props = defineProps<{
  repository: Repository;
  selectedBranch: string;
  defaultBranch: string;
  refreshKey: number;
}>();
const emit = defineEmits<{
  select: [name: string];
  branchesLoaded: [branches: RepositoryBranch[]];
  changed: [];
}>();
const { t } = useI18n();
const branches = ref<RepositoryBranch[]>([]);
const expanded = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const branchName = ref("");
const pendingDelete = ref<RepositoryBranch | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (open: boolean) => {
    if (!open) pendingDelete.value = null;
  },
});
const sourceBranch = computed(
  () =>
    branches.value.find((branch) => branch.name === props.selectedBranch) ??
    branches.value.find((branch) => branch.name === props.defaultBranch) ??
    null
);
const branchNameAvailable = computed(() => {
  const name = branchName.value.trim();
  return (
    GitBranchSchema.safeParse(name).success &&
    !branches.value.some((branch) => branch.name === name)
  );
});
function branchError(cause: unknown) {
  error.value =
    cause instanceof ApiError && cause.status === 409
      ? t("codeBranchConflict")
      : cause instanceof ApiError && cause.status === 403
        ? t("codeBranchForbidden")
        : t("apiError");
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    branches.value = await api.repositoryBranches(props.repository.id);
    emit("branchesLoaded", branches.value);
  } catch (cause) {
    branchError(cause);
  } finally {
    loading.value = false;
  }
}
async function createBranch() {
  const source = sourceBranch.value;
  if (!source || !branchNameAvailable.value) return;
  saving.value = true;
  error.value = "";
  try {
    await api.createRepositoryBranch(props.repository.id, {
      name: branchName.value.trim(),
      source: source.name,
      expectedOid: source.oid,
    });
    const createdName = branchName.value.trim();
    branchName.value = "";
    await load();
    emit("changed");
    emit("select", createdName);
  } catch (cause) {
    branchError(cause);
  } finally {
    saving.value = false;
  }
}
async function deleteBranch() {
  const branch = pendingDelete.value;
  if (!branch || branch.protected || branch.isDefault) return;
  saving.value = true;
  error.value = "";
  try {
    await api.deleteRepositoryBranch(props.repository.id, {
      name: branch.name,
      expectedOid: branch.oid,
    });
    pendingDelete.value = null;
    await load();
    emit("changed");
    if (props.selectedBranch === branch.name) {
      const fallback = branches.value.find((item) => item.isDefault)?.name;
      if (fallback) emit("select", fallback);
    }
  } catch (cause) {
    branchError(cause);
  } finally {
    saving.value = false;
  }
}
watch(
  () => [props.repository.id, props.refreshKey],
  () => void load(),
  { immediate: true }
);
</script>

<template>
  <div class="branch-management">
    <FluentButton
      type="button"
      tone="secondary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
      ><AppIcon name="branch" />{{ t("codeManageBranches") }} ({{ branches.length }})</FluentButton
    >
    <section v-if="expanded" class="branch-panel box" :aria-label="t('branches')">
      <div class="box-header">
        <AppIcon name="branch" />
        <h2>{{ t("branches") }}</h2>
        <FluentButton
          type="button"
          tone="subtle"
          size="small"
          class="branch-refresh"
          :disabled="loading"
          @click="load"
        >
          {{ t("refresh") }}
        </FluentButton>
      </div>
      <p v-if="loading" class="muted">{{ t("loading") }}</p>
      <p v-else-if="!branches.length" class="muted">{{ t("codeNoBranchesYet") }}</p>
      <div
        v-for="branch in branches"
        :key="branch.name"
        class="branch-row"
        :class="{ selected: branch.name === selectedBranch }"
      >
        <FluentButton
          type="button"
          tone="subtle"
          class="branch-select"
          :aria-current="branch.name === selectedBranch ? 'true' : undefined"
          @click="emit('select', branch.name)"
        >
          <AppIcon name="branch" /><strong>{{ branch.name }}</strong>
          <StatusBadge v-if="branch.isDefault">{{ t("defaultBranch") }}</StatusBadge>
          <StatusBadge v-if="branch.protected" tone="warning">{{
            t("codeProtectedBranch")
          }}</StatusBadge>
          <code>{{ branch.oid.slice(0, 8) }}</code>
        </FluentButton>
        <span v-if="branch.rules.length" class="branch-rules">{{ branch.rules.join(" · ") }}</span>
        <FluentButton
          type="button"
          tone="subtle"
          size="small"
          :disabled="branch.isDefault || branch.protected || saving"
          :aria-label="t('codeDeleteBranch', { name: branch.name })"
          @click="pendingDelete = branch"
          >{{ t("delete") }}</FluentButton
        >
      </div>
      <form v-if="sourceBranch" class="branch-create" @submit.prevent="createBranch">
        <TextField v-model="branchName" maxlength="251" required>{{
          t("codeNewBranchName")
        }}</TextField>
        <small class="muted">{{ t("codeBranchSource", { name: sourceBranch.name }) }}</small>
        <FluentButton type="submit" tone="primary" :disabled="saving || !branchNameAvailable">
          {{ saving ? t("loading") : t("codeCreateBranch") }}
        </FluentButton>
      </form>
      <NoticeBar v-if="error" intent="error" class="branch-error">{{ error }}</NoticeBar>
    </section>
    <FluentDialog v-model:open="deleteOpen" :label="t('codeConfirmDeleteBranch')">
      <template #title>{{ t("codeConfirmDeleteBranch") }}</template>
      <p>{{ t("codeDeleteBranchConfirmation", { name: pendingDelete?.name ?? "" }) }}</p>
      <template #footer>
        <FluentButton type="button" @click="deleteOpen = false">{{ t("cancel") }}</FluentButton>
        <FluentButton type="button" tone="primary" :disabled="saving" @click="deleteBranch">
          {{ t("delete") }}
        </FluentButton>
      </template>
    </FluentDialog>
  </div>
</template>

<style scoped>
.branch-management {
  position: relative;
}
.branch-panel {
  position: absolute;
  z-index: 4;
  top: calc(100% + var(--space-2));
  left: 0;
  width: min(680px, 90vw);
  max-height: min(70vh, 620px);
  overflow: auto;
  background: var(--bg-overlay);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}
.branch-refresh {
  margin-left: auto;
}
.branch-panel > p {
  padding: var(--space-3) var(--space-4);
}
.branch-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-1) var(--space-2);
  align-items: center;
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}
.branch-row.selected {
  background: var(--bg-selected);
  box-shadow: inset 3px 0 var(--accent-strong);
}
.branch-row.selected .branch-select {
  font-weight: var(--font-weight-semibold);
}
.branch-select {
  justify-content: flex-start;
  min-width: 0;
}
.branch-select strong {
  overflow-wrap: anywhere;
}
.branch-select code {
  margin-left: auto;
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.branch-rules {
  grid-column: 1;
  padding-left: var(--space-3);
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.branch-create {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  align-items: end;
  padding: var(--space-4);
}
.branch-error {
  margin: 0 var(--space-4) var(--space-4);
}
.branch-create small {
  grid-column: 1;
}
.branch-create :deep(button) {
  grid-column: 2;
  grid-row: 1 / span 2;
}
@media (max-width: 560px) {
  .branch-management {
    position: static;
  }
  .branch-panel {
    right: 0;
    width: auto;
  }
}
</style>
