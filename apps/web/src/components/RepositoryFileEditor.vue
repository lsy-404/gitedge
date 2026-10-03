<script setup lang="ts">
import { repositoryCodeLocation } from "../lib/gitGraphView";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  EditRepositoryFileSchema,
  GitBranchSchema,
} from "../../../../packages/contracts/src/index";
import type {
  EditRepositoryFileInput,
  GitFile,
  GitTreeEntry,
  Repository,
  RepositoryBranch,
} from "../lib/api";
import { ApiError, api } from "../lib/api";
import AppIcon from "./AppIcon.vue";
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
const message = ref("");
const newBranch = ref("");
const createPull = ref(false);
const saving = ref(false);
const saveError = ref("");
const conflict = ref(false);
const protectedRejected = ref(false);
const saved = ref<SavedFile | null>(null);
const pullCreated = ref(false);
const createdPullNumber = ref<number | null>(null);
const pullSaving = ref(false);
const pullError = ref("");
const deleteOpen = ref(false);
const isNew = computed(() => props.file === null);
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
const protectedBranch = computed(() =>
  Boolean(props.branchInfo?.protected || protectedRejected.value)
);
const targetBranch = computed(() => newBranch.value.trim());
const targetBranchValid = computed(() => {
  if (!targetBranch.value) return !protectedBranch.value;
  return (
    GitBranchSchema.safeParse(targetBranch.value).success &&
    !props.branches.some((branch) => branch.name === targetBranch.value)
  );
});
const contentBytes = computed(() => new TextEncoder().encode(content.value).byteLength);
const canSave = computed(
  () =>
    directlyEditable.value &&
    path.value.trim().length > 0 &&
    message.value.trim().length > 0 &&
    contentBytes.value <= 1_000_000 &&
    targetBranchValid.value
);
const canDelete = computed(
  () =>
    directlyEditable.value &&
    Boolean(props.file) &&
    path.value.trim().length > 0 &&
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
    message.value = "";
    newBranch.value = "";
    saved.value = null;
    conflict.value = false;
    protectedRejected.value = false;
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
async function saveFile() {
  if (!canSave.value) return;
  saving.value = true;
  saveError.value = "";
  conflict.value = false;
  try {
    const input: EditRepositoryFileInput = {
      branch: props.branch,
      ...(targetBranch.value ? { newBranch: targetBranch.value } : {}),
      expectedOid: props.expectedOid,
      path: path.value.trim(),
      content: content.value,
      message: message.value.trim(),
    };
    const parsed = EditRepositoryFileSchema.safeParse(input);
    if (!parsed.success) {
      saveError.value = t("codeEditInvalid");
      return;
    }
    const result = await api.editRepositoryFile(props.repository.id, parsed.data);
    saved.value = result;
    if (createPull.value) await createPullRequest(false);
    emit("saved", result);
    emit("changed");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) conflict.value = true;
    saveError.value = saveErrorFor(cause);
  } finally {
    saving.value = false;
  }
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
  saving.value = true;
  saveError.value = "";
  conflict.value = false;
  try {
    const input: EditRepositoryFileInput = {
      branch: props.branch,
      ...(targetBranch.value ? { newBranch: targetBranch.value } : {}),
      expectedOid: props.expectedOid,
      path: props.file.path,
      content: null,
      message: message.value.trim(),
    };
    const parsed = EditRepositoryFileSchema.safeParse(input);
    if (!parsed.success) {
      saveError.value = t("codeEditInvalid");
      return;
    }
    const result = await api.editRepositoryFile(props.repository.id, parsed.data);
    saved.value = { ...result, deleted: true };
    deleteOpen.value = false;
    if (createPull.value) await createPullRequest(false);
    emit("saved", saved.value);
    emit("changed");
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409) conflict.value = true;
    saveError.value = saveErrorFor(cause);
  } finally {
    saving.value = false;
  }
}
function close() {
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
    <p v-if="!regularTextFile" class="muted" role="status">{{ t("codeNotEditable") }}</p>
    <form v-else class="form-stack" @submit.prevent="saveFile">
      <fieldset class="editor-fields" :disabled="Boolean(saved)">
        <TextField v-if="isNew" v-model="path" required maxlength="1000">{{
          t("codeFilePath")
        }}</TextField>
        <p v-else class="muted">
          <code>{{ file?.path }}</code>
        </p>
        <TextAreaField
          v-model="content"
          :label="t('codeFileContent')"
          rows="18"
          maxlength="1000000"
          spellcheck="false"
        />
        <p class="muted">{{ t("codeFileSize", { bytes: contentBytes }) }}</p>
        <TextField v-model="message" required maxlength="500">{{
          t("codeCommitMessage")
        }}</TextField>
        <div v-if="protectedBranch" class="branch-guidance" role="status">
          <strong>{{ t("codeProtectedEditNeedsBranch") }}</strong>
          <p>{{ t("codeProtectedBranchSource", { name: branch }) }}</p>
          <TextField v-model="newBranch" required maxlength="251">{{
            t("codeNewBranchName")
          }}</TextField>
          <small v-if="!saved && newBranch && !targetBranchValid" class="workspace-form-error">{{
            t("codeBranchNameInvalidOrExists")
          }}</small>
        </div>
        <template v-else>
          <TextField v-model="newBranch" maxlength="251">{{
            t("codeOptionalNewBranch")
          }}</TextField>
          <small v-if="!saved && newBranch && !targetBranchValid" class="workspace-form-error">{{
            t("codeBranchNameInvalidOrExists")
          }}</small>
        </template>
        <FluentCheckbox
          v-if="repository.pullsEnabled && targetBranch && targetBranchValid"
          v-model="createPull"
        >
          {{ t("codeCreatePullAfterSave") }}
        </FluentCheckbox>
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
      <p v-if="pullError" role="alert" class="workspace-form-error">{{ pullError }}</p>
      <p v-if="conflict" role="alert" class="workspace-form-error">
        {{ t("codeEditConflict") }}
        <RouterLink :to="compareUrl">{{ t("codeCompareLatest") }}</RouterLink>
      </p>
      <p v-if="saveError" role="alert" class="workspace-form-error">{{ saveError }}</p>
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
.file-editor {
  display: grid;
  gap: var(--spacingVerticalM);
  margin-top: var(--spacingVerticalL);
  padding: var(--spacingVerticalL);
}
.file-editor h2 {
  margin: 0;
}
.editor-fields {
  display: grid;
  gap: var(--spacingVerticalM);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.branch-guidance,
.save-result {
  display: grid;
  gap: var(--spacingVerticalS);
  padding: var(--spacingVerticalM);
  border: 1px solid var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusMedium);
}
.file-editor :deep(textarea) {
  min-height: 320px;
  font-family: var(--fontFamilyMonospace);
}
</style>
