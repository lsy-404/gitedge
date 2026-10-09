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
const pattern = ref("");
const enabled = ref(true);
const locked = ref(false);
const requiredApprovals = ref(0);
const requirePassingChecks = ref(false);
const requiredStatusChecksText = ref("");
const requireLinearHistory = ref(false);
const requireSignedCommits = ref(false);
const requireConversationResolution = ref(false);
const approvalOptions = computed<readonly FluentSelectOption[]>(() =>
  Array.from({ length: 6 }, (_, index) => ({ value: String(index), label: String(index) }))
);
let loadVersion = 0;

function resetForm(): void {
  editingId.value = null;
  pattern.value = "";
  enabled.value = true;
  locked.value = false;
  requiredApprovals.value = 0;
  requirePassingChecks.value = false;
  requiredStatusChecksText.value = "";
  requireLinearHistory.value = false;
  requireSignedCommits.value = false;
  requireConversationResolution.value = false;
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
  pattern.value = rule.pattern;
  enabled.value = rule.enabled;
  locked.value = rule.locked;
  requiredApprovals.value = rule.requiredApprovals;
  requirePassingChecks.value = rule.requirePassingChecks;
  requiredStatusChecksText.value = rule.requiredStatusChecks.join("\n");
  requireLinearHistory.value = rule.requireLinearHistory;
  requireSignedCommits.value = rule.requireSignedCommits;
  requireConversationResolution.value = rule.requireConversationResolution;
  saveError.value = "";
  notice.value = "";
}

function formValue(): BranchProtectionInput {
  return {
    pattern: pattern.value,
    enabled: enabled.value,
    locked: locked.value,
    requiredApprovals: requiredApprovals.value,
    requirePassingChecks: requirePassingChecks.value,
    requiredStatusChecks: requiredStatusChecksText.value
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
    requireLinearHistory: requireLinearHistory.value,
    requireSignedCommits: requireSignedCommits.value,
    requireConversationResolution: requireConversationResolution.value,
  };
}

function handleEnter(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.target instanceof HTMLInputElement) event.preventDefault();
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
              {{ rule.pattern }}
              <StatusBadge :tone="rule.enabled ? 'success' : 'neutral'">{{
                rule.enabled ? t("branchRuleEnabled") : t("branchRuleDisabled")
              }}</StatusBadge>
            </div>
            <small v-if="rule.locked">{{ t("branchRuleLocked") }}</small>
            <small v-if="rule.requiredApprovals"
              >{{ t("branchRuleApprovals") }}: {{ rule.requiredApprovals }}</small
            >
            <small v-if="rule.requirePassingChecks || rule.requiredStatusChecks.length">
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
                rule.requireLinearHistory ||
                rule.requireSignedCommits ||
                rule.requireConversationResolution
              "
            >
              {{
                [
                  rule.requireLinearHistory ? t("branchRuleLinearHistory") : "",
                  rule.requireSignedCommits ? t("branchRuleSignedCommits") : "",
                  rule.requireConversationResolution ? t("branchRuleConversation") : "",
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
        <FluentField
          v-model="pattern"
          :label="t('branchRulePattern')"
          :disabled="!canManage || saving"
        />
        <div class="control-fields">
          <FluentSwitch
            v-model="enabled"
            :label="t('branchRuleEnabled')"
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
        </div>
        <p class="field-hint">{{ t("branchRuleLockedHint") }}</p>
        <p v-if="requireLinearHistory" class="field-hint">
          {{ t("branchRuleLinearHint") }}
        </p>
        <p v-if="requireSignedCommits" class="field-hint">
          {{ t("branchRuleSignedHint") }}
        </p>
        <p v-if="requireConversationResolution" class="field-hint">
          {{ t("branchRuleConversationHint") }}
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
