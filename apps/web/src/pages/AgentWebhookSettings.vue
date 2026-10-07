<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { ApiError, api, errorMessage } from "../lib/api";
import type {
  AgentWebhookDelivery,
  AgentWebhookEvent,
  AgentWebhookSettings,
} from "../../../../packages/contracts/src/agents";
import AppIcon from "../components/AppIcon.vue";
import NoticeBar from "../components/NoticeBar.vue";
import SettingsSidebar from "../components/SettingsSidebar.vue";
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";
import "../styles/settings.css";

const { t, d } = useI18n();
const route = useRoute();
const agentId = computed(() => String(route.params.id ?? ""));
const emptySettings = (): AgentWebhookSettings => ({ url: "", events: [], enabled: false });
const settings = ref<AgentWebhookSettings>(emptySettings());
const deliveries = ref<AgentWebhookDelivery[]>([]);
const secret = ref("");
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const retryingId = ref<string | null>(null);
let loadVersion = 0;
const error = ref("");
const loadError = ref("");
const notice = ref("");
const eventOptions: AgentWebhookEvent[] = [
  "agent.assigned",
  "agent.mentioned",
  "pull_request.updated",
];
function toggleEvent(event: AgentWebhookEvent, checked: unknown) {
  if (typeof checked !== "boolean") return;
  settings.value.events = checked
    ? [...new Set([...settings.value.events, event])]
    : settings.value.events.filter((item) => item !== event);
}
function eventLabel(event: AgentWebhookEvent) {
  return t(
    event === "agent.assigned"
      ? "agentWebhookAssigned"
      : event === "agent.mentioned"
        ? "agentWebhookMentioned"
        : "agentWebhookPullUpdated"
  );
}
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  loadError.value = "";
  try {
    const [saved, rows] = await Promise.all([
      api.agentWebhook(agentId.value),
      api.agentWebhookDeliveries(agentId.value),
    ]);
    if (version !== loadVersion) return;
    settings.value = saved
      ? { url: saved.url, events: saved.events, enabled: saved.enabled }
      : emptySettings();
    deliveries.value = rows;
  } catch (cause) {
    if (version !== loadVersion) return;
    loadError.value = errorMessage(cause, t);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
async function loadDeliveries() {
  const id = agentId.value;
  const version = loadVersion;
  try {
    const rows = await api.agentWebhookDeliveries(id);
    if (id === agentId.value && version === loadVersion) deliveries.value = rows;
  } catch (cause) {
    if (id === agentId.value && version === loadVersion) error.value = errorMessage(cause, t);
  }
}
async function save(rotateSecret = false) {
  saving.value = true;
  error.value = "";
  notice.value = "";
  secret.value = "";
  try {
    const result = await api.saveAgentWebhook(agentId.value, settings.value, rotateSecret);
    if (result.secret) secret.value = result.secret;
    notice.value = t("agentWebhookSaveSuccess");
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.status === 400
        ? t("agentWebhookHttpsOnly")
        : t("apiError");
  } finally {
    saving.value = false;
  }
}
async function test() {
  testing.value = true;
  error.value = "";
  notice.value = "";
  try {
    await api.testAgentWebhook(agentId.value);
    notice.value = t("agentWebhookTestSent");
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    testing.value = false;
  }
  await loadDeliveries();
}
async function retry(delivery: AgentWebhookDelivery) {
  retryingId.value = delivery.id;
  error.value = "";
  notice.value = "";
  try {
    await api.retryAgentWebhookDelivery(agentId.value, delivery.id);
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    retryingId.value = null;
  }
  await loadDeliveries();
}
watch(agentId, () => void load(), { immediate: true });
</script>

<template>
  <section class="settings-page">
    <SettingsSidebar active="agents" />
    <div class="settings-content">
      <RouterLink class="settings-back" to="/settings/agents"
        ><AppIcon name="arrowLeft" />{{ t("agents") }}</RouterLink
      >
      <header class="settings-header">
        <div>
          <h2>{{ t("agentWebhook") }}</h2>
          <p>{{ t("agentWebhookDescription") }}</p>
        </div>
      </header>
      <div v-if="loading || loadError" class="box">
        <StatusState :loading="loading" :error="loadError" :empty="false" @retry="load" />
      </div>
      <template v-else>
        <form class="box box-form form-stack" @submit.prevent="save()">
          <TextField
            v-model="settings.url"
            type="url"
            required
            autocomplete="url"
            :hint="t('agentWebhookHttpsOnly')"
            >{{ t("agentWebhookUrl") }}</TextField
          >
          <fieldset class="event-list">
            <legend>{{ t("agentWebhookEvents") }}</legend>
            <label v-for="event in eventOptions" :key="event" class="event-choice">
              <FluentCheckbox
                :model-value="settings.events.includes(event)"
                @update:model-value="toggleEvent(event, $event)"
                >{{ eventLabel(event) }}</FluentCheckbox
              ><code>{{ event }}</code>
            </label>
          </fieldset>
          <FluentCheckbox v-model="settings.enabled">{{ t("agentWebhookEnabled") }}</FluentCheckbox>
          <div v-if="secret" class="secret-card">
            <strong>{{ t("agentWebhookSecret") }}</strong
            ><code>{{ secret }}</code>
          </div>
          <NoticeBar v-if="notice" intent="success">{{ notice }}</NoticeBar>
          <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
          <div class="form-actions">
            <FluentButton
              type="button"
              :disabled="saving || testing || !settings.enabled"
              @click="test"
              >{{ t("agentWebhookTest") }}</FluentButton
            >
            <FluentButton type="button" :disabled="saving" @click="save(true)">{{
              t("agentWebhookRotate")
            }}</FluentButton>
            <FluentButton type="submit" tone="primary" :disabled="saving">{{
              t("agentWebhookSave")
            }}</FluentButton>
          </div>
        </form>
        <section class="box" aria-labelledby="webhook-deliveries-title">
          <header class="box-header">
            <h3 id="webhook-deliveries-title">{{ t("agentWebhookDeliveries") }}</h3>
            <small class="box-header-end muted">{{ t("agentWebhookTruncated") }}</small>
          </header>
          <div v-for="delivery in deliveries" :key="delivery.id" class="box-row settings-item">
            <div class="settings-item-copy">
              <strong>{{ eventLabel(delivery.event) }}</strong>
              <div class="row-meta">
                <code>{{ delivery.id }}</code
                ><span>{{ delivery.status }}</span
                ><span v-if="delivery.responseStatus">HTTP {{ delivery.responseStatus }}</span
                ><span v-if="delivery.errorCode">{{ delivery.errorCode }}</span
                ><span>{{ d(delivery.createdAt, "long") }}</span>
              </div>
            </div>
            <button
              v-if="delivery.status === 'failed'"
              class="btn btn-sm"
              type="button"
              :disabled="retryingId !== null"
              @click="retry(delivery)"
            >
              {{ t("agentWebhookRetry") }}
            </button>
          </div>
          <p v-if="!deliveries.length" class="settings-empty">{{ t("agentWebhookEmpty") }}</p>
        </section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.event-list {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.event-list legend {
  padding-inline: var(--space-1);
  font-weight: var(--font-weight-semibold);
}
.event-choice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.event-choice code {
  margin-left: auto;
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.secret-card {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}
.secret-card code {
  overflow-wrap: anywhere;
}
</style>
