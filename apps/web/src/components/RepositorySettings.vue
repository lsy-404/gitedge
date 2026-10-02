<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AgentAssignmentPolicy,
  MemoryVisibility,
  Repository,
  RepositorySettings,
} from "../lib/api";
import { ApiError, api } from "../lib/api";
import { errorMessage } from "../lib/tasks";
import { oneOf } from "../ui/formEvents";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusState from "./StatusState.vue";

const visibilities = ["members", "public"] as const satisfies readonly MemoryVisibility[];
const policies = ["owner", "members"] as const satisfies readonly AgentAssignmentPolicy[];

const props = defineProps<{ repository: Repository }>();
const { t } = useI18n();
const settings = ref<RepositorySettings | null>(null);
const memoryVisibility = ref<MemoryVisibility>("members");
const agentPolicy = ref<AgentAssignmentPolicy>("owner");
const loading = ref(true);
const error = ref("");
const saving = ref(false);
const saveError = ref("");
const saved = ref(false);
let loadVersion = 0;

/**
 * Public exposure is only offered for public repositories; the server enforces the same rule. The
 * option binds the `disabled` attribute because Fluent recomputes the property from the attribute.
 */
const publicAllowed = computed(() => props.repository.visibility === "public");
const dirty = computed(
  () =>
    settings.value !== null &&
    (settings.value.memoryVisibility !== memoryVisibility.value ||
      settings.value.agentAssignmentPolicy !== agentPolicy.value)
);

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.repositorySettings(props.repository.id);
    if (version !== loadVersion) return;
    settings.value = result;
    memoryVisibility.value = result.memoryVisibility;
    agentPolicy.value = result.agentAssignmentPolicy;
  } catch (cause) {
    if (version !== loadVersion) return;
    error.value =
      cause instanceof ApiError && cause.status === 403
        ? t("permissionDenied")
        : errorMessage(cause, t);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function save() {
  saving.value = true;
  saveError.value = "";
  saved.value = false;
  try {
    settings.value = await api.updateRepositorySettings(props.repository.id, {
      memoryVisibility: memoryVisibility.value,
      agentAssignmentPolicy: agentPolicy.value,
    });
    saved.value = true;
  } catch (cause) {
    saveError.value = errorMessage(cause, t, { 400: "settingsPublicRejected" });
  } finally {
    saving.value = false;
  }
}

watch(() => props.repository.id, load, { immediate: true });
</script>

<template>
  <section class="settings-section">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <form v-else-if="settings" class="box box-form form-stack settings-form" @submit.prevent="save">
      <h2>{{ t("repositorySettings") }}</h2>
      <NoticeBar v-if="!settings.canManage" intent="info">{{ t("settingsOwnerOnly") }}</NoticeBar>

      <div class="setting">
        <SelectField
          :model-value="memoryVisibility"
          :label="t('memoryVisibility')"
          :disabled="!settings.canManage"
          @update:model-value="memoryVisibility = oneOf(visibilities, $event, 'members')"
        >
          <fluent-option value="members">{{ t("memoryVisibility_members") }}</fluent-option>
          <fluent-option value="public" :disabled.attr="publicAllowed ? undefined : ''">{{
            t("memoryVisibility_public")
          }}</fluent-option>
        </SelectField>
        <p class="muted hint">{{ t("memoryVisibilityHint") }}</p>
        <p v-if="!publicAllowed" class="muted hint">{{ t("memoryVisibilityPrivateNote") }}</p>
      </div>

      <div class="setting">
        <SelectField
          :model-value="agentPolicy"
          :label="t('agentPolicy')"
          :disabled="!settings.canManage"
          @update:model-value="agentPolicy = oneOf(policies, $event, 'owner')"
        >
          <fluent-option value="owner">{{ t("agentPolicy_owner") }}</fluent-option>
          <fluent-option value="members">{{ t("agentPolicy_members") }}</fluent-option>
        </SelectField>
        <p class="muted hint">{{ t("agentPolicyHint") }}</p>
      </div>

      <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
      <NoticeBar v-else-if="saved && !dirty" intent="success">{{ t("settingsSaved") }}</NoticeBar>
      <div v-if="settings.canManage" class="form-actions">
        <fluent-button type="submit" appearance="primary" :disabled="saving || !dirty">{{
          saving ? t("loading") : t("save")
        }}</fluent-button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.settings-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.settings-form h2 {
  margin: 0;
}
.setting {
  display: grid;
  gap: var(--spacingVerticalXS);
  min-width: 0;
}
.hint {
  font-size: var(--fontSizeBase200);
}
</style>
