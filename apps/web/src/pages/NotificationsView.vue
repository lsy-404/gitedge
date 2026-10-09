<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import {
  NotificationReasons,
  type Notification,
  type NotificationReason,
} from "../../../../packages/contracts/src/notifications";
import { api, errorMessage } from "../lib/api";
import { refreshUnreadCount } from "../lib/notifications";
import AppIcon from "../components/AppIcon.vue";
import NoticeBar from "../components/NoticeBar.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import { oneOf } from "../ui/formEvents";
import "../styles/workspace.css";

interface Group {
  key: string;
  repositoryId: string;
  title: string;
  items: Notification[];
}

const { t, d } = useI18n();
const items = ref<Notification[]>([]);
const nextCursor = ref<string | null>(null);
const unreadOnly = ref(false);
const reason = ref<NotificationReason | "all">("all");
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
const actionError = ref("");
let version = 0;

const reasonValues = ["all", ...NotificationReasons] as const;
const groups = computed<Group[]>(() => {
  const byRepository = new Map<string, Group>();
  for (const item of items.value) {
    const title = `${item.repository.owner}/${item.repository.name}`;
    const group = byRepository.get(item.repository.id) ?? {
      key: item.repository.id,
      repositoryId: item.repository.id,
      title,
      items: [],
    };
    group.items.push(item);
    byRepository.set(item.repository.id, group);
  }
  return [...byRepository.values()];
});
const hasUnread = computed(() => items.value.some((item) => item.readAt === null));

function filters(before?: string) {
  return {
    unread: unreadOnly.value,
    reason: reason.value === "all" ? undefined : reason.value,
    before,
  };
}

async function load(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const page = await api.notifications(filters());
    if (current !== version) return;
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t, {}, "notificationsLoadError");
  } finally {
    if (current === version) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  const current = version;
  loadingMore.value = true;
  actionError.value = "";
  try {
    const page = await api.notifications(filters(nextCursor.value));
    if (current !== version) return;
    items.value = [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    actionError.value = errorMessage(cause, t, {}, "notificationsLoadError");
  } finally {
    loadingMore.value = false;
  }
}

function setUnreadOnly(value: boolean): void {
  if (unreadOnly.value === value) return;
  unreadOnly.value = value;
  void load();
}

function setReason(value: string): void {
  reason.value = oneOf(reasonValues, value, "all");
  void load();
}

function applyRead(predicate: (item: Notification) => boolean): void {
  const readAt = Date.now();
  items.value = items.value.map((item) =>
    predicate(item) && item.readAt === null ? { ...item, readAt } : item
  );
}

async function markRead(item: Notification): Promise<void> {
  if (item.readAt !== null) return;
  actionError.value = "";
  try {
    await api.markNotificationsRead({ ids: [item.id] });
    applyRead((candidate) => candidate.id === item.id);
    void refreshUnreadCount();
  } catch (cause) {
    actionError.value = errorMessage(cause, t, {}, "notificationsMarkError");
  }
}

async function markScope(repositoryId?: string): Promise<void> {
  actionError.value = "";
  try {
    await api.markNotificationsRead(repositoryId ? { all: true, repositoryId } : { all: true });
    applyRead((item) => !repositoryId || item.repository.id === repositoryId);
    void refreshUnreadCount();
  } catch (cause) {
    actionError.value = errorMessage(cause, t, {}, "notificationsMarkError");
  }
}

function subjectPath(item: Notification): string {
  const base = `/${encodeURIComponent(item.repository.owner)}/${encodeURIComponent(item.repository.name)}`;
  if (item.subjectKind === "repository" || item.subjectNumber === null) return base;
  const section =
    item.subjectKind === "issue"
      ? "issues"
      : item.subjectKind === "pull_request"
        ? "pulls"
        : "discussions";
  return `${base}/${section}/${item.subjectNumber}`;
}

function subjectTitle(item: Notification): string {
  if (item.subjectKind === "repository") return t("notificationsInvited");
  return item.title ?? `${t(`notificationKind_${item.subjectKind}`)} #${item.subjectNumber}`;
}

onMounted(load);
</script>

<template>
  <section class="notifications-page">
    <header class="workspace-page-heading">
      <div>
        <h1>{{ t("notifications") }}</h1>
        <p class="muted">{{ t("notificationsHint") }}</p>
      </div>
      <FluentButton type="button" :disabled="!hasUnread" @click="markScope()">{{
        t("notificationsMarkAllRead")
      }}</FluentButton>
    </header>
    <div class="notifications-filters">
      <div class="notifications-tabs" role="group" :aria-label="t('notifications')">
        <FluentButton
          type="button"
          :aria-pressed="!unreadOnly"
          :tone="unreadOnly ? 'subtle' : 'secondary'"
          @click="setUnreadOnly(false)"
          >{{ t("notificationsFilterAll") }}</FluentButton
        >
        <FluentButton
          type="button"
          :aria-pressed="unreadOnly"
          :tone="unreadOnly ? 'secondary' : 'subtle'"
          @click="setUnreadOnly(true)"
          >{{ t("notificationsFilterUnread") }}</FluentButton
        >
      </div>
      <SelectField
        :model-value="reason"
        :label="t('notificationsFilterReason')"
        @update:model-value="setReason"
      >
        <option value="all">{{ t("notificationsAnyReason") }}</option>
        <option v-for="value in NotificationReasons" :key="value" :value="value">
          {{ t(`notificationReason_${value}`) }}
        </option>
      </SelectField>
    </div>
    <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
    <StatusState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      :empty="false"
      @retry="load"
    />
    <p v-else-if="!groups.length" class="settings-empty">
      {{ unreadOnly ? t("notificationsEmptyUnread") : t("notificationsEmpty") }}
    </p>
    <template v-else>
      <section v-for="group in groups" :key="group.key" class="box" :aria-label="group.title">
        <header class="box-header">
          <h2>{{ group.title }}</h2>
          <FluentButton
            size="small"
            type="button"
            tone="subtle"
            @click="markScope(group.repositoryId)"
            >{{ t("notificationsMarkRepositoryRead") }}</FluentButton
          >
        </header>
        <article
          v-for="item in group.items"
          :key="item.id"
          class="box-row notification-row"
          :class="{ 'notification-unread': item.readAt === null }"
        >
          <AppIcon
            :name="
              item.subjectKind === 'issue'
                ? 'issue'
                : item.subjectKind === 'pull_request'
                  ? 'pr'
                  : item.subjectKind === 'discussion'
                    ? 'discussion'
                    : 'repo'
            "
          />
          <div class="notification-copy">
            <RouterLink
              class="notification-title"
              :to="subjectPath(item)"
              @click="markRead(item)"
              >{{ subjectTitle(item) }}</RouterLink
            >
            <small class="muted">
              <StatusBadge>{{ t(`notificationReason_${item.reason}`) }}</StatusBadge>
              <span v-if="item.actor"> {{ t("notificationsActor", { actor: item.actor }) }}</span>
              · {{ d(item.createdAt, "long") }}
            </small>
          </div>
          <span
            v-if="item.readAt === null"
            class="notification-dot"
            :title="t('notificationsUnread')"
          >
            <span class="visually-hidden">{{ t("notificationsUnread") }}</span>
          </span>
          <FluentButton
            v-if="item.readAt === null"
            size="small"
            type="button"
            tone="subtle"
            @click="markRead(item)"
            >{{ t("notificationsMarkRead") }}</FluentButton
          >
        </article>
      </section>
      <div v-if="nextCursor" class="form-actions">
        <FluentButton type="button" :busy="loadingMore" @click="loadMore">{{
          t("notificationsLoadMore")
        }}</FluentButton>
      </div>
    </template>
  </section>
</template>

<style scoped>
.notifications-page {
  display: grid;
  gap: var(--space-4);
  width: min(960px, calc(100% - var(--page-gutter, var(--space-6)) * 2));
  margin: var(--space-6) auto 0;
}
.notifications-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
}
.notifications-tabs {
  display: flex;
  gap: var(--space-1);
}
.notification-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.notification-copy {
  display: grid;
  flex: 1 1 auto;
  gap: var(--space-1);
  min-width: 0;
}
.notification-title {
  overflow-wrap: anywhere;
}
.notification-unread .notification-title {
  font-weight: var(--font-weight-semibold);
}
.notification-dot {
  width: var(--space-2);
  height: var(--space-2);
  border-radius: var(--radius-full);
  background: var(--accent-strong);
}
</style>
