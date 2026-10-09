<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField, FluentSelect } from "@platform-kit/fluent/vue";
import type { CreatedInvitation, Invitation, InviteePayload } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

export type InvitationScope =
  { kind: "organization"; slug: string } | { kind: "repository"; repositoryId: string };

const props = defineProps<{
  scope: InvitationScope;
  roles: readonly { value: string; label: string }[];
  defaultRole: string;
  canManage: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { t, d } = useI18n();
const invitations = ref<Invitation[]>([]);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const saving = ref(false);
const cancellingId = ref("");
const mode = ref<"identifier" | "email">("identifier");
const value = ref("");
const role = ref(props.defaultRole);
const created = ref<CreatedInvitation | null>(null);
const copied = ref(false);
let copiedTimer: number | undefined;
let version = 0;

const modeOptions = computed(() => [
  { value: "identifier", label: t("inviteByUsername") },
  { value: "email", label: t("inviteByEmail") },
]);
const link = computed(() =>
  created.value?.token ? `${window.location.origin}/invite#${created.value.token}` : ""
);

async function load(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const list =
      props.scope.kind === "organization"
        ? await api.organizationInvitations(props.scope.slug)
        : await api.repositoryInvitations(props.scope.repositoryId);
    if (current === version) invitations.value = list;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

async function invite(): Promise<void> {
  const text = value.value.trim();
  if (!props.canManage || saving.value || !text) return;
  saving.value = true;
  formError.value = "";
  created.value = null;
  const invitee: InviteePayload = mode.value === "email" ? { email: text } : { identifier: text };
  try {
    created.value =
      props.scope.kind === "organization"
        ? await api.inviteOrganizationMember(props.scope.slug, {
            ...invitee,
            role: role.value === "owner" ? "owner" : "member",
          })
        : await api.inviteRepositoryCollaborator(props.scope.repositoryId, {
            ...invitee,
            role: role.value === "admin" ? "admin" : role.value === "write" ? "write" : "read",
          });
    value.value = "";
    await load();
    emit("changed");
  } catch (cause) {
    formError.value = errorMessage(
      cause,
      t,
      { 404: "inviteUserNotFound", 409: "inviteConflict" },
      "inviteError"
    );
  } finally {
    saving.value = false;
  }
}

async function cancel(item: Invitation): Promise<void> {
  if (!props.canManage || cancellingId.value) return;
  cancellingId.value = item.id;
  formError.value = "";
  try {
    if (props.scope.kind === "organization")
      await api.cancelOrganizationInvitation(props.scope.slug, item.id);
    else await api.cancelRepositoryInvitation(props.scope.repositoryId, item.id);
    await load();
  } catch (cause) {
    formError.value = errorMessage(cause, t);
  } finally {
    cancellingId.value = "";
  }
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value);
    copied.value = true;
    if (copiedTimer !== undefined) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    formError.value = t("copyFailed");
  }
}

function roleLabel(item: string): string {
  return props.roles.find((entry) => entry.value === item)?.label ?? item;
}

watch(
  () => JSON.stringify(props.scope),
  () => {
    created.value = null;
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="box member-invitations" aria-labelledby="invitations-title">
    <header class="box-header">
      <h3 id="invitations-title">{{ t("inviteTitle") }}</h3>
      <StatusBadge>{{ invitations.length }}</StatusBadge>
    </header>
    <p class="box-row field-hint">{{ t("inviteHint") }}</p>
    <div v-if="canManage" class="box-form invite-form" @keydown.enter.stop.prevent="invite">
      <FluentSelect
        v-model="mode"
        :label="t('inviteBy')"
        :options="modeOptions"
        :disabled="saving"
      />
      <FluentField
        v-model="value"
        :label="mode === 'email' ? t('inviteEmail') : t('inviteUsername')"
        :type="mode === 'email' ? 'email' : 'text'"
        :disabled="saving"
      />
      <FluentSelect v-model="role" :label="t('role')" :options="roles" :disabled="saving" />
      <FluentButton
        type="button"
        tone="primary"
        :disabled="saving || !value.trim()"
        :busy="saving"
        @click="invite"
      >
        {{ saving ? t("loading") : t("inviteSend") }}
      </FluentButton>
    </div>
    <div v-if="created" class="box-form form-stack" aria-live="polite">
      <NoticeBar intent="success">{{
        created.token ? t("inviteLinkOnce") : t("inviteSent", { name: created.invitee ?? "" })
      }}</NoticeBar>
      <template v-if="created.token">
        <FluentField :model-value="link" :label="t('inviteLink')" readonly type="text" />
        <div class="settings-actions">
          <FluentButton type="button" tone="secondary" @click="copyLink">{{
            copied ? t("settingsCopied") : t("copy")
          }}</FluentButton>
        </div>
      </template>
    </div>
    <div v-if="formError" class="box-form">
      <NoticeBar intent="error">{{ formError }}</NoticeBar>
    </div>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!invitations.length" class="settings-empty">{{ t("inviteNone") }}</p>
      <ul v-else class="settings-list">
        <li v-for="item in invitations" :key="item.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ item.invitee ?? item.inviteeEmail ?? t("inviteLinkOnly") }}
              <StatusBadge>{{ roleLabel(item.role) }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t("invitedBy", { name: item.inviter }) }}</span>
              <span>{{ t("inviteExpires", { date: d(item.expiresAt, "long") }) }}</span>
            </div>
          </div>
          <ConfirmButton
            v-if="canManage"
            size="small"
            tone="secondary"
            :label="cancellingId === item.id ? t('loading') : t('inviteCancel')"
            :accessible-name="`${t('inviteCancel')} · ${item.invitee ?? item.inviteeEmail ?? ''}`"
            :prompt="t('inviteCancelPrompt')"
            :disabled="Boolean(cancellingId)"
            @confirm="cancel(item)"
          />
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.invite-form {
  display: grid;
  grid-template-columns: minmax(140px, 200px) minmax(0, 1fr) minmax(130px, 180px) auto;
  gap: var(--space-3);
  align-items: end;
  border-top: 1px solid var(--border-muted);
}
@media (max-width: 760px) {
  .invite-form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
