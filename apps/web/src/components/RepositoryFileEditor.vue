<script setup lang="ts">
import { repositoryCodeLocation } from "../lib/gitGraphView";
import { computed, ref, watch } from "vue";
import { useUnsavedGuard } from "../lib/unsavedGuard";
import { useI18n } from "vue-i18n";
import { editablePath } from "../../../../packages/contracts/src/repository-controls";
import type { GitFile, GitTreeEntry, Repository, RepositoryBranch } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { useCommitTarget } from "../lib/commitTarget";
import { commitPayload, type StagedChange } from "../lib/repositoryCommit";
import AppIcon from "./AppIcon.vue";
import CommitTargetFields from "./CommitTargetFields.vue";
import NoticeBar from "./NoticeBar.vue";
import TextAreaField from "./TextAreaField.vue";
import TextField from "./TextField.vue";

type SavedFile = { oid: string; branch: string; path: string; deleted?: boolean };
const props = defineProps<{
  repository: Repository;
  branch: string;
  expectedOid: string | null;
  branchInfo: RepositoryBranch | null;
  branches: RepositoryBranch[];
  file: GitFile | null;
  entry: GitTreeEntry | null;
  initialPath?: string;
}>();
const emit = defineEmits<{ close: []; saved: [result: SavedFile]; changed: [] }>();
const { t } = useI18n();
const path = ref(props.file?.path ?? props.initialPath ?? "");
const content = ref(props.file?.content ?? "");
const target = useCommitTarget(
  () => props.branches,
  () => props.branchInfo
);
const { message, newBranch, createPull, protectedRejected, protectedBranch, targetBranch } = target;
const { targetBranchValid } = target;
const saving = ref(false);
const saveError = ref("");
const conflict = ref(false);
const saved = ref<SavedFile | null>(null);
const pullCreated = ref(false);
const createdPullNumber = ref<number | null>(null);
const pullSaving = ref(false);
const pullError = ref("");
const deleteOpen = ref(false);
const isNew = computed(() => props.file === null);
const dirty = computed(
  () =>
    saved.value === null &&
    (content.value !== (props.file?.content ?? "") ||
      message.value.trim() !== "" ||
      path.value !== (props.file?.path ?? props.initialPath ?? ""))
);
const { confirmDiscard } = useUnsavedGuard(dirty);
const regularTextFile = computed(() => {
  if (isNew.value) return true;
  return Boolean(
    props.file &&
    !props.file.binary &&
    props.file.content !== null &&
    props.file.size <= 1_000_000 &&
    props.entry?.type === "blob" &&
    (props.entry.mode === "100644" || props.entry.mode === "100755")
  );
});
const directlyEditable = computed(
  () =>
    props.repository.onlineEditingEnabled &&
    props.repository.canWrite &&
    !props.repository.archived &&
    regularTextFile.value
);
const contentBytes = computed(() => new TextEncoder().encode(content.value).byteLength);
const trimmedPath = computed(() => path.value.trim());
const renamed = computed(() => !isNew.value && trimmedPath.value !== props.file?.path);
const contentChanged = computed(() => content.value !== (props.file?.content ?? ""));
const canSave = computed(
  () =>
    directlyEditable.value &&
    editablePath(trimmedPath.value) &&
    (isNew.value || renamed.value || contentChanged.value) &&
    message.value.trim().length > 0 &&
    contentBytes.value <= 1_000_000 &&
    targetBranchValid.value
);
const canDelete = computed(
  () =>
    directlyEditable.value &&
    Boolean(props.file) &&
    message.value.trim().length > 0 &&
    targetBranchValid.value
);
const pullStatus = computed(() => {
  if (!createPull.value) return t("codePullNotRequested");
  if (pullCreated.value) return t("codePullCreated");
  if (pullSaving.value) return t("loading");
  return pullError.value || t("codePullPending");
});
const compareUrl = computed(
  () =>
    `/${props.repository.owner}/${props.repository.name}/compare?base=${encodeURIComponent(props.expectedOid ?? "")}&head=${encodeURIComponent(props.branch)}`
);
watch(
  () => [props.file?.oid, props.branch, props.expectedOid],
  () => {
    if (saved.value) return;
    path.value = props.file?.path ?? props.initialPath ?? "";
    content.value = props.file?.content ?? "";
    target.reset();
    saved.value = null;
    conflict.value = false;
    pullCreated.value = false;
    createdPullNumber.value = null;
    pullError.value = "";
  }
);
function saveErrorFor(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 409) return t("codeEditConflict");
  if (cause instanceof ApiError && cause.status === 403) {
    protectedRejected.value = true;
    return t("codeProtectedEditNeedsBranch");
  }
  if (cause instanceof ApiError && cause.status === 413) return t("codeFileTooLarge");
  return t("apiError");
}
function fileChanges(): StagedChange[] {
  const body = { op: "put" as const, path: trimmedPath.value, content: new Blob([content.value]) };
  if (!props.file || !renamed.value) return [body];
  if (!contentChanged.value) return [{ op: "move", from: props.file.path, to: trimmedPath.value }];
  return [{ op: "delete", path: props.file.path }, body];
}
async function commitChanges(changes: StagedChange[]): Promise<SavedFile | null> {
  saving.value = true;
  saveError.value = "";
  conflict.value = false;
  try {
    const payload = commitPayload(
      {
        branch: props.branch,
        ...(targetBranch.value ? { newBranch: targetBranch.value } : {}),
        expectedOid: props.expectedOid,
        message: message.value.trim(),
      },
      changes
    );
    if (!payload) {
      saveError.value = t("codeEditInvalid");
      return null;
    }
    const result = await api.commitRepositoryChanges(props.repository.id, payload);
    return { ...result, path: trimmedPath.value };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) conflict.value = true;
    saveError.value = saveErrorFor(cause);
    return null;
  } finally {
    saving.value = false;
  }
}
async function saveFile() {
  if (!canSave.value) return;
  const result = await commitChanges(fileChanges());
  if (!result) return;
  saved.value = result;
  if (createPull.value) await createPullRequest(false);
  emit("saved", result);
  emit("changed");
}
async function createPullRequest(notifyChange = true) {
  const result = saved.value;
  if (!result || !props.repository.pullsEnabled || result.branch === props.branch) return;
  pullSaving.value = true;
  pullError.value = "";
  try {
    const pull = await api.createPullRequest(props.repository.id, {
      title: message.value.trim(),
      body: "",
      baseRef: props.branch,
      headRef: result.branch,
    });
    pullCreated.value = true;
    createdPullNumber.value = pull.number;
    if (notifyChange) emit("changed");
  } catch {
    pullError.value = t("codePullCreateFailed");
  } finally {
    pullSaving.value = false;
  }
}
async function deleteFile() {
  if (!props.file || !canDelete.value) return;
  const result = await commitChanges([{ op: "delete", path: props.file.path }]);
  if (!result) return;
  saved.value = { ...result, path: props.file.path, deleted: true };
  deleteOpen.value = false;
  if (createPull.value) await createPullRequest(false);
  emit("saved", saved.value);
  emit("changed");
}
function close() {
  if (!confirmDiscard()) return;
  emit("close");
}
</script>

<template>
  <section class="file-editor box" :aria-label="t('codeEditFile')">
    <div class="box-header">
      <div>
        <h2>{{ isNew ? t("codeNewFile") : t("codeEditFile") }}</h2>
        <p v-if="!saved" class="muted">
          {{ t("codeEditAgainst", { branch, oid: expectedOid ?? t("codeEmptyHead") }) }}
        </p>
      </div>
      <FluentButton type="button" tone="subtle" :disabled="saving || pullSaving" @click="close"
        ><AppIcon name="close" />{{ t("cancel") }}</FluentButton
      >
    </div>
    <p v-if="!regularTextFile" class="editor-body muted" role="status">
      {{ t("codeNotEditable") }}
    </p>
    <form v-else class="form-stack editor-body" @submit.prevent="saveFile">
      <fieldset class="editor-fields" :disabled="Boolean(saved)">
        <TextField
          v-model="path"
          required
          maxlength="1000"
          :hint="isNew ? undefined : t('codeRenameHint')"
          >{{ t("codeFilePath") }}</TextField
        >
        <small v-if="trimmedPath && !editablePath(trimmedPath)" class="field-error">{{
          t("codePathInvalid")
        }}</small>
        <TextAreaField
          v-model="content"
          :label="t('codeFileContent')"
          rows="18"
          maxlength="1000000"
          spellcheck="false"
        />
        <p class="muted">{{ t("codeFileSize", { bytes: contentBytes }) }}</p>
        <CommitTargetFields
          v-model:message="message"
          v-model:new-branch="newBranch"
          v-model:create-pull="createPull"
          :branch="branch"
          :pulls-enabled="repository.pullsEnabled"
          :protected-branch="protectedBranch"
          :target-branch="targetBranch"
          :target-branch-valid="targetBranchValid"
          :saved="Boolean(saved)"
        />
      </fieldset>
      <div v-if="saved" class="save-result" role="status">
        <strong>{{ t("codeFileSaved", { branch: saved.branch }) }}</strong>
        <RouterLink
          v-if="!saved.deleted"
          :to="
            repositoryCodeLocation(repository.owner, repository.name, 'blob', saved.path, saved.oid)
          "
          >{{ t("codeViewCommittedFile") }}</RouterLink
        >
        <RouterLink
          v-if="pullCreated && createdPullNumber !== null"
          :to="`/${repository.owner}/${repository.name}/pulls/${createdPullNumber}`"
          >{{ t("codeViewPullRequest") }}</RouterLink
        >
        <p>{{ t("codePullStatus", { status: pullStatus }) }}</p>
        <FluentButton
          v-if="createPull && !pullCreated && !pullSaving"
          type="button"
          @click="createPullRequest"
          >{{ t("codeRetryPullCreate") }}</FluentButton
        >
      </div>
      <NoticeBar v-if="pullError" intent="error">{{ pullError }}</NoticeBar>
      <NoticeBar v-if="conflict" intent="error">
        {{ t("codeEditConflict") }}
        <RouterLink :to="compareUrl">{{ t("codeCompareLatest") }}</RouterLink>
      </NoticeBar>
      <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="button" :disabled="saving || pullSaving" @click="close">{{
          t("cancel")
        }}</FluentButton>
        <FluentButton
          v-if="file && !saved"
          type="button"
          :disabled="saving || !canDelete"
          @click="deleteOpen = true"
        >
          {{ t("codeDeleteFile") }}
        </FluentButton>
        <FluentButton type="submit" tone="primary" :disabled="saving || !canSave || Boolean(saved)">
          {{ saving ? t("loading") : t("codeSaveFile") }}
        </FluentButton>
      </div>
    </form>
    <FluentDialog v-model:open="deleteOpen" :label="t('codeConfirmDeleteFile')">
      <template #title>{{ t("codeConfirmDeleteFile") }}</template>
      <p>{{ t("codeDeleteFileConfirmation", { path: file?.path ?? "" }) }}</p>
      <template #footer>
        <FluentButton type="button" @click="deleteOpen = false">{{ t("cancel") }}</FluentButton>
        <FluentButton
          type="button"
          tone="primary"
          :disabled="saving || !canDelete"
          @click="deleteFile"
          >{{ t("codeDeleteFile") }}</FluentButton
        >
      </template>
    </FluentDialog>
  </section>
</template>

<style scoped>
.file-editor .box-header {
  justify-content: space-between;
}
.file-editor .box-header p {
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-regular);
}
.editor-body {
  padding: var(--space-4);
}
.editor-fields {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.save-result {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.file-editor :deep(textarea) {
  min-height: 320px;
  font: var(--font-size-meta) / 20px var(--font-mono);
}
</style>
