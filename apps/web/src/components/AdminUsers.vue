<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentField } from "@platform-kit/fluent/vue";
import type { AdminGroup, AdminUser } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import { sessionState } from "../lib/session";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const { t, d } = useI18n();
const reauth = useReauthRetry();
const users = ref<AdminUser[]>([]);
const groups = ref<AdminGroup[]>([]);
const nextCursor = ref<string | null>(null);
const search = ref("");
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const actionError = ref("");
const notice = ref("");
const busyId = ref("");
let version = 0;

const self = computed(() => sessionState.user?.id ?? "");

async function load(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const [page, list] = await Promise.all([
      api.adminUsers({ q: search.value.trim() || undefined }),
      groups.value.length ? Promise.resolve(groups.value) : api.adminGroups(),
    ]);
    if (current !== version) return;
    users.value = page.items;
    nextCursor.value = page.nextCursor;
    groups.value = list;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

async function more(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await api.adminUsers({
      q: search.value.trim() || undefined,
      cursor: nextCursor.value,
    });
    users.value = [...users.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    loadingMore.value = false;
  }
}

async function mutate(user: AdminUser, work: () => Promise<unknown>): Promise<void> {
  if (busyId.value) return;
  busyId.value = user.id;
  actionError.value = "";
  notice.value = "";
  try {
    await work();
    const page = await api.adminUsers({ q: user.identifier });
    const fresh = page.items.find((item) => item.id === user.id);
    if (fresh) users.value = users.value.map((item) => (item.id === user.id ? fresh : item));
  } catch (cause) {
    if (reauth.intercept(cause, () => mutate(user, work))) return;
    actionError.value = errorMessage(cause, t);
  } finally {
    busyId.value = "";
  }
}

const setDisabled = (user: AdminUser, disabled: boolean) =>
  mutate(user, async () => {
    const result = await api.setAdminUserDisabled(user.id, disabled);
    if (result.revocationIncomplete) notice.value = t("adminRevocationIncomplete");
  });
const administrator = (user: AdminUser) => user.siteAdmin || user.configuredAdmin;
const setGroup = (user: AdminUser, groupKey: string) =>
  groupKey !== user.groupKey && mutate(user, () => api.updateAdminUser(user.id, { groupKey }));
const setSiteAdmin = (user: AdminUser, siteAdmin: boolean) =>
  mutate(user, () => api.updateAdminUser(user.id, { siteAdmin }));

onMounted(load);
</script>

<template>
  <section class="box" aria-labelledby="admin-users-title">
    <header class="box-header">
      <h2 id="admin-users-title">{{ t("adminUsers") }}</h2>
    </header>
    <form class="box-form admin-search" @submit.prevent="load">
      <FluentField v-model="search" :label="t('adminSearchUsers')" type="search" />
      <FluentButton type="submit">{{ t("search") }}</FluentButton>
    </form>
    <div v-if="reauth.pending.value" class="box-form">
      <ReauthPrompt @confirmed="reauth.confirmed" />
    </div>
    <div v-if="actionError" class="box-form">
      <NoticeBar intent="error">{{ actionError }}</NoticeBar>
    </div>
    <div v-if="notice" class="box-form">
      <NoticeBar intent="warning">{{ notice }}</NoticeBar>
    </div>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!users.length" class="settings-empty">{{ t("adminNoUsers") }}</p>
      <ul v-else class="settings-list">
        <li v-for="user in users" :key="user.id" class="box-row settings-item">
          <div class="settings-item-copy">
            <div class="row-title">
              {{ user.identifier }}
              <StatusBadge v-if="user.deletedAt" tone="neutral">{{
                t("adminDeleted")
              }}</StatusBadge>
              <StatusBadge v-else-if="user.disabledAt" tone="danger">{{
                t("adminDisabled")
              }}</StatusBadge>
              <StatusBadge v-if="administrator(user)" tone="brand">{{
                t("adminSiteAdmin")
              }}</StatusBadge>
            </div>
            <div class="row-meta">
              <span>{{ t("adminJoined", { date: d(user.createdAt, "short") }) }}</span>
            </div>
          </div>
          <div v-if="!user.deletedAt" class="settings-actions">
            <SelectField
              :model-value="user.groupKey"
              :label="t('adminGroup')"
              :disabled="Boolean(busyId)"
              @update:model-value="setGroup(user, $event)"
            >
              <option v-for="group in groups" :key="group.key" :value="group.key">
                {{ group.key }}
              </option>
            </SelectField>
            <ConfirmButton
              v-if="!user.configuredAdmin && user.id !== self"
              size="small"
              tone="secondary"
              :label="user.siteAdmin ? t('adminRevokeAdmin') : t('adminGrantAdmin')"
              :accessible-name="`${user.siteAdmin ? t('adminRevokeAdmin') : t('adminGrantAdmin')} · ${user.identifier}`"
              :prompt="t('adminAdminPrompt')"
              :disabled="Boolean(busyId)"
              @confirm="setSiteAdmin(user, !user.siteAdmin)"
            />
            <ConfirmButton
              v-if="user.id !== self && (user.disabledAt || !administrator(user))"
              size="small"
              :tone="user.disabledAt ? 'secondary' : 'danger'"
              :label="user.disabledAt ? t('adminEnable') : t('adminDisable')"
              :accessible-name="`${user.disabledAt ? t('adminEnable') : t('adminDisable')} · ${user.identifier}`"
              :prompt="user.disabledAt ? t('adminEnablePrompt') : t('adminDisablePrompt')"
              :disabled="Boolean(busyId)"
              @confirm="setDisabled(user, !user.disabledAt)"
            />
          </div>
        </li>
      </ul>
      <div v-if="nextCursor" class="box-form">
        <FluentButton type="button" :busy="loadingMore" @click="more">{{
          t("auditLoadMore")
        }}</FluentButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-search {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-3);
  align-items: end;
}
</style>
