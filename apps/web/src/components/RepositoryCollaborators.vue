<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryCollaborator } from "../lib/api";
import { api } from "../lib/api";
import { FluentSelect, type FluentSelectOption } from "@platform-kit/fluent/vue";
import ConfirmButton from "./ConfirmButton.vue";
import MemberInvitations from "./MemberInvitations.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";
import { oneOf } from "../ui/formEvents";

const props = defineProps<{ repositoryId: string; canManage: boolean }>();
const { t } = useI18n();
const collaborators = ref<RepositoryCollaborator[]>([]);
const loading = ref(true);
const error = ref("");
const saveError = ref("");
const notice = ref("");
const saving = ref(false);
const removingId = ref("");
const revocationIncomplete = ref(false);
const roleValues = ["read", "write", "admin"] as const;
const roleOptions = computed<readonly FluentSelectOption[]>(() => [
  { value: "read", label: t("collaboratorRead") },
  { value: "write", label: t("collaboratorWrite") },
  { value: "admin", label: t("collaboratorAdmin") },
]);
let loadVersion = 0;

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.repositoryCollaborators(props.repositoryId);
    if (version === loadVersion) collaborators.value = result;
  } catch {
    if (version === loadVersion) error.value = t("collaboratorLoadError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

async function updateRole(item: RepositoryCollaborator, value: string): Promise<void> {
  const nextRole = oneOf(roleValues, value, item.role);
  if (!props.canManage || item.inherited || saving.value || nextRole === item.role) return;
  saving.value = true;
  saveError.value = "";
  notice.value = "";
  try {
    const saved = await api.updateRepositoryCollaborator(props.repositoryId, item.id, nextRole);
    collaborators.value = collaborators.value.map((entry) =>
      entry.id === saved.id ? saved : entry
    );
    notice.value = t("collaboratorSaved");
  } catch {
    saveError.value = t("collaboratorSaveError");
  } finally {
    saving.value = false;
  }
}

async function remove(item: RepositoryCollaborator): Promise<void> {
  if (!props.canManage || item.inherited || saving.value || removingId.value) return;
  removingId.value = item.id;
  saveError.value = "";
  notice.value = "";
  revocationIncomplete.value = false;
  try {
    const result = await api.deleteRepositoryCollaborator(props.repositoryId, item.id);
    collaborators.value = collaborators.value.filter((entry) => entry.id !== item.id);
    notice.value = t("collaboratorDeleted");
    revocationIncomplete.value = result.revocationIncomplete === true;
  } catch {
    saveError.value = t("collaboratorDeleteError");
  } finally {
    removingId.value = "";
  }
}

watch(() => props.repositoryId, load, { immediate: true });
</script>

<template>
  <section class="box repository-collaborators" aria-labelledby="collaborators-title">
    <header class="box-header">
      <h3 id="collaborators-title">{{ t("repoSettingsCollaborators") }}</h3>
    </header>
    <p class="box-row field-hint">{{ t("collaboratorIntro") }}</p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!collaborators.length" class="settings-empty">{{ t("collaboratorEmpty") }}</p>
      <ul v-else class="settings-list">
        <li v-for="item in collaborators" :key="item.id" class="box-row collaborator-row">
          <div class="settings-item-copy">
            <strong>{{ item.identifier }}</strong>
            <small v-if="item.inherited">{{ t("collaboratorInherited") }}</small>
          </div>
          <FluentSelect
            :model-value="item.role"
            :label="t('collaboratorRole')"
            :options="roleOptions"
            :disabled="!canManage || item.inherited || saving"
            @update:model-value="updateRole(item, $event)"
          />
          <ConfirmButton
            tone="secondary"
            :label="removingId === item.id ? t('loading') : t('collaboratorRemove')"
            :accessible-name="`${t('collaboratorRemove')} · ${item.identifier}`"
            :prompt="t('confirmRemoveCollaborator')"
            :disabled="!canManage || item.inherited || saving || Boolean(removingId)"
            @confirm="remove(item)"
          />
        </li>
      </ul>
    </template>
    <div v-if="saveError || notice || revocationIncomplete" class="box-form form-stack">
      <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
      <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
      <NoticeBar v-if="revocationIncomplete" intent="warning">{{
        t("revocationIncomplete")
      }}</NoticeBar>
    </div>
  </section>
  <MemberInvitations
    :scope="{ kind: 'repository', repositoryId }"
    :roles="roleOptions"
    default-role="read"
    :can-manage="canManage"
  />
</template>

<style scoped>
.collaborator-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px) auto;
  gap: var(--space-3);
  align-items: center;
}
@media (max-width: 760px) {
  .collaborator-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
