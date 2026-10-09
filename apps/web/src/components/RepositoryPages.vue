<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  FluentButton,
  FluentField,
  FluentSelect,
  FluentSwitch,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import {
  UpdatePagesInputSchema,
  type PagesSettings,
} from "../../../../packages/contracts/src/pages";
import { api, errorMessage } from "../lib/api";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{
  repositoryId: string;
  owner: string;
  name: string;
  canManage: boolean;
  /** Unsaved value of the repository feature switch. */
  pagesEnabled: boolean;
}>();
const { t, d } = useI18n();
const settings = ref<PagesSettings | null>(null);
const branches = ref<string[]>([]);
const branch = ref("");
const folder = ref("/");
const notFoundPath = ref("");
const spaFallback = ref(false);
const loading = ref(true);
const error = ref("");
const saving = ref(false);
const saveError = ref("");
const saved = ref(false);
let loadVersion = 0;

const branchChoices = computed<readonly FluentSelectOption[]>(() => {
  const names = branches.value.includes(branch.value)
    ? branches.value
    : [branch.value, ...branches.value];
  return names.filter(Boolean).map((value) => ({ value, label: value }));
});
const dirty = computed(
  () =>
    settings.value !== null &&
    (branch.value !== settings.value.branch ||
      folder.value !== settings.value.folder ||
      notFoundPath.value !== (settings.value.notFoundPath ?? "") ||
      spaFallback.value !== settings.value.spaFallback)
);
const liveUrl = computed(() => {
  if (!settings.value) return "";
  return settings.value.hostUrl ?? new URL(settings.value.pathUrl, window.location.origin).href;
});
const pathUrl = computed(() =>
  settings.value ? new URL(settings.value.pathUrl, window.location.origin).href : ""
);
const lastPublished = computed(() => settings.value?.lastPublishedOid ?? "");
const commitPath = computed(() =>
  lastPublished.value ? `/${props.owner}/${props.name}/commit/${lastPublished.value}` : ""
);

function apply(result: PagesSettings): void {
  settings.value = result;
  branch.value = result.branch;
  folder.value = result.folder;
  notFoundPath.value = result.notFoundPath ?? "";
  spaFallback.value = result.spaFallback;
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const [result, refs] = await Promise.all([
      api.pagesSettings(props.repositoryId),
      api.refs(props.repositoryId).catch(() => []),
    ]);
    if (version !== loadVersion) return;
    branches.value = refs
      .filter((ref) => ref.name.startsWith("refs/heads/"))
      .map((ref) => ref.name.slice("refs/heads/".length))
      .sort((a, b) => a.localeCompare(b));
    apply(result);
  } catch (cause) {
    if (version === loadVersion) error.value = errorMessage(cause, t);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function save(): Promise<void> {
  if (!props.canManage || saving.value) return;
  const parsed = UpdatePagesInputSchema.safeParse({
    branch: branch.value,
    folder: folder.value,
    notFoundPath: notFoundPath.value.trim() === "" ? null : notFoundPath.value,
    spaFallback: spaFallback.value,
  });
  saved.value = false;
  if (!parsed.success) {
    saveError.value = t("pagesInvalid");
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    apply(await api.updatePages(props.repositoryId, parsed.data));
    saved.value = true;
  } catch (cause) {
    saveError.value = errorMessage(cause, t, { 400: "pagesInvalid" });
  } finally {
    saving.value = false;
  }
}

watch(() => props.repositoryId, load, { immediate: true });
</script>

<template>
  <section class="box" aria-labelledby="settings-pages-title">
    <header class="box-header">
      <h3 id="settings-pages-title">{{ t("repoSettingsPages") }}</h3>
    </header>
    <p class="box-row field-hint">{{ t("pagesIntro") }}</p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else-if="settings">
      <div class="box-form">
        <NoticeBar v-if="!settings.available" intent="warning">{{
          t("pagesPrivateUnavailable")
        }}</NoticeBar>
        <NoticeBar v-else-if="!pagesEnabled" intent="info">{{ t("pagesEnableHint") }}</NoticeBar>
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <span>{{ t("pagesLiveUrl") }}</span>
          <p>{{ t("pagesLiveUrlHint") }}</p>
        </div>
        <div class="pages-links">
          <StatusBadge :tone="settings.enabled && settings.available ? 'success' : 'neutral'">{{
            settings.enabled && settings.available ? t("pagesPublished") : t("pagesOff")
          }}</StatusBadge>
          <a :href="liveUrl" target="_blank" rel="noreferrer">{{ liveUrl }}</a>
          <a v-if="settings.hostUrl" :href="pathUrl" target="_blank" rel="noreferrer">{{
            pathUrl
          }}</a>
        </div>
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <span>{{ t("pagesLastPublished") }}</span>
          <p>{{ t("pagesLastPublishedHint") }}</p>
        </div>
        <div class="pages-links">
          <template v-if="lastPublished">
            <code>{{ lastPublished.slice(0, 12) }}</code>
            <small v-if="settings.lastPublishedAt">{{ d(settings.lastPublishedAt, "long") }}</small>
            <RouterLink :to="commitPath">{{ t("pagesOpenCommit") }}</RouterLink>
          </template>
          <small v-else>{{ t("pagesNeverPublished") }}</small>
        </div>
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <span>{{ t("pagesBranch") }}</span>
          <p>{{ t("pagesBranchHint") }}</p>
        </div>
        <FluentSelect
          :model-value="branch"
          :label="t('pagesBranch')"
          :aria-label="t('pagesBranch')"
          :options="branchChoices"
          :disabled="!canManage"
          @update:model-value="branch = $event"
        />
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <label for="pages-folder">{{ t("pagesFolder") }}</label>
          <p>{{ t("pagesFolderHint") }}</p>
        </div>
        <FluentField
          id="pages-folder"
          :model-value="folder"
          :label="t('pagesFolder')"
          :disabled="!canManage"
          @update:model-value="folder = $event"
        />
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <label for="pages-not-found">{{ t("pagesNotFound") }}</label>
          <p>{{ t("pagesNotFoundHint") }}</p>
        </div>
        <FluentField
          id="pages-not-found"
          :model-value="notFoundPath"
          :label="t('pagesNotFound')"
          :disabled="!canManage"
          @update:model-value="notFoundPath = $event"
        />
      </div>
      <div class="box-row settings-row">
        <div class="row-copy">
          <span>{{ t("pagesSpa") }}</span>
          <p>{{ t("pagesSpaHint") }}</p>
        </div>
        <FluentSwitch v-model="spaFallback" :label="t('pagesSpa')" :disabled="!canManage" />
      </div>
      <div class="box-form">
        <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
        <NoticeBar v-else-if="saved && !dirty" intent="success">{{ t("pagesSaved") }}</NoticeBar>
        <p class="field-hint">{{ t("pagesPreviewHint") }}</p>
        <FluentButton
          type="button"
          tone="primary"
          :disabled="!canManage || !dirty || saving"
          :busy="saving"
          @click="save"
          >{{ t("pagesSave") }}</FluentButton
        >
      </div>
    </template>
  </section>
</template>

<style scoped>
.pages-links {
  display: grid;
  gap: var(--space-1);
  justify-items: start;
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
