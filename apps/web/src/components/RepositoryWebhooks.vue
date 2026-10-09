<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FluentButton, FluentCheckbox, FluentField, FluentSwitch } from "@platform-kit/fluent/vue";
import {
  RepositoryWebhookEvents,
  type RepositoryWebhook,
  type RepositoryWebhookDelivery,
  type RepositoryWebhookEvent,
} from "../../../../packages/contracts/src/webhooks";
import { api, errorMessage } from "../lib/api";
import { useReauthRetry } from "../lib/reauth";
import ConfirmButton from "./ConfirmButton.vue";
import NoticeBar from "./NoticeBar.vue";
import ReauthPrompt from "./ReauthPrompt.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repositoryId: string; canManage: boolean }>();
const { t, d } = useI18n();
const reauth = useReauthRetry();
const hooks = ref<RepositoryWebhook[]>([]);
const loading = ref(true);
const error = ref("");
const saveError = ref("");
const notice = ref("");
const saving = ref(false);
const busyId = ref("");
const editingId = ref<string | null>(null);
const url = ref("");
const secret = ref("");
const rotateSecret = ref(false);
const events = ref<ReadonlySet<RepositoryWebhookEvent>>(new Set(["push"]));
const active = ref(true);
const revealedSecret = ref("");
const openDeliveries = ref<string | null>(null);
const deliveries = ref<RepositoryWebhookDelivery[]>([]);
const deliveriesError = ref("");
const deliveriesLoading = ref(false);
const detailId = ref<string | null>(null);
const detailPayload = ref("");
let loadVersion = 0;

const canSave = computed(
  () => props.canManage && !saving.value && url.value.trim() !== "" && events.value.size > 0
);

function resetForm(): void {
  editingId.value = null;
  url.value = "";
  secret.value = "";
  rotateSecret.value = false;
  events.value = new Set(["push"]);
  active.value = true;
}

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.repositoryWebhooks(props.repositoryId);
    if (version === loadVersion) hooks.value = result;
  } catch {
    if (version === loadVersion) error.value = t("webhooksLoadError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

function edit(hook: RepositoryWebhook): void {
  editingId.value = hook.id;
  url.value = hook.url;
  secret.value = "";
  rotateSecret.value = false;
  events.value = new Set(hook.events);
  active.value = hook.active;
  saveError.value = "";
  notice.value = "";
}

function toggleEvent(event: RepositoryWebhookEvent, enabled: boolean): void {
  const next = new Set(events.value);
  if (enabled) next.add(event);
  else next.delete(event);
  events.value = next;
}

async function save(): Promise<void> {
  if (!canSave.value) return;
  saving.value = true;
  saveError.value = "";
  notice.value = "";
  revealedSecret.value = "";
  const eventList = RepositoryWebhookEvents.filter((event) => events.value.has(event));
  try {
    const saved = editingId.value
      ? await api.updateRepositoryWebhook(props.repositoryId, editingId.value, {
          url: url.value.trim(),
          events: eventList,
          active: active.value,
          ...(secret.value ? { secret: secret.value } : {}),
          ...(rotateSecret.value && !secret.value ? { rotateSecret: true } : {}),
        })
      : await api.createRepositoryWebhook(props.repositoryId, {
          url: url.value.trim(),
          contentType: "json",
          events: eventList,
          active: active.value,
          ...(secret.value ? { secret: secret.value } : {}),
        });
    const { secret: generated, ...hook } = saved;
    hooks.value = editingId.value
      ? hooks.value.map((item) => (item.id === hook.id ? hook : item))
      : [...hooks.value, hook];
    revealedSecret.value = generated ?? "";
    resetForm();
    notice.value = t("webhookSaved");
  } catch (cause) {
    if (reauth.intercept(cause, save)) return;
    saveError.value = errorMessage(
      cause,
      t,
      { 400: "webhookInvalidUrl", 409: "webhookLimit", 503: "webhookUnavailable" },
      "webhookSaveError"
    );
  } finally {
    saving.value = false;
  }
}

async function remove(hook: RepositoryWebhook): Promise<void> {
  if (busyId.value) return;
  busyId.value = hook.id;
  saveError.value = "";
  notice.value = "";
  try {
    await api.deleteRepositoryWebhook(props.repositoryId, hook.id);
    hooks.value = hooks.value.filter((item) => item.id !== hook.id);
    if (editingId.value === hook.id) resetForm();
    if (openDeliveries.value === hook.id) openDeliveries.value = null;
    notice.value = t("webhookDeleted");
  } catch (cause) {
    if (reauth.intercept(cause, () => remove(hook))) return;
    saveError.value = errorMessage(cause, t);
  } finally {
    busyId.value = "";
  }
}

async function loadDeliveries(hook: RepositoryWebhook): Promise<void> {
  deliveriesLoading.value = true;
  deliveriesError.value = "";
  detailId.value = null;
  try {
    deliveries.value = await api.repositoryWebhookDeliveries(props.repositoryId, hook.id);
  } catch {
    deliveriesError.value = t("webhookDeliveriesLoadError");
  } finally {
    deliveriesLoading.value = false;
  }
}

async function toggleDeliveries(hook: RepositoryWebhook): Promise<void> {
  if (openDeliveries.value === hook.id) {
    openDeliveries.value = null;
    return;
  }
  openDeliveries.value = hook.id;
  await loadDeliveries(hook);
}

async function ping(hook: RepositoryWebhook): Promise<void> {
  if (busyId.value) return;
  busyId.value = hook.id;
  saveError.value = "";
  notice.value = "";
  try {
    const delivery = await api.pingRepositoryWebhook(props.repositoryId, hook.id);
    notice.value = t(delivery.status === "success" ? "webhookPingSucceeded" : "webhookPingFailed");
  } catch {
    saveError.value = t("webhookPingFailed");
  } finally {
    busyId.value = "";
    if (openDeliveries.value === hook.id) await loadDeliveries(hook);
  }
}

async function redeliver(hook: RepositoryWebhook, delivery: RepositoryWebhookDelivery) {
  if (busyId.value) return;
  busyId.value = delivery.id;
  deliveriesError.value = "";
  try {
    await api.redeliverRepositoryWebhook(props.repositoryId, hook.id, delivery.id);
  } catch {
    deliveriesError.value = t("webhookRedeliverError");
  } finally {
    busyId.value = "";
    await loadDeliveries(hook);
  }
}

async function toggleDetail(hook: RepositoryWebhook, delivery: RepositoryWebhookDelivery) {
  if (detailId.value === delivery.id) {
    detailId.value = null;
    return;
  }
  try {
    const detail = await api.repositoryWebhookDelivery(props.repositoryId, hook.id, delivery.id);
    detailPayload.value = JSON.stringify(detail.payload, null, 2);
    detailId.value = delivery.id;
  } catch {
    deliveriesError.value = t("webhookDeliveriesLoadError");
  }
}

function statusTone(delivery: RepositoryWebhookDelivery): "success" | "danger" | "neutral" {
  if (delivery.status === "success") return "success";
  return delivery.status === "failed" ? "danger" : "neutral";
}

watch(
  () => props.repositoryId,
  () => {
    resetForm();
    openDeliveries.value = null;
    revealedSecret.value = "";
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="box" aria-labelledby="webhooks-title">
    <header class="box-header">
      <h3 id="webhooks-title">{{ t("repoSettingsWebhooks") }}</h3>
    </header>
    <p class="box-row field-hint">{{ t("webhooksIntro") }}</p>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else>
      <p v-if="!hooks.length" class="settings-empty">{{ t("webhooksEmpty") }}</p>
      <ul v-else class="settings-list">
        <li v-for="hook in hooks" :key="hook.id" class="box-row webhook-item">
          <div class="settings-item">
            <div class="settings-item-copy">
              <div class="row-title">
                {{ hook.url }}
                <StatusBadge :tone="hook.active ? 'success' : 'neutral'">{{
                  hook.active ? t("webhookActive") : t("webhookInactive")
                }}</StatusBadge>
              </div>
              <small>{{ hook.events.join(" · ") }}</small>
            </div>
            <div class="settings-actions">
              <FluentButton
                type="button"
                :disabled="Boolean(busyId)"
                :busy="busyId === hook.id"
                @click="ping(hook)"
                >{{ t("webhookPing") }}</FluentButton
              >
              <FluentButton type="button" @click="toggleDeliveries(hook)">{{
                openDeliveries === hook.id ? t("webhookHideDeliveries") : t("webhookDeliveries")
              }}</FluentButton>
              <FluentButton
                type="button"
                :disabled="!canManage || saving || Boolean(busyId)"
                @click="edit(hook)"
                >{{ t("webhookEdit") }}</FluentButton
              >
              <ConfirmButton
                tone="secondary"
                :label="t('webhookDelete')"
                :prompt="t('webhookDeleteConfirm')"
                :disabled="!canManage || saving || Boolean(busyId)"
                @confirm="remove(hook)"
              />
            </div>
          </div>
          <div v-if="openDeliveries === hook.id" class="webhook-deliveries">
            <StatusState
              v-if="deliveriesLoading || deliveriesError"
              :loading="deliveriesLoading"
              :error="deliveriesError"
              @retry="loadDeliveries(hook)"
            />
            <p v-else-if="!deliveries.length" class="muted">{{ t("webhookDeliveriesEmpty") }}</p>
            <ul v-else class="settings-list">
              <li v-for="delivery in deliveries" :key="delivery.id" class="webhook-delivery">
                <div class="settings-item-copy">
                  <div class="row-title">
                    <StatusBadge :tone="statusTone(delivery)">{{
                      t(`webhookStatus_${delivery.status}`)
                    }}</StatusBadge>
                    {{ t(`webhookEvent_${delivery.event}`)
                    }}<template v-if="delivery.action"> · {{ delivery.action }}</template>
                  </div>
                  <small>
                    {{ d(delivery.createdAt, "long") }} ·
                    {{ t("webhookAttempts", { count: delivery.attemptCount }) }}
                    <template v-if="delivery.responseStatus !== null">
                      · {{ t("webhookResponse", { status: delivery.responseStatus }) }}</template
                    >
                    <template v-if="delivery.errorCode"> · {{ delivery.errorCode }}</template>
                    <template v-if="delivery.nextAttemptAt !== null">
                      · {{ t("webhookNextAttempt", { time: d(delivery.nextAttemptAt, "long") }) }}
                    </template>
                  </small>
                </div>
                <div class="settings-actions">
                  <FluentButton size="small" type="button" @click="toggleDetail(hook, delivery)">{{
                    detailId === delivery.id ? t("webhookHideDetails") : t("webhookDetails")
                  }}</FluentButton>
                  <FluentButton
                    v-if="delivery.status !== 'pending'"
                    size="small"
                    type="button"
                    :disabled="!canManage || Boolean(busyId)"
                    :busy="busyId === delivery.id"
                    @click="redeliver(hook, delivery)"
                    >{{ t("webhookRedeliver") }}</FluentButton
                  >
                </div>
                <pre v-if="detailId === delivery.id" class="settings-code">{{ detailPayload }}</pre>
              </li>
            </ul>
          </div>
        </li>
      </ul>

      <div v-if="reauth.pending.value" class="box-form">
        <ReauthPrompt @confirmed="reauth.confirmed" />
      </div>
      <form class="box-form form-stack webhook-form" @submit.prevent="save">
        <h4>{{ t(editingId ? "webhookUpdate" : "webhookCreate") }}</h4>
        <FluentField
          v-model="url"
          type="url"
          :label="t('webhookUrl')"
          :disabled="!canManage || saving"
        />
        <p class="field-hint">{{ t("webhookUrlHint") }}</p>
        <p class="field-hint">{{ t("webhookContentType") }}: application/json</p>
        <FluentField
          v-model="secret"
          type="password"
          autocomplete="off"
          :label="t('webhookSecret')"
          :disabled="!canManage || saving"
        />
        <p class="field-hint">{{ t("webhookSecretHint") }}</p>
        <FluentSwitch
          v-if="editingId"
          v-model="rotateSecret"
          :label="t('webhookRotateSecret')"
          :disabled="!canManage || saving"
        />
        <fieldset class="webhook-events">
          <legend>{{ t("webhookEvents") }}</legend>
          <FluentCheckbox
            v-for="event in RepositoryWebhookEvents"
            :key="event"
            :model-value="events.has(event)"
            :label="t(`webhookEvent_${event}`)"
            :disabled="!canManage || saving"
            @update:model-value="toggleEvent(event, $event)"
          />
        </fieldset>
        <FluentSwitch
          v-model="active"
          :label="t('webhookActive')"
          :disabled="!canManage || saving"
        />
        <NoticeBar v-if="saveError" intent="error">{{ saveError }}</NoticeBar>
        <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
        <NoticeBar v-if="revealedSecret" intent="warning">
          {{ t("webhookSecretOnce") }} <code>{{ revealedSecret }}</code>
        </NoticeBar>
        <div class="form-actions">
          <FluentButton type="submit" tone="primary" :busy="saving" :disabled="!canSave">{{
            t(editingId ? "webhookUpdate" : "webhookCreate")
          }}</FluentButton>
          <FluentButton v-if="editingId" type="button" :disabled="saving" @click="resetForm">{{
            t("webhookCancelEdit")
          }}</FluentButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.webhook-item {
  display: grid;
  gap: var(--space-3);
}
.webhook-deliveries {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-muted);
}
.webhook-delivery {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-block: var(--space-2);
}
.webhook-delivery .settings-code {
  flex: 1 1 100%;
}
.webhook-form {
  border-top: 1px solid var(--border-muted);
}
.webhook-events {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}
</style>
