<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  BranchProtectionInputSchema,
  type BranchProtectionInput,
  type BranchProtectionRule,
} from "../../../../packages/contracts/src/repository-controls";
import { api } from "../lib/api";
import {
  FluentButton,
  FluentField,
  FluentSelect,
  FluentSwitch,
  FluentTextArea,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repositoryId: string; canManage: boolean }>();
const { t } = useI18n();
const rules = ref<BranchProtectionRule[]>([]);
const loading = ref(true);
const error = ref("");
const saveError = ref("");
const deleteError = ref("");
const notice = ref("");
const saving = ref(false);
const deletingId = ref("");
const editingId = ref<string | null>(null);
const target = ref<"branch" | "tag">("branch");
const pattern = ref("");
const enabled = ref(true);
const locked = ref(false);
const requiredApprovals = ref(0);
const requirePassingChecks = ref(false);
const requiredStatusChecksText = ref("");
const requireLinearHistory = ref(false);
const requireSignedCommits = ref(false);
const requireConversationResolution = ref(false);
const requireMergeQueue = ref(false);
const requireIndependentApproval = ref(false);
const forbidTagUpdate = ref(false);
const forbidTagDeletion = ref(false);
const targetOptions = computed<readonly FluentSelectOption[]>(() => [
  { value: "branch", label: t("branchRuleTargetBranch") },
  { value: "tag", label: t("branchRuleTargetTag") },
]);
const approvalOptions = computed<readonly FluentSelectOption[]>(() =>
  Array.from({ length: 6 }, (_, index) => ({ value: String(index), label: String(index) }))
);
let loadVersion = 0;

function resetForm(): void {
  editingId.value = null;
  target.value = "branch";
  pattern.value = "";
  enabled.value = true;
  locked.value = false;
  requiredApprovals.value = 0;
  requirePassingChecks.value = false;
  requiredStatusChecksText.value = "";
  requireLinearHistory.value = false;
  requireSignedCommits.value = false;
  requireConversationResolution.value = false;
  requireMergeQueue.value = false;
  requireIndependentApproval.value = false;
  forbidTagUpdate.value = false;
  forbidTagDeletion.value = false;
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.branchRules(props.repositoryId);
    if (version === loadVersion) rules.value = result;
  } catch {
    if (version === loadVersion) error.value = t("branchRuleLoadError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

function edit(rule: BranchProtectionRule): void {
  editingId.value = rule.id;
  target.value = rule.target;
  pattern.value = rule.pattern;
  enabled.value = rule.enabled;
  locked.value = rule.locked;
  requiredApprovals.value = rule.requiredApprovals;
  requirePassingChecks.value = rule.requirePassingChecks;
  requiredStatusChecksText.value = rule.requiredStatusChecks.join("\n");
  requireLinearHistory.value = rule.requireLinearHistory;
  requireSignedCommits.value = rule.requireSignedCommits;
  requireConversationResolution.value = rule.requireConversationResolution;
  requireMergeQueue.value = rule.requireMergeQueue;
  requireIndependentApproval.value = rule.requireIndependentApproval;
  forbidTagUpdate.value = rule.forbidTagUpdate;
  forbidTagDeletion.value = rule.forbidTagDeletion;
  saveError.value = "";
  notice.value = "";
}

function formValue(): BranchProtectionInput {
  return {
    target: target.value,
    pattern: pattern.value,
    enabled: enabled.value,
    locked: target.value === "branch" && locked.value,
    requiredApprovals: target.value === "branch" ? requiredApprovals.value : 0,
    requirePassingChecks: target.value === "branch" && requirePassingChecks.value,
    requiredStatusChecks:
      target.value === "branch"
        ? requiredStatusChecksText.value
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean)
        : [],
    requireLinearHistory: target.value === "branch" && requireLinearHistory.value,
    requireSignedCommits: target.value === "branch" && requireSignedCommits.value,
    requireConversationResolution: target.value === "branch" && requireConversationResolution.value,
    requireMergeQueue: target.value === "branch" && requireMergeQueue.value,
    requireIndependentApproval: target.value === "branch" && requireIndependentApproval.value,
    forbidTagUpdate: target.value === "tag" && forbidTagUpdate.value,
    forbidTagDeletion: target.value === "tag" && forbidTagDeletion.value,
  };
}

function handleEnter(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.target instanceof HTMLInputElement) event.preventDefault();
}

function setTarget(value: string): void {
  if (value === "branch" || value === "tag") target.value = value;
}

async function save(): Promise<void> {
  if (!props.canManage || saving.value || deletingId.value) return;
  saveError.value = "";
  deleteError.value = "";
  notice.value = "";
  const parsed = BranchProtectionInputSchema.safeParse(formValue());
  if (!parsed.success) {
    saveError.value = t("branchRuleSaveError");
    return;
  }
  saving.value = true;
  try {
    const saved = editingId.value
      ? await api.updateBranchRule(props.repositoryId, editingId.value, parsed.data)
      : await api.createBranchRule(props.repositoryId, parsed.data);
    if (editingId.value) {
      rules.value = rules.value.map((rule) => (rule.id === saved.id ? saved : rule));
    } else {
      rules.value = [...rules.value, saved].sort((a, b) => a.pattern.localeCompare(b.pattern));
    }
    resetForm();
    notice.value = t("branchRuleSaved");
  } catch {
    saveError.value = t("branchRuleSaveError");
  } finally {
    saving.value = false;
  }
}

async function remove(rule: BranchProtectionRule): Promise<void> {
  if (!props.canManage || saving.value || deletingId.value) return;
  deleteError.value = "";
  notice.value = "";
  deletingId.value = rule.id;
  try {
    await api.deleteBranchRule(props.repositoryId, rule.id);
    rules.value = rules.value.filter((item) => item.id !== rule.id);
    if (editingId.value === rule.id) resetForm();
    notice.value = t("branchRuleDeleted");
  } catch {
    deleteError.value = t("branchRuleDeleteError");
  } finally {
    deletingId.value = "";
  }
}

watch(
  () => props.repositoryId,
  () => {
    resetForm();
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="box" aria-labelledby="branch-rules-title">
    <header class="box-header">
      <h3 id="branch-rules-title">{{ t("repoSettingsBranchRules") }}</h3>
    </header>
    <p class="box-row field-hint">{{ t("branchRulesIntro") }}</p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!rules.length" class="settings-empty">{{ t("branchRuleEmpty") }}</p>
      <ul v-else class="settings-list">
        <li v-for="rule in rules" :key="rule.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              <span class="field-hint">{{
                t(rule.target === "tag" ? "branchRuleTargetTag" : "branchRuleTargetBranch")
              }}</span>
              {{ rule.pattern }}
              <StatusBadge :tone="rule.enabled ? 'success' : 'neutral'">{{
                rule.enabled ? t("branchRuleEnabled") : t("branchRuleDisabled")
              }}</StatusBadge>
            </div>
            <small v-if="rule.target === 'tag' && (rule.forbidTagUpdate || rule.forbidTagDeletion)">
              {{
                [
                  rule.forbidTagUpdate ? t("branchRuleForbidTagUpdate") : "",
                  rule.forbidTagDeletion ? t("branchRuleForbidTagDeletion") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              }}
            </small>
            <small v-if="rule.target === 'branch' && rule.locked">{{
              t("branchRuleLocked")
            }}</small>
            <small v-if="rule.target === 'branch' && rule.requireIndependentApproval">{{
              t("branchRuleIndependentApproval")
            }}</small>
            <small v-if="rule.target === 'branch' && rule.requiredApprovals"
              >{{ t("branchRuleApprovals") }}: {{ rule.requiredApprovals }}</small
            >
            <small
              v-if="
                rule.target === 'branch' &&
                (rule.requirePassingChecks || rule.requiredStatusChecks.length)
              "
            >
              {{
                [
                  rule.requirePassingChecks ? t("branchRulePassingChecks") : "",
                  ...rule.requiredStatusChecks,
                ]
                  .filter(Boolean)
                  .join(" · ")
              }}
            </small>
            <small
              v-if="
                rule.target === 'branch' &&
                (rule.requireLinearHistory ||
                  rule.requireSignedCommits ||
                  rule.requireConversationResolution ||
                  rule.requireMergeQueue)
              "
            >
              {{
                [
                  rule.requireLinearHistory ? t("branchRuleLinearHistory") : "",
                  rule.requireSignedCommits ? t("branchRuleSignedCommits") : "",
                  rule.requireConversationResolution ? t("branchRuleConversation") : "",
                  rule.requireMergeQueue ? t("branchRuleMergeQueue") : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              }}
            </small>
          </div>
          <div class="settings-actions">
            <FluentButton
              type="button"
              :disabled="!canManage || saving || Boolean(deletingId)"
              @click="edit(rule)"
              >{{ t("branchRuleEdit") }}</FluentButton
            >
            <ConfirmButton
              tone="secondary"
              :label="deletingId === rule.id ? t('loading') : t('branchRuleDelete')"
              :prompt="t('confirmRemoveRule')"
              :disabled="!canManage || saving || Boolean(deletingId)"
              @confirm="remove(rule)"
            />
          </div>
        </li>
      </ul>

      <div class="box-form form-stack branch-rule-form" @keydown.enter="handleEnter">
        <h4>{{ t(editingId ? "branchRuleEdit" : "branchRuleCreate") }}</h4>
        <FluentSelect
          :model-value="target"
          :label="t('branchRuleTarget')"
          :options="targetOptions"
          :disabled="!canManage || saving"
          @update:model-value="setTarget"
        />
        <FluentField
          v-model="pattern"
          :label="t(target === 'branch' ? 'branchRulePattern' : 'tagRulePattern')"
          :disabled="!canManage || saving"
        />
        <div class="control-fields">
          <FluentSwitch
            v-model="enabled"
            :label="t('branchRuleEnabled')"
            :disabled="!canManage || saving"
          />
          <template v-if="target === 'branch'">
            <FluentSwitch
              v-model="requireIndependentApproval"
              :label="t('branchRuleIndependentApproval')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="locked"
              :label="t('branchRuleLocked')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="requirePassingChecks"
              :label="t('branchRulePassingChecks')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="requireLinearHistory"
              :label="t('branchRuleLinearHistory')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="requireSignedCommits"
              :label="t('branchRuleSignedCommits')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="requireConversationResolution"
              :label="t('branchRuleConversationResolution')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="requireMergeQueue"
              :label="t('branchRuleMergeQueueRequire')"
              :disabled="!canManage || saving"
            />
          </template>
          <template v-else>
            <FluentSwitch
              v-model="forbidTagUpdate"
              :label="t('branchRuleForbidTagUpdate')"
              :disabled="!canManage || saving"
            />
            <FluentSwitch
              v-model="forbidTagDeletion"
              :label="t('branchRuleForbidTagDeletion')"
              :disabled="!canManage || saving"
            />
          </template>
        </div>
        <template v-if="target === 'branch'">
          <p class="field-hint">{{ t("branchRuleLockedHint") }}</p>
          <p v-if="requireIndependentApproval" class="field-hint">
            {{ t("branchRuleIndependentHint") }}
          </p>
          <p v-if="requireLinearHistory" class="field-hint">
            {{ t("branchRuleLinearHint") }}
          </p>
          <p v-if="requireSignedCommits" class="field-hint">
            {{ t("branchRuleSignedHint") }}
          </p>
          <p v-if="requireConversationResolution" class="field-hint">
            {{ t("branchRuleConversationHint") }}
          </p>
          <p v-if="requireMergeQueue" class="field-hint">
            {{ t("branchRuleMergeQueueHint") }}
          </p>
          <FluentSelect
            :model-value="String(requiredApprovals)"
            :label="t('branchRuleApprovals')"
            :options="approvalOptions"
            :disabled="!canManage || saving"
            @update:model-value="requiredApprovals = Number($event)"
          />
          <p class="field-hint">{{ t("branchRuleRequiredChecksHint") }}</p>
          <FluentTextArea
            v-model="requiredStatusChecksText"
            :label="t('branchRuleRequiredChecks')"
            :disabled="!canManage || saving"
          />
        </template>
        <p v-if="target === 'tag'" class="field-hint">{{ t("tagRuleRequiredActionHint") }}</p>
        <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
        <NoticeBar v-if="deleteError" intent="error">{{ deleteError }}</NoticeBar>
        <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
        <div class="form-actions">
          <FluentButton
            type="button"
            tone="primary"
            :disabled="!canManage || saving"
            :busy="saving"
            @click="save"
            >{{
              saving ? t("loading") : t(editingId ? "branchRuleUpdate" : "branchRuleCreate")
            }}</FluentButton
          >
          <FluentButton v-if="editingId" type="button" :disabled="saving" @click="resetForm">{{
            t("branchRuleCancel")
          }}</FluentButton>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.branch-rule-form {
  border-top: 1px solid var(--border-muted);
}
.control-fields {
  display: grid;
  gap: var(--space-3);
}
</style>
