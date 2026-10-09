<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from "vue";
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
import { ApiError, api, errorMessage } from "../lib/api";
import { oneOf } from "../ui/formEvents";
import { useUnsavedGuard } from "../lib/unsavedGuard";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";
import BranchProtectionSettings from "./BranchProtectionSettings.vue";
import AuditLogList from "./AuditLogList.vue";
import RepositoryCollaborators from "./RepositoryCollaborators.vue";
import RepositoryWebhooks from "./RepositoryWebhooks.vue";
import RepositoryDangerActions from "./RepositoryDangerActions.vue";
import "../styles/settings.css";

type RepositoryDraft = Omit<RepositorySettings, "canManage">;
type SettingsSection =
  | "general"
  | "features"
  | "merge"
  | "branchRules"
  | "collaborators"
  | "webhooks"
  | "agents"
  | "audit"
  | "danger";

const sections = [
  ["general", "repoSettingsGeneral"],
  ["features", "repoSettingsFeatures"],
  ["merge", "repoSettingsMergeRules"],
  ["branchRules", "repoSettingsBranchRules"],
  ["collaborators", "repoSettingsCollaborators"],
  ["webhooks", "repoSettingsWebhooks"],
  ["agents", "repoSettingsAgentsMemory"],
  ["audit", "auditLogTitle"],
  ["danger", "repoSettingsDangerZone"],
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
const featureSwitches = [
  ["tasksEnabled", "repoSettingsTasks", "repoSettingsTasksHint"],
  ["agentsEnabled", "repoSettingsAgents", "repoSettingsAgentsHint"],
  ["deploymentsEnabled", "repoSettingsDeployments", "repoSettingsDeploymentsHint"],
  ["graphEnabled", "repoSettingsGraph", "repoSettingsGraphHint"],
  ["actionsEnabled", "repoSettingsActions", "repoSettingsActionsHint"],
  ["actionsNetworkEnabled", "repoSettingsActionsNetwork", "repoSettingsActionsNetworkHint"],
  ["onlineEditingEnabled", "repoSettingsOnlineEditing", "repoSettingsOnlineEditingHint"],
] as const;
const mergeMethodSwitches = [
  ["allowMergeCommit", "repoSettingsAllowMergeCommit"],
  ["allowSquashMerge", "repoSettingsAllowSquashMerge"],
  ["allowRebaseMerge", "repoSettingsAllowRebaseMerge"],
  ["deleteBranchOnMerge", "repoSettingsDeleteBranchOnMerge"],
] as const;
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
  "tasksEnabled",
  "agentsEnabled",
  "deploymentsEnabled",
  "graphEnabled",
  "actionsEnabled",
  "actionsNetworkEnabled",
  "onlineEditingEnabled",
  "allowMergeCommit",
  "allowSquashMerge",
  "allowRebaseMerge",
  "deleteBranchOnMerge",
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
const revocationIncomplete = ref(false);
let loadVersion = 0;

const dirty = computed(
  () =>
    settings.value !== null &&
    draft.value !== null &&
    editableFields.some((field) => draft.value?.[field] !== settings.value?.[field])
);
const canManage = computed(() => settings.value?.canManage === true);
const archiveConfirm = useTemplateRef<InstanceType<typeof ConfirmButton>>("archiveConfirm");
const archivingNow = computed(
  () => draft.value?.archived === true && settings.value?.archived === false
);
useUnsavedGuard(dirty, { keepsForm: (to) => to.path === route.path });
const mergeMethodEnabled = computed(
  () =>
    draft.value !== null &&
    (draft.value.allowMergeCommit || draft.value.allowSquashMerge || draft.value.allowRebaseMerge)
);
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
  const options: FluentSelectOption[] = branches.value.map((branch) => ({
    value: branch,
    label: branch,
  }));
  const current = draft.value?.defaultBranch;
  if (current && !branches.value.includes(current))
    options.unshift({
      value: current,
      label: current,
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
  if (!draft.value || !settings.value || !canManage.value || !mergeMethodEnabled.value) return;
  saving.value = true;
  saveError.value = "";
  saved.value = false;
  revocationIncomplete.value = false;
  try {
    const payload: RepositoryDraft = { ...draft.value };
    const result = await api.updateRepositorySettings(props.repository.id, payload);
    const renamed = result.slug !== props.repository.slug;
    const owner = props.repository.owner;
    const { revocationIncomplete: incomplete, ...applied } = result;
    settings.value = applied;
    draft.value = editable(applied);
    saved.value = true;
    revocationIncomplete.value = incomplete === true;
    emit("updated", applied);
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

function submit() {
  if (archivingNow.value) {
    void archiveConfirm.value?.arm();
    return;
  }
  void save();
}

function sectionName(section: SettingsSection): string {
  return t(sections.find(([key]) => key === section)?.[1] ?? "repoSettingsGeneral");
}

watch(() => props.repository.id, load, { immediate: true });
</script>

<template>
  <section class="repository-settings">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <form v-else-if="settings && draft" class="settings-layout" @submit.prevent="submit">
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
            class="settings-nav-item"
            :aria-current="activeSection === key ? 'page' : undefined"
            @click="activeSection = key"
          >
            {{ sectionName(key) }}
          </button>
        </nav>

        <div class="settings-main">
          <section
            v-if="activeSection === 'general'"
            class="box"
            aria-labelledby="settings-general-title"
          >
            <header class="box-header">
              <h3 id="settings-general-title">{{ sectionName("general") }}</h3>
            </header>
            <div class="box-row settings-row">
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
            <div class="box-row settings-row">
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
            <div class="box-row settings-row">
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
            <div class="box-row settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsDefaultBranch") }}</span>
                <p>{{ t("repoSettingsDefaultBranchHint") }}</p>
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
            class="box"
            aria-labelledby="settings-features-title"
          >
            <header class="box-header">
              <h3 id="settings-features-title">{{ sectionName("features") }}</h3>
            </header>
            <p class="box-row field-hint">{{ t("repoSettingsFeaturesIntro") }}</p>
            <div class="box-row settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsIssues") }}</span>
                <p>{{ t("repoSettingsIssuesHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.issuesEnabled"
                :label="t('repoSettingsIssues')"
                :disabled="!canManage"
              />
            </div>
            <div class="box-row settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsPulls") }}</span>
                <p>{{ t("repoSettingsPullsHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.pullsEnabled"
                :label="t('repoSettingsPulls')"
                :disabled="!canManage"
              />
            </div>
            <div class="box-row settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsDiscussions") }}</span>
                <p>{{ t("repoSettingsDiscussionsHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.discussionsEnabled"
                :label="t('repoSettingsDiscussions')"
                :disabled="!canManage"
              />
            </div>
            <div class="box-row settings-row">
              <div class="row-copy">
                <span>{{ t("repoSettingsWiki") }}</span>
                <p>{{ t("repoSettingsWikiHint") }}</p>
              </div>
              <FluentSwitch
                v-model="draft.wikiEnabled"
                :label="t('repoSettingsWiki')"
                :disabled="!canManage"
              />
            </div>
            <div
              v-for="[key, label, hint] in featureSwitches"
              :key="key"
              class="box-row settings-row"
            >
              <div class="row-copy">
                <span>{{ t(label) }}</span>
                <p>{{ t(hint) }}</p>
              </div>
              <FluentSwitch v-model="draft[key]" :label="t(label)" :disabled="!canManage" />
            </div>
          </section>

          <section
            v-else-if="activeSection === 'merge'"
            class="box"
            aria-labelledby="settings-merge-title"
          >
            <header class="box-header">
              <h3 id="settings-merge-title">{{ sectionName("merge") }}</h3>
            </header>
            <div class="box-row settings-row">
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
            <div class="box-row settings-row">
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
            <div
              v-for="[key, label] in mergeMethodSwitches"
              :key="key"
              class="box-row settings-row"
            >
              <div class="row-copy">
                <span>{{ t(label) }}</span>
                <p v-if="key === 'deleteBranchOnMerge'">{{ t("repoSettingsDeleteBranchHint") }}</p>
              </div>
              <FluentSwitch v-model="draft[key]" :label="t(label)" :disabled="!canManage" />
            </div>
            <div v-if="!mergeMethodEnabled" class="box-form">
              <NoticeBar intent="warning">
                {{ t("repoSettingsMergeMethodRequired") }}
              </NoticeBar>
            </div>
          </section>

          <BranchProtectionSettings
            v-else-if="activeSection === 'branchRules'"
            :repository-id="props.repository.id"
            :can-manage="canManage"
          />
          <RepositoryCollaborators
            v-else-if="activeSection === 'collaborators'"
            :repository-id="props.repository.id"
            :can-manage="canManage"
          />
          <RepositoryWebhooks
            v-else-if="activeSection === 'webhooks'"
            :repository-id="props.repository.id"
            :can-manage="canManage"
          />

          <section
            v-else-if="activeSection === 'audit'"
            class="box"
            aria-labelledby="settings-audit-title"
          >
            <header class="box-header">
              <h3 id="settings-audit-title">{{ t("auditLogTitle") }}</h3>
            </header>
            <p class="box-row field-hint">{{ t("auditRepositoryHint") }}</p>
            <AuditLogList
              v-if="canManage"
              :load="(cursor) => api.repositoryAuditLog(props.repository.id, cursor)"
              :reload-key="props.repository.id"
            />
            <div v-else class="box-form">
              <NoticeBar intent="info">{{ t("auditAdminOnly") }}</NoticeBar>
            </div>
          </section>

          <section
            v-else-if="activeSection === 'agents'"
            class="box"
            aria-labelledby="settings-agents-title"
          >
            <header class="box-header">
              <h3 id="settings-agents-title">{{ sectionName("agents") }}</h3>
            </header>
            <div class="box-row settings-row">
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
            <p v-if="!publicMemoryAllowed" class="box-row field-hint">
              {{ t("repoSettingsMemoryPrivateNote") }}
            </p>
            <div class="box-row settings-row">
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

          <section v-else class="box box-danger" aria-labelledby="settings-danger-title">
            <header class="box-header">
              <h3 id="settings-danger-title">{{ sectionName("danger") }}</h3>
            </header>
            <div class="box-row settings-row">
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
            <div v-if="draft.archived" class="box-form">
              <NoticeBar intent="warning">{{ t("repoSettingsArchived") }}</NoticeBar>
            </div>
            <RepositoryDangerActions :repository="props.repository" :can-manage="canManage" />
          </section>

          <NoticeBar v-if="branchesError && activeSection !== 'general'" intent="warning">{{
            t("repoSettingsBranchUnavailable")
          }}</NoticeBar>
          <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
          <NoticeBar v-else-if="saved && !dirty" intent="success">{{
            t("settingsSaved")
          }}</NoticeBar>
          <NoticeBar v-if="revocationIncomplete" intent="warning">{{
            t("revocationIncomplete")
          }}</NoticeBar>
          <div class="form-actions">
            <ConfirmButton
              v-if="archivingNow"
              ref="archiveConfirm"
              tone="primary"
              :label="t('save')"
              :prompt="t('confirmArchiveRepository')"
              :disabled="!canManage || saving || !dirty || !mergeMethodEnabled"
              :busy="saving"
              @confirm="save"
            />
            <FluentButton
              v-else
              type="submit"
              tone="primary"
              :disabled="!canManage || saving || !dirty || !mergeMethodEnabled"
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
.settings-row :deep(.fluent-field__label),
.settings-row :deep(.fluent-select__label),
.settings-row :deep(.fluent-switch__label) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.repository-settings {
  min-width: 0;
}
.settings-layout {
  display: grid;
  gap: var(--space-5);
  max-width: 1100px;
  margin: 0 auto;
}
.settings-body {
  display: grid;
  grid-template-columns: minmax(180px, 224px) minmax(0, 1fr);
  gap: var(--space-8);
  align-items: start;
}
.settings-nav {
  position: sticky;
  top: var(--space-4);
}
.settings-main {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.branch-error {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.branch-error p {
  color: var(--danger-fg);
}
@media (max-width: 760px) {
  .settings-body {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-4);
  }
  .settings-nav {
    position: static;
  }
}
</style>
