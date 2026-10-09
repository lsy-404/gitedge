<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  REPOSITORY_COMMIT_LIMITS,
  editablePath,
} from "../../../../packages/contracts/src/repository-controls";
import type { Repository, RepositoryBranch } from "../lib/api";
import { ApiError, api, errorMessage, formatBytes } from "../lib/api";
import { useCommitTarget } from "../lib/commitTarget";
import {
  commitPayload,
  stageUploads,
  uploadsFromDrop,
  uploadsFromFiles,
  type RejectedUpload,
  type StagedChange,
  type StagedUpload,
} from "../lib/repositoryCommit";
import { useUnsavedGuard } from "../lib/unsavedGuard";
import AppIcon from "./AppIcon.vue";
import CommitTargetFields from "./CommitTargetFields.vue";
import NoticeBar from "./NoticeBar.vue";
import TextField from "./TextField.vue";

export interface CommittedChanges {
  oid: string;
  branch: string;
  /** Directory to show after the commit. */
  directory: string;
  /** Set when a new branch was created and the user asked for a pull request. */
  pull: { base: string; head: string; title: string } | null;
}

const props = defineProps<{
  repository: Repository;
  mode: "upload" | "move" | "delete";
  branch: string;
  expectedOid: string | null;
  branchInfo: RepositoryBranch | null;
  branches: RepositoryBranch[];
  directory: string;
}>();
const emit = defineEmits<{ close: []; committed: [result: CommittedChanges] }>();
const { t } = useI18n();
const target = useCommitTarget(
  () => props.branches,
  () => props.branchInfo
);
const { message, newBranch, createPull, protectedRejected, protectedBranch, targetBranch } = target;
const { targetBranchValid } = target;
// A new branch from the web usually exists to be proposed, as on other forges.
createPull.value = true;
const staged = ref<StagedUpload[]>([]);
const rejected = ref<RejectedUpload[]>([]);
const truncated = ref(false);
const dragging = ref(false);
const destination = ref(props.directory);
const saving = ref(false);
const error = ref("");
const conflict = ref(false);
const deleteOpen = ref(false);
const committed = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
const folderAttrs = { webkitdirectory: true };

const stagedBytes = computed(() => staged.value.reduce((sum, item) => sum + item.file.size, 0));
const limits = computed(() => ({
  file: formatBytes(REPOSITORY_COMMIT_LIMITS.fileBytes),
  total: formatBytes(REPOSITORY_COMMIT_LIMITS.totalBytes),
  count: REPOSITORY_COMMIT_LIMITS.changes,
}));
const destinationValid = computed(() => {
  const value = destination.value.trim();
  return (
    editablePath(value) && value !== props.directory && !value.startsWith(props.directory + "/")
  );
});
const dirty = computed(
  () => !committed.value && (staged.value.length > 0 || message.value.trim() !== "")
);
const { confirmDiscard } = useUnsavedGuard(dirty);
const modeReady = computed(() => {
  if (props.mode === "upload") return staged.value.length > 0;
  if (props.mode === "move") return destinationValid.value;
  return true;
});
const canCommit = computed(
  () =>
    props.repository.onlineEditingEnabled &&
    props.repository.canWrite &&
    !props.repository.archived &&
    modeReady.value &&
    message.value.trim().length > 0 &&
    targetBranchValid.value &&
    !saving.value
);
const title = computed(() => t(`codeChange_${props.mode}`));
const compareUrl = computed(
  () =>
    `/${props.repository.owner}/${props.repository.name}/compare?base=${encodeURIComponent(props.expectedOid ?? "")}&head=${encodeURIComponent(props.branch)}`
);

function addUploads(incoming: StagedUpload[]) {
  const result = stageUploads(staged.value, incoming);
  staged.value = result.staged;
  rejected.value = result.rejected;
}
function onPicked(event: Event) {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.files) return;
  truncated.value = false;
  addUploads(uploadsFromFiles(input.files, props.directory));
  input.value = "";
}
async function onDrop(event: DragEvent) {
  dragging.value = false;
  if (!event.dataTransfer) return;
  const dropped = await uploadsFromDrop(event.dataTransfer, props.directory);
  truncated.value = dropped.truncated;
  addUploads(dropped.uploads);
}
function removeStaged(path: string) {
  staged.value = staged.value.filter((item) => item.path !== path);
}
function changes(): StagedChange[] {
  if (props.mode === "upload")
    return staged.value.map((item) => ({ op: "put", path: item.path, content: item.file }));
  if (props.mode === "move")
    return [{ op: "move", from: props.directory, to: destination.value.trim() }];
  return [{ op: "delete", path: props.directory }];
}
function resultDirectory(): string {
  if (props.mode === "move") return destination.value.trim();
  if (props.mode === "delete") return props.directory.split("/").slice(0, -1).join("/");
  return props.directory;
}
function failureMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "refs_changed") {
      conflict.value = true;
      return t("codeEditConflict");
    }
    if (cause.code === "protected_branch") {
      protectedRejected.value = true;
      return t("codeProtectedEditNeedsBranch");
    }
    if (cause.status === 413) return t("codeUploadTooLarge");
    if (cause.status === 400) return t("codeChangeRejected", { reason: cause.message });
  }
  return errorMessage(cause, t);
}
async function commit() {
  if (!canCommit.value) return;
  saving.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const payload = commitPayload(
      {
        branch: props.branch,
        ...(targetBranch.value ? { newBranch: targetBranch.value } : {}),
        expectedOid: props.expectedOid,
        message: message.value.trim(),
      },
      changes()
    );
    if (!payload) {
      error.value = t("codeEditInvalid");
      return;
    }
    const result = await api.commitRepositoryChanges(props.repository.id, payload);
    committed.value = true;
    deleteOpen.value = false;
    emit("committed", {
      ...result,
      directory: resultDirectory(),
      pull:
        createPull.value && props.repository.pullsEnabled && result.branch !== props.branch
          ? { base: props.branch, head: result.branch, title: message.value.trim() }
          : null,
    });
  } catch (cause) {
    error.value = failureMessage(cause);
    deleteOpen.value = false;
  } finally {
    saving.value = false;
  }
}
function submit() {
  if (props.mode === "delete") deleteOpen.value = canCommit.value;
  else void commit();
}
function close() {
  if (!confirmDiscard()) return;
  emit("close");
}
</script>

<template>
  <section class="change-form box" :aria-label="title">
    <div class="box-header">
      <div>
        <h2>{{ title }}</h2>
        <p class="muted">
          {{ t("codeEditAgainst", { branch, oid: expectedOid ?? t("codeEmptyHead") }) }}
        </p>
      </div>
      <FluentButton type="button" tone="subtle" :disabled="saving" @click="close"
        ><AppIcon name="close" />{{ t("cancel") }}</FluentButton
      >
    </div>
    <form class="form-stack change-body" @submit.prevent="submit">
      <fieldset class="change-fields" :disabled="saving">
        <template v-if="mode === 'upload'">
          <div
            class="drop-zone"
            :class="{ active: dragging }"
            data-testid="drop-zone"
            @dragover.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <AppIcon name="upload" />
            <strong>{{ t("codeUploadDrop") }}</strong>
            <div class="drop-actions">
              <FluentButton type="button" @click="fileInput?.click()">{{
                t("codeUploadChooseFiles")
              }}</FluentButton>
              <FluentButton type="button" @click="folderInput?.click()">{{
                t("codeUploadChooseFolder")
              }}</FluentButton>
            </div>
            <input
              ref="fileInput"
              class="visually-hidden"
              type="file"
              multiple
              tabindex="-1"
              :aria-label="t('codeUploadChooseFiles')"
              @change="onPicked"
            />
            <input
              ref="folderInput"
              class="visually-hidden"
              type="file"
              v-bind="folderAttrs"
              tabindex="-1"
              :aria-label="t('codeUploadChooseFolder')"
              @change="onPicked"
            />
          </div>
          <p class="muted">{{ t("codeUploadLimits", limits) }}</p>
          <p class="muted">
            {{ t("codeUploadTarget", { directory: directory || t("repositoryRoot") }) }}
          </p>
          <NoticeBar v-if="truncated" intent="warning">{{ t("codeUploadTruncated") }}</NoticeBar>
          <NoticeBar v-if="rejected.length" intent="warning">
            <ul class="rejected-list">
              <li v-for="item in rejected" :key="item.path">
                <code>{{ item.path }}</code> {{ t(`codeUploadRejected_${item.reason}`) }}
              </li>
            </ul>
          </NoticeBar>
          <ul v-if="staged.length" class="staged-list" :aria-label="t('codeUploadStaged')">
            <li v-for="item in staged" :key="item.path">
              <AppIcon name="file" />
              <code>{{ item.path }}</code>
              <span class="muted">{{ formatBytes(item.file.size) }}</span>
              <FluentButton
                type="button"
                tone="subtle"
                size="small"
                :aria-label="t('codeUploadRemove', { path: item.path })"
                @click="removeStaged(item.path)"
                ><AppIcon name="close"
              /></FluentButton>
            </li>
          </ul>
          <p v-if="staged.length" class="muted">
            {{ t("codeUploadSummary", { count: staged.length, size: formatBytes(stagedBytes) }) }}
          </p>
        </template>
        <template v-else-if="mode === 'move'">
          <p class="muted">
            {{ t("codeMoveFolderFrom") }} <code>{{ directory }}</code>
          </p>
          <TextField v-model="destination" required maxlength="1000">{{
            t("codeMoveFolderTo")
          }}</TextField>
          <small v-if="destination.trim() && !destinationValid" class="field-error">{{
            t("codePathInvalid")
          }}</small>
        </template>
        <template v-else>
          <NoticeBar intent="warning">{{
            t("codeDeleteFolderWarning", { path: directory })
          }}</NoticeBar>
        </template>
        <CommitTargetFields
          v-model:message="message"
          v-model:new-branch="newBranch"
          v-model:create-pull="createPull"
          :branch="branch"
          :pulls-enabled="repository.pullsEnabled"
          :protected-branch="protectedBranch"
          :target-branch="targetBranch"
          :target-branch-valid="targetBranchValid"
        >
          <template #pull-label>{{ t("codeOpenPullAfterCommit") }}</template>
        </CommitTargetFields>
      </fieldset>
      <NoticeBar v-if="conflict" intent="error">
        {{ t("codeEditConflict") }}
        <RouterLink :to="compareUrl">{{ t("codeCompareLatest") }}</RouterLink>
      </NoticeBar>
      <NoticeBar v-else-if="error" intent="error">{{ error }}</NoticeBar>
      <div class="form-actions">
        <FluentButton type="button" :disabled="saving" @click="close">{{
          t("cancel")
        }}</FluentButton>
        <FluentButton
          type="submit"
          :tone="mode === 'delete' ? 'danger' : 'primary'"
          :disabled="!canCommit"
        >
          {{ saving ? t("loading") : t(`codeChangeSubmit_${mode}`) }}
        </FluentButton>
      </div>
    </form>
    <FluentDialog v-model:open="deleteOpen" :label="t('codeConfirmDeleteFolder')">
      <template #title>{{ t("codeConfirmDeleteFolder") }}</template>
      <p>{{ t("codeDeleteFolderConfirmation", { path: directory }) }}</p>
      <template #footer>
        <FluentButton type="button" @click="deleteOpen = false">{{ t("cancel") }}</FluentButton>
        <FluentButton type="button" tone="danger" :disabled="saving" @click="commit">{{
          t("codeDeleteFolder")
        }}</FluentButton>
      </template>
    </FluentDialog>
  </section>
</template>

<style scoped>
.change-form .box-header {
  justify-content: space-between;
}
.change-form .box-header p {
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-regular);
}
.change-body {
  padding: var(--space-4);
}
.change-fields {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.drop-zone {
  display: grid;
  justify-items: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--fg-secondary);
  background: var(--bg-subtle);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  text-align: center;
}
.drop-zone.active {
  background: var(--bg-selected);
  border-color: var(--accent-strong);
}
.drop-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}
.staged-list,
.rejected-list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.staged-list {
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.staged-list li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-muted);
}
.staged-list li code {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
