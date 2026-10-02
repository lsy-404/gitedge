<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import {
  FluentButton,
  FluentField,
  FluentSelect,
  FluentSwitch,
  FluentTextArea,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import type { Repository, RepositorySettings } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { errorMessage } from "../lib/tasks";
import { oneOf } from "../ui/formEvents";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

type RepositoryDraft = Omit<RepositorySettings, "canManage">;
type SettingsSection = "general" | "features" | "merge" | "agents" | "archive";

const sections = [
  ["general", "repoSettingsGeneral"],
  ["features", "repoSettingsFeatures"],
  ["merge", "repoSettingsMergeRules"],
  ["agents", "repoSettingsAgentsMemory"],
  ["archive", "repoSettingsArchive"],
] as const satisfies ReadonlyArray<readonly [SettingsSection, string]>;
const visibilities = ["public", "private"] as const;
const memoryVisibilities = ["members", "public"] as const;
const agentPolicies = ["owner", "members"] as const;
const visibilityOptions: readonly FluentSelectOption[] = [
  { value: "public", label: "" },
  { value: "private", label: "" },
];
const memoryVisibilityOptions: readonly FluentSelectOption[] = [
  { value: "members", label: "" },
  { value: "public", label: "" },
];
const policyOptions: readonly FluentSelectOption[] = [
  { value: "owner", label: "" },
  { value: "members", label: "" },
];
const mergeApprovalOptions: readonly FluentSelectOption[] = Array.from(
  { length: 6 },
  (_, value) => ({
    value: String(value),
    label: String(value),
  })
);
const editableFields = [
  "name",
  "description",
  "visibility",
  "defaultBranch",
  "archived",
  "issuesEnabled",
  "pullsEnabled",
  "discussionsEnabled",
  "wikiEnabled",
  "requiredApprovals",
  "requirePassingChecks",
  "memoryVisibility",
  "agentAssignmentPolicy",
] as const satisfies readonly (keyof RepositoryDraft)[];

const props = defineProps<{ repository: Repository }>();
const emit = defineEmits<{ updated: [settings: RepositorySettings] }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const settings = ref<RepositorySettings | null>(null);
const draft = ref<RepositoryDraft | null>(null);
const branches = ref<string[]>([]);
const branchesLoading = ref(false);
const activeSection = ref<SettingsSection>("general");
const loading = ref(true);
const error = ref("");
const branchesError = ref("");
const saving = ref(false);
const saveError = ref("");
const saved = ref(false);
let loadVersion = 0;

const dirty = computed(
  () =>
    settings.value !== null &&
    draft.value !== null &&
    editableFields.some((field) => draft.value?.[field] !== settings.value?.[field])
);
const canManage = computed(() => settings.value?.canManage === true);
const publicMemoryAllowed = computed(() => draft.value?.visibility === "public");
const visibilityChoices = computed(() =>
  visibilityOptions.map((option) => ({
    ...option,
    label: option.value === "public" ? t("repoSettingsPublic") : t("repoSettingsPrivate"),
  }))
);
const memoryChoices = computed(() =>
  memoryVisibilityOptions.map((option) => ({
    ...option,
    label:
      option.value === "public" ? t("repoSettingsMemoryPublic") : t("repoSettingsMemoryMembers"),
    disabled: option.value === "public" && !publicMemoryAllowed.value,
  }))
);
const policyChoices = computed(() =>
  policyOptions.map((option) => ({
    ...option,
    label: option.value === "owner" ? t("repoSettingsPolicyOwner") : t("repoSettingsPolicyMembers"),
  }))
);
const branchChoices = computed<readonly FluentSelectOption[]>(() => {
  const options = branches.value.map((branch) => ({ value: branch, label: branch }));
  const current = draft.value?.defaultBranch;
  if (current && !branches.value.includes(current))
    options.unshift({
      value: current,
      label: `${current} (${t("repoSettingsBranchUnavailable")})`,
      disabled: true,
    });
  return options;
});

function editable(settings: RepositorySettings): RepositoryDraft {
  const { canManage: _canManage, ...draftSettings } = settings;
  return draftSettings;
}

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  branchesError.value = "";
  branchesLoading.value = true;
  try {
    const result = await api.repositorySettings(props.repository.id);
    if (version !== loadVersion) return;
    settings.value = result;
    draft.value = editable(result);
    try {
      const refs = await api.refs(props.repository.id);
      if (version !== loadVersion) return;
      branches.value = refs
        .filter((ref) => ref.name.startsWith("refs/heads/"))
        .map((ref) => ref.name.slice("refs/heads/".length))
        .sort((a, b) => a.localeCompare(b));
      branchesLoading.value = false;
    } catch (cause) {
      if (version !== loadVersion) return;
      branches.value = [];
      branchesError.value = errorMessage(cause, t);
      branchesLoading.value = false;
    }
  } catch (cause) {
    if (version !== loadVersion) return;
    error.value =
      cause instanceof ApiError && cause.status === 403
        ? t("permissionDenied")
        : errorMessage(cause, t);
  } finally {
    if (version === loadVersion) {
      branchesLoading.value = false;
      loading.value = false;
    }
  }
}

function setApprovals(value: string) {
  if (!draft.value) return;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 5)
    draft.value.requiredApprovals = parsed;
}

function setName(value: string) {
  if (!draft.value) return;
  draft.value.name = value;
  draft.value.slug = value;
}

async function save() {
  if (!draft.value || !settings.value || !canManage.value) return;
  saving.value = true;
  saveError.value = "";
  saved.value = false;
  try {
    const payload: RepositoryDraft = { ...draft.value };
    const result = await api.updateRepositorySettings(props.repository.id, payload);
    const renamed = result.slug !== props.repository.slug;
    const owner = props.repository.owner;
    settings.value = result;
    draft.value = editable(result);
    saved.value = true;
    emit("updated", result);
    if (renamed) {
      await router.replace({
        path: `/${encodeURIComponent(owner)}/${encodeURIComponent(result.slug)}/settings`,
        query: route.query,
      });
    }
  } catch (cause) {
    saveError.value = errorMessage(cause, t, {
      400: "repoSettingsSaveRejected",
      403: "settingsOwnerOnly",
      409: "repoSettingsSaveConflict",
      503: "repoSettingsBranchUnavailable",
    });
  } finally {
    saving.value = false;
  }
}

function sectionName(section: SettingsSection): string {
  return t(sections.find(([key]) => key === section)?.[1] ?? "repoSettingsGeneral");
}

watch(() => props.repository.id, load, { immediate: true });
</script>

<template>
  <section class="repository-settings">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <form v-else-if="settings && draft" class="settings-layout" @submit.prevent="save">
      <header class="settings-header">
        <div>
          <h2>{{ t("repositorySettingsTitle") }}</h2>
          <p>{{ props.repository.owner }}/{{ props.repository.name }}</p>
        </div>
        <NoticeBar v-if="!canManage" intent="info">{{ t("settingsOwnerOnly") }}</NoticeBar>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" :aria-label="t('settingsNavigation')">
          <button
            v-for="[key] in sections"
            :key="key"
            type="button"
            :aria-current="activeSection === key ? 'page' : undefined"
            @click="activeSection = key"
          >
            {{ sectionName(key) }}
          </button>
        </nav>

        <div class="settings-main">
          <section
            v-if="activeSection === 'general'"
            class="settings-card"
            aria-labelledby="settings-general-title"
          >
            <h3 id="settings-general-title">{{ sectionName("general") }}</h3>
            <div class="settings-row">
              <div class="row-copy">
                <label for="repository-name">{{ t("repoSettingsName") }}</label>
                <p>{{ t("repoSettingsNameHint") }}</p>
              </div>
              <FluentField
                id="repository-name"
                :model-value="draft.name"
                :label="t('repoSettingsName')"
                :disabled="!canManage"
                @update:model-value="setName"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsDescription") }}</span>
              </div>
              <FluentTextArea
                :model-value="draft.description"
                :label="t('repoSettingsDescription')"
                :disabled="!canManage"
                @update:model-value="draft.description = $event"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsVisibility") }}</span>
              </div>
              <FluentSelect
                :model-value="draft.visibility"
                :label="t('repoSettingsVisibility')"
                :aria-label="t('repoSettingsVisibility')"
                :options="visibilityChoices"
                :disabled="!canManage"
                @update:model-value="
                  draft.visibility = oneOf(visibilities, $event, draft.visibility)
                "
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsDefaultBranch") }}</span>
                <div v-if="branchesError" class="branch-error">
                  <p role="alert">{{ t("repoSettingsBranchUnavailable") }}</p>
                  <FluentButton type="button" @click="load">{{ t("retry") }}</FluentButton>
                </div>
                <p v-else-if="branchesLoading">{{ t("repoSettingsBranchesLoading") }}</p>
                <p v-else-if="branches.length === 0">{{ t("repoSettingsNoBranches") }}</p>
              </div>
              <FluentSelect
                :model-value="draft.defaultBranch"
                :label="t('repoSettingsDefaultBranch')"
                :aria-label="t('repoSettingsDefaultBranch')"
                :options="branchChoices"
                :disabled="!canManage || Boolean(branchesError) || branches.length === 0"
                @update:model-value="draft.defaultBranch = $event"
              />
            </div>
          </section>

          <section
            v-else-if="activeSection === 'features'"
            class="settings-card"
            aria-labelledby="settings-features-title"
          >
            <h3 id="settings-features-title">{{ sectionName("features") }}</h3>
            <p class="card-intro">{{ t("repoSettingsFeaturesIntro") }}</p>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsIssues") }}</span>
                <p>{{ t("repoSettingsIssuesHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.issuesEnabled"
                :label="t('repoSettingsEnabled')"
                :disabled="!canManage"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsPulls") }}</span>
                <p>{{ t("repoSettingsPullsHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.pullsEnabled"
                :label="t('repoSettingsEnabled')"
                :disabled="!canManage"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsDiscussions") }}</span>
                <p>{{ t("repoSettingsDiscussionsHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.discussionsEnabled"
                :label="t('repoSettingsEnabled')"
                :disabled="!canManage"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsWiki") }}</span>
                <p>{{ t("repoSettingsWikiHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.wikiEnabled"
                :label="t('repoSettingsEnabled')"
                :disabled="!canManage"
              />
            </div>
          </section>

          <section
            v-else-if="activeSection === 'merge'"
            class="settings-card"
            aria-labelledby="settings-merge-title"
          >
            <h3 id="settings-merge-title">{{ sectionName("merge") }}</h3>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsRequiredApprovals") }}</span>
                <p>{{ t("repoSettingsRequiredApprovalsHint") }}</p>
              </div>
              <FluentSelect
                :model-value="String(draft.requiredApprovals)"
                :label="t('repoSettingsRequiredApprovals')"
                :aria-label="t('repoSettingsRequiredApprovals')"
                :options="mergeApprovalOptions"
                :disabled="!canManage"
                @update:model-value="setApprovals"
              />
            </div>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsPassingChecks") }}</span>
                <p>{{ t("repoSettingsPassingChecksHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.requirePassingChecks"
                :label="t('repoSettingsEnabled')"
                :disabled="!canManage"
              />
            </div>
          </section>

          <section
            v-else-if="activeSection === 'agents'"
            class="settings-card"
            aria-labelledby="settings-agents-title"
          >
            <h3 id="settings-agents-title">{{ sectionName("agents") }}</h3>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsMemoryVisibility") }}</span>
                <p>{{ t("repoSettingsMemoryVisibilityHint") }}</p>
              </div>
              <FluentSelect
                :model-value="draft.memoryVisibility"
                :label="t('repoSettingsMemoryVisibility')"
                :aria-label="t('repoSettingsMemoryVisibility')"
                :options="memoryChoices"
                :disabled="!canManage"
                @update:model-value="
                  draft.memoryVisibility = oneOf(memoryVisibilities, $event, 'members')
                "
              />
            </div>
            <p v-if="!publicMemoryAllowed" class="private-note">
              {{ t("repoSettingsMemoryPrivateNote") }}
            </p>
            <div class="settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsAgentPolicy") }}</span>
                <p>{{ t("repoSettingsAgentPolicyHint") }}</p>
              </div>
              <FluentSelect
                :model-value="draft.agentAssignmentPolicy"
                :label="t('repoSettingsAgentPolicy')"
                :aria-label="t('repoSettingsAgentPolicy')"
                :options="policyChoices"
                :disabled="!canManage"
                @update:model-value="
                  draft.agentAssignmentPolicy = oneOf(agentPolicies, $event, 'owner')
                "
              />
            </div>
          </section>

          <section
            v-else
            class="settings-card archive-card"
            aria-labelledby="settings-archive-title"
          >
            <h3 id="settings-archive-title">{{ sectionName("archive") }}</h3>
            <div class="settings-row">
              <div class="row-copy">
                <strong>{{ t("repoSettingsArchiveTitle") }}</strong>
                <p>{{ t("repoSettingsArchiveHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.archived"
                :label="t('repoSettingsArchiveTitle')"
                :disabled="!canManage"
              />
            </div>
            <NoticeBar v-if="draft.archived" intent="warning">{{
              t("repoSettingsArchived")
            }}</NoticeBar>
          </section>

          <NoticeBar v-if="branchesError && activeSection !== 'general'" intent="warning">{{
            t("repoSettingsBranchUnavailable")
          }}</NoticeBar>
          <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
          <NoticeBar v-else-if="saved && !dirty" intent="success">{{
            t("settingsSaved")
          }}</NoticeBar>
          <div class="settings-actions">
            <FluentButton
              type="submit"
              tone="primary"
              :disabled="!canManage || saving || !dirty"
              :busy="saving"
            >
              {{ saving ? t("loading") : t("save") }}
            </FluentButton>
          </div>
        </div>
      </div>
    </form>
  </section>
</template>

<style scoped>
.repository-settings {
  min-width: 0;
}
.settings-layout {
  display: grid;
  gap: 24px;
  max-width: 1100px;
  margin: 0 auto;
}
.settings-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.settings-header h2,
.settings-card h3 {
  margin: 0;
  color: var(--fluent-text);
}
.settings-header p,
.settings-card p {
  margin: 6px 0 0;
  color: var(--fluent-muted);
  font-size: 12px;
}
.settings-body {
  display: grid;
  grid-template-columns: minmax(180px, 230px) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
.settings-nav {
  position: sticky;
  top: 16px;
  display: grid;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--fluent-border);
  border-radius: var(--fluent-panel-radius);
  background: var(--fluent-surface);
}
.settings-nav button {
  min-height: 38px;
  padding: 8px 12px;
  border: 0;
  border-radius: var(--fluent-radius);
  background: transparent;
  color: var(--fluent-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.settings-nav button:hover {
  background: var(--fluent-control-hover);
}
.settings-nav button[aria-current="page"] {
  background: var(--fluent-selection);
  color: var(--fluent-accent);
  font-weight: 600;
}
.settings-main {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.settings-card {
  overflow: hidden;
  border: 1px solid var(--fluent-border);
  border-radius: var(--fluent-panel-radius);
  background: var(--fluent-surface);
  color: var(--fluent-text);
}
.settings-card h3 {
  padding: 18px 20px;
  border-bottom: 1px solid var(--fluent-border);
  font-size: 18px;
}
.settings-card .card-intro {
  padding: 0 20px;
}
.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 40%);
  gap: 24px;
  align-items: center;
  min-width: 0;
  padding: 18px 20px;
  border-bottom: 1px solid var(--fluent-border);
}
.settings-row:last-child {
  border-bottom: 0;
}
.row-copy {
  min-width: 0;
}
.row-copy > span,
.row-copy > strong,
.row-copy > label {
  color: var(--fluent-text);
  font-size: 14px;
  font-weight: 600;
}
.settings-row > fluent-field,
.settings-row > fluent-text-area,
.settings-row > .fluent-select {
  width: 100%;
  min-width: 0;
}
.private-note {
  padding: 0 20px 16px;
}
.branch-error {
  display: grid;
  justify-items: start;
  gap: 6px;
}
.archive-card {
  border-color: var(--fluent-danger);
}
.settings-actions {
  display: flex;
  justify-content: flex-end;
  padding: 4px 0 8px;
}
@media (max-width: 760px) {
  .settings-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .settings-nav {
    position: static;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .settings-header {
    display: grid;
  }
  .settings-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
