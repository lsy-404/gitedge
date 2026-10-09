<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton } from "@platform-kit/fluent/vue";
import type { AuditEvent, AuditPage } from "../lib/api";
import { errorMessage } from "../lib/api";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ load: (cursor?: string) => Promise<AuditPage>; reloadKey?: string }>();
const { t, te, d } = useI18n();
const events = ref<AuditEvent[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
let version = 0;

function actionLabel(action: string): string {
  const key = `auditAction_${action.replace(".", "_")}`;
  return te(key) ? t(key) : action;
}

function details(event: AuditEvent): string {
  return Object.entries(event.metadata)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(" · ");
}

async function reload(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const page = await props.load();
    if (current !== version) return;
    events.value = page.events;
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

async function more(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  const current = version;
  loadingMore.value = true;
  try {
    const page = await props.load(nextCursor.value);
    if (current !== version) return;
    events.value = [...events.value, ...page.events];
    nextCursor.value = page.nextCursor;
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    loadingMore.value = false;
  }
}

watch(() => props.reloadKey, reload, { immediate: true });
</script>

<template>
  <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="reload" />
  <template v-else>
    <p v-if="!events.length" class="settings-empty">{{ t("auditEmpty") }}</p>
    <ul v-else class="settings-list audit-list">
      <li v-for="event in events" :key="event.id" class="box-row audit-row">
        <div class="settings-item-copy">
          <div class="row-title">
            {{ actionLabel(event.action) }}
            <StatusBadge v-if="event.actor.kind !== 'user'">{{
              t(`auditActor_${event.actor.kind}`)
            }}</StatusBadge>
          </div>
          <div class="row-meta">
            <span>{{ event.actor.name }}</span>
            <span v-if="event.target.label">{{ event.target.label }}</span>
            <span>{{ d(event.createdAt, "long") }}</span>
          </div>
          <small v-if="details(event)">{{ details(event) }}</small>
        </div>
      </li>
    </ul>
    <div v-if="nextCursor" class="box-form">
      <FluentButton type="button" :busy="loadingMore" @click="more">{{
        t("auditLoadMore")
      }}</FluentButton>
    </div>
  </template>
</template>
