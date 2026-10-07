<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryCollaborator, RepositoryRole } from "../lib/api";
import { api } from "../lib/api";
import {
  FluentButton,
  FluentField,
  FluentSelect,
  type FluentSelectOption,
} from "@platform-kit/fluent/vue";
import ConfirmButton from "./ConfirmButton.vue";
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
const identifier = ref("");
const role = ref<RepositoryRole>("read");
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

async function save(): Promise<void> {
  const normalizedIdentifier = identifier.value.trim();
  if (!props.canManage || saving.value || !normalizedIdentifier) return;
  saving.value = true;
  saveError.value = "";
  notice.value = "";
  try {
    const saved = await api.putRepositoryCollaborator(props.repositoryId, {
      identifier: normalizedIdentifier,
      role: role.value,
    });
    collaborators.value = [
      ...collaborators.value.filter((item) => item.id !== saved.id),
      saved,
    ].sort((a, b) => a.identifier.localeCompare(b.identifier));
    identifier.value = "";
    notice.value = t("collaboratorSaved");
  } catch {
    saveError.value = t("collaboratorSaveError");
  } finally {
    saving.value = false;
  }
}

async function updateRole(item: RepositoryCollaborator, value: string): Promise<void> {
  const nextRole = oneOf(roleValues, value, item.role);
  if (!props.canManage || item.inherited || saving.value || nextRole === item.role) return;
  saving.value = true;
  saveError.value = "";
  notice.value = "";
  try {
    const saved = await api.putRepositoryCollaborator(props.repositoryId, {
      identifier: item.identifier,
      role: nextRole,
    });
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
  <section class="repository-collaborators settings-card">
    <h3>{{ t("repoSettingsCollaborators") }}</h3>
    <p class="collaborator-intro">{{ t("collaboratorIntro") }}</p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!collaborators.length" class="collaborator-empty">{{ t("collaboratorEmpty") }}</p>
      <ul v-else class="collaborator-list">
        <li v-for="item in collaborators" :key="item.id" class="collaborator-row">
          <div class="collaborator-copy">
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

      <div class="collaborator-form" @keydown.enter.stop.prevent>
        <FluentField
          v-model="identifier"
          :label="t('collaboratorIdentifier')"
          :disabled="!canManage || saving"
        />
        <FluentSelect
          v-model="role"
          :label="t('collaboratorRole')"
          :options="roleOptions"
          :disabled="!canManage || saving"
        />
        <FluentButton
          type="button"
          tone="primary"
          :disabled="!canManage || saving || !identifier.trim()"
          :busy="saving"
          @click="save"
        >
          {{ saving ? t("loading") : t("collaboratorAdd") }}
        </FluentButton>
      </div>
    </template>
    <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
    <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
    <NoticeBar v-if="revocationIncomplete" intent="warning">{{
      t("revocationIncomplete")
    }}</NoticeBar>
  </section>
</template>

<style scoped>
.collaborator-intro,
.collaborator-empty {
  margin: 14px 20px;
  color: var(--fluent-muted);
  font-size: 13px;
}
.collaborator-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.collaborator-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px) auto;
  gap: 12px;
  align-items: center;
  padding: 14px 20px;
  border-top: 1px solid var(--fluent-border);
}
.collaborator-copy {
  display: grid;
  gap: 4px;
}
.collaborator-copy small {
  color: var(--fluent-muted);
  font-size: 12px;
}
.collaborator-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 220px) auto;
  gap: 12px;
  align-items: end;
  padding: 20px;
  border-top: 1px solid var(--fluent-border);
}
.repository-collaborators :deep(.notice-bar) {
  margin: 12px 20px;
}
@media (max-width: 760px) {
  .collaborator-row,
  .collaborator-form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
