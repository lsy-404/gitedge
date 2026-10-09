<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentCheckbox } from "@platform-kit/fluent/vue";
import {
  GitOidSchema,
  GitTagNameSchema,
  RELEASE_ASSET_MAX_BYTES,
  RELEASE_MAX_ASSETS,
  RELEASE_LIST_LIMIT,
} from "../../../../packages/contracts/src/index";
import type { Release, Repository, RepositoryTag } from "../lib/api";
import { ApiError, api, archiveUrl, errorMessage, formatBytes, releaseAssetUrl } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import AppIcon from "./AppIcon.vue";
import ConfirmButton from "./ConfirmButton.vue";
import GitSignatureStatus from "./GitSignatureStatus.vue";
import MarkdownContent from "./MarkdownContent.vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import StatusBadge from "./StatusBadge.vue";
import SelectField from "./SelectField.vue";
import StatusState from "./StatusState.vue";
import TextAreaField from "./TextAreaField.vue";
import TextField from "./TextField.vue";
import "../styles/releases.css";

const props = defineProps<{ repository: Repository }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const releases = ref<Release[]>([]);
const truncated = ref(false);
const tags = ref<RepositoryTag[]>([]);
const branches = ref<string[]>([]);
const loading = ref(true);
const error = ref("");
const actionError = ref("");
const editor = ref<"closed" | "new" | Release>("closed");
const saving = ref(false);
const busyId = ref("");
const uploading = ref("");
const tagName = ref("");
const targetBranch = ref("");
const commit = ref("");
const title = ref("");
const notes = ref("");
const draft = ref(false);
const prerelease = ref(false);
let loadVersion = 0;

const canManage = computed(() => props.repository.canWrite && !props.repository.archived);
const editing = computed(() => (typeof editor.value === "object" ? editor.value : null));
const latestId = computed(
  () => releases.value.find((release) => !release.draft && !release.prerelease)?.id ?? null
);
const tagKnown = computed(() => tags.value.some((tag) => tag.name === tagName.value.trim()));
const needsTarget = computed(() => !editing.value && !tagKnown.value);
const commitValid = computed(
  () => !commit.value.trim() || GitOidSchema.safeParse(commit.value.trim()).success
);
const canSave = computed(
  () =>
    !saving.value &&
    (editing.value !== null ||
      (GitTagNameSchema.safeParse(tagName.value.trim()).success &&
        commitValid.value &&
        (!needsTarget.value || targetBranch.value !== "" || draft.value)))
);
const submitLabel = computed(() => {
  if (saving.value) return t("releaseSaving");
  if (editing.value)
    return editing.value.draft && !draft.value ? t("releasePublishDraft") : t("releaseSaveChanges");
  return draft.value ? t("releaseDraft") : t("releasePublish");
});
const assetMax = formatBytes(RELEASE_ASSET_MAX_BYTES);

const errorKeys: Readonly<Record<string, string>> = {
  release_exists: "releaseErrorExists",
  tag_missing: "releaseErrorTagMissing",
  asset_limit: "releaseErrorAssetLimit",
  storage_limit: "releaseErrorAssetLimit",
  asset_exists: "releaseErrorAssetExists",
  asset_too_large: "releaseErrorAssetTooLarge",
  bad_request: "releaseErrorInvalid",
  release_changed: "releaseErrorChanged",
};
function failure(cause: unknown): string {
  if (cause instanceof ApiError && cause.code && errorKeys[cause.code])
    return t(errorKeys[cause.code]);
  return errorMessage(cause, t);
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const page = await api.releases(props.repository.id);
    if (version !== loadVersion) return;
    releases.value = page.items;
    truncated.value = page.truncated;
  } catch {
    if (version === loadVersion) error.value = t("releaseLoadError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function loadChoices(): Promise<void> {
  try {
    const [tagPage, refs] = await Promise.all([
      api.repositoryTags(props.repository.id),
      api.refs(props.repository.id),
    ]);
    tags.value = tagPage.items;
    branches.value = refs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ref.name.slice(11));
    targetBranch.value = branches.value.includes(props.repository.defaultBranch)
      ? props.repository.defaultBranch
      : (branches.value[0] ?? "");
  } catch (cause) {
    actionError.value = failure(cause);
  }
}

function openEditor(release: Release | "new"): void {
  actionError.value = "";
  editor.value = release;
  tagName.value = release === "new" ? "" : release.tagName;
  title.value = release === "new" ? "" : release.title;
  notes.value = release === "new" ? "" : release.body;
  draft.value = release === "new" ? false : release.draft;
  prerelease.value = release === "new" ? false : release.prerelease;
  commit.value = "";
  void loadChoices();
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  actionError.value = "";
  try {
    const current = editing.value;
    if (current)
      await api.updateRelease(props.repository.id, current.id, {
        title: title.value.trim(),
        body: notes.value,
        draft: draft.value,
        prerelease: prerelease.value,
      });
    else {
      const sha = commit.value.trim();
      await api.createRelease(props.repository.id, {
        tagName: tagName.value.trim(),
        title: title.value.trim(),
        body: notes.value,
        draft: draft.value,
        prerelease: prerelease.value,
        ...(needsTarget.value && (targetBranch.value || sha)
          ? { target: sha || targetBranch.value, source: targetBranch.value || undefined }
          : {}),
      });
    }
    editor.value = "closed";
    await load();
  } catch (cause) {
    actionError.value = failure(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(release: Release): Promise<void> {
  busyId.value = release.id;
  actionError.value = "";
  try {
    await api.deleteRelease(props.repository.id, release.id);
    await load();
  } catch (cause) {
    if (!reauth.intercept(cause, () => remove(release))) actionError.value = failure(cause);
  } finally {
    busyId.value = "";
  }
}

async function removeAsset(release: Release, assetId: string): Promise<void> {
  busyId.value = assetId;
  actionError.value = "";
  try {
    await api.deleteReleaseAsset(props.repository.id, release.id, assetId);
    await load();
  } catch (cause) {
    actionError.value = failure(cause);
  } finally {
    busyId.value = "";
  }
}

async function upload(release: Release, event: Event): Promise<void> {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const files = Array.from(input?.files ?? []);
  if (input) input.value = "";
  actionError.value = "";
  for (const file of files) {
    if (file.size > RELEASE_ASSET_MAX_BYTES) {
      actionError.value = t("releaseAssetTooLarge", { name: file.name, size: assetMax });
      break;
    }
    uploading.value = file.name;
    try {
      await api.uploadReleaseAsset(props.repository.id, release.id, file);
    } catch (cause) {
      actionError.value = failure(cause);
      break;
    }
  }
  uploading.value = "";
  if (files.length) await load();
}

function sourceLink(release: Release, format: "zip" | "tar.gz"): string {
  return archiveUrl(props.repository.owner, props.repository.name, release.tagName, format);
}

watch(
  () => props.repository.id,
  () => {
    editor.value = "closed";
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="releases-page" :aria-label="t('releases')">
    <div class="page-head">
      <div>
        <h2>{{ t("releases") }}</h2>
        <p>{{ t("releasesIntro") }}</p>
      </div>
      <FluentButton
        v-if="canManage && editor === 'closed'"
        type="button"
        tone="primary"
        @click="openEditor('new')"
        ><AppIcon name="plus" />{{ t("releaseNew") }}</FluentButton
      >
    </div>

    <form
      v-if="editor !== 'closed'"
      class="box release-editor"
      :aria-label="editing ? t('releaseEdit') : t('releaseNew')"
      @submit.prevent="save"
    >
      <header class="box-header">
        <h3>{{ editing ? t("releaseEdit") : t("releaseNew") }}</h3>
      </header>
      <div class="box-form form-stack">
        <div class="release-editor-grid">
          <TextField
            v-model="tagName"
            :hint="t('releaseTagHint')"
            :disabled="editing !== null || saving"
            maxlength="200"
            >{{ t("releaseTagName") }}</TextField
          >
          <SelectField
            v-if="!editing"
            :model-value="tagKnown ? tagName.trim() : ''"
            :label="t('releaseTagName')"
            :disabled="saving"
            @update:model-value="tagName = $event"
          >
            <option value="">{{ t("releaseNewTagOption") }}</option>
            <option v-for="tag in tags" :key="tag.name" :value="tag.name">{{ tag.name }}</option>
          </SelectField>
        </div>
        <div v-if="needsTarget" class="release-editor-grid">
          <SelectField
            v-model="targetBranch"
            :label="t('releaseTarget')"
            :hint="t('releaseTargetHint')"
            :disabled="saving"
          >
            <option v-for="name in branches" :key="name" :value="name">{{ name }}</option>
          </SelectField>
          <TextField
            v-model="commit"
            :hint="t('releaseCommitHint')"
            :aria-invalid="!commitValid"
            :disabled="saving"
            maxlength="40"
            >{{ t("releaseCommit") }}</TextField
          >
        </div>
        <TextField v-model="title" :disabled="saving" maxlength="200">{{
          t("releaseTitle")
        }}</TextField>
        <TextAreaField v-model="notes" :label="t('releaseNotes')" rows="8" maxlength="50000" />
        <FluentCheckbox v-model="prerelease" :label="t('releasePrerelease')" />
        <FluentCheckbox v-model="draft" :label="t('releaseDraft')" />
        <p class="field-hint">{{ t("releaseDraftHint") }}</p>
        <div class="form-actions">
          <FluentButton type="button" :disabled="saving" @click="editor = 'closed'">{{
            t("cancel")
          }}</FluentButton>
          <FluentButton type="submit" tone="primary" :busy="saving" :disabled="!canSave">{{
            submitLabel
          }}</FluentButton>
        </div>
      </div>
    </form>

    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
    <ReauthPrompt v-if="reauth.pending.value" @confirmed="reauth.confirmed" />
    <StatusState
      :loading="loading"
      :error="error"
      :empty="!loading && !error && !releases.length"
      @retry="load"
    >
      <template #empty>
        <AppIcon name="tag" :size="48" />
        <h3>{{ t("releaseEmpty") }}</h3>
        <p>{{ t("releaseEmptyHint") }}</p>
      </template>
    </StatusState>

    <template v-if="!loading && !error">
      <article v-for="release in releases" :key="release.id" class="box release-card">
        <header class="box-header">
          <h3>{{ release.title }}</h3>
          <StatusBadge v-if="release.id === latestId" tone="success">{{
            t("releaseLatest")
          }}</StatusBadge>
          <StatusBadge v-if="release.prerelease" tone="warning">{{
            t("releasePrereleaseBadge")
          }}</StatusBadge>
          <StatusBadge v-if="release.draft">{{ t("releaseDraftBadge") }}</StatusBadge>
          <div v-if="canManage" class="release-actions">
            <FluentButton type="button" size="small" @click="openEditor(release)">{{
              t("releaseEdit")
            }}</FluentButton>
            <ConfirmButton
              size="small"
              tone="secondary"
              :label="t('releaseDelete')"
              :accessible-name="`${t('releaseDelete')} · ${release.title}`"
              :prompt="t('releaseDeletePrompt')"
              :busy="busyId === release.id"
              :disabled="Boolean(busyId)"
              @confirm="remove(release)"
            />
          </div>
        </header>
        <div class="release-meta">
          <span><AppIcon name="tag" :size="14" />{{ release.tagName }}</span>
          <span>{{
            release.draft
              ? t("releaseDraftBy", { author: release.author, date: d(release.createdAt, "short") })
              : t("releasePublishedBy", {
                  author: release.author,
                  date: d(release.publishedAt ?? release.createdAt, "short"),
                })
          }}</span>
        </div>
        <div v-if="!release.draft" class="release-signature">
          <GitSignatureStatus :repository-id="repository.id" :tag-name="release.tagName" />
        </div>
        <div class="release-notes">
          <MarkdownContent v-if="release.body" :source="release.body" />
          <p v-else class="muted">{{ t("releaseNoNotes") }}</p>
        </div>
        <h4 class="release-assets-title">{{ t("releaseAssets") }}</h4>
        <ul class="release-assets">
          <li v-for="asset in release.assets" :key="asset.id" class="release-asset">
            <a :href="releaseAssetUrl(repository.id, release.id, asset.id)" download
              ><AppIcon name="download" />{{ asset.name }}</a
            >
            <span class="release-asset-size">{{ formatBytes(asset.size) }}</span>
            <ConfirmButton
              v-if="canManage"
              size="small"
              tone="subtle"
              :label="t('releaseAssetDelete')"
              :accessible-name="`${t('releaseAssetDelete')} · ${asset.name}`"
              :prompt="t('releaseAssetDeletePrompt')"
              :busy="busyId === asset.id"
              :disabled="Boolean(busyId) || Boolean(uploading)"
              @confirm="removeAsset(release, asset.id)"
            />
            <span v-else />
          </li>
          <template v-if="!release.draft">
            <li class="release-asset">
              <a :href="sourceLink(release, 'zip')"
                ><AppIcon name="download" />{{ t("releaseSourceZip") }}</a
              >
              <span /><span />
            </li>
            <li class="release-asset">
              <a :href="sourceLink(release, 'tar.gz')"
                ><AppIcon name="download" />{{ t("releaseSourceTar") }}</a
              >
              <span /><span />
            </li>
          </template>
        </ul>
        <div v-if="canManage" class="release-upload">
          <label class="field-label" :for="`upload-${release.id}`">{{ t("releaseUpload") }}</label>
          <input
            :id="`upload-${release.id}`"
            type="file"
            multiple
            :disabled="Boolean(uploading) || release.assets.length >= RELEASE_MAX_ASSETS"
            @change="upload(release, $event)"
          />
          <span class="field-hint">{{
            t("releaseUploadHint", { size: assetMax, count: RELEASE_MAX_ASSETS })
          }}</span>
          <span v-if="uploading" role="status">{{
            t("releaseUploading", { name: uploading })
          }}</span>
        </div>
      </article>
      <p v-if="truncated" class="muted">
        {{ t("releaseTruncated", { count: RELEASE_LIST_LIMIT }) }}
      </p>
    </template>
  </section>
</template>
