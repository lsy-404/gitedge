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
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";

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
  <section class="workspace-page settings-page">
    <section class="settings-content">
      <RouterLink to="/settings/agents"><AppIcon name="arrowLeft" />{{ t("agents") }}</RouterLink>
      <h1>{{ t("agentWebhook") }}</h1>
      <p class="muted">{{ t("agentWebhookDescription") }}</p>
      <StatusState
        v-if="loading || loadError"
        :loading="loading"
        :error="loadError"
        :empty="false"
        @retry="load"
      />
      <template v-else>
        <form class="settings-card form-stack" @submit.prevent="save()">
          <TextField v-model="settings.url" type="url" required autocomplete="url">{{
            t("agentWebhookUrl")
          }}</TextField>
          <p class="muted">{{ t("agentWebhookHttpsOnly") }}</p>
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
          <div class="form-actions">
            <FluentButton type="submit" tone="primary" :disabled="saving">{{
              t("agentWebhookSave")
            }}</FluentButton>
            <FluentButton type="button" :disabled="saving" @click="save(true)">{{
              t("agentWebhookRotate")
            }}</FluentButton>
            <FluentButton
              type="button"
              :disabled="saving || testing || !settings.enabled"
              @click="test"
              >{{ t("agentWebhookTest") }}</FluentButton
            >
          </div>
          <div v-if="secret" class="secret-card">
            <strong>{{ t("agentWebhookSecret") }}</strong
            ><code>{{ secret }}</code>
          </div>
          <p v-if="notice" role="status" class="muted">{{ notice }}</p>
          <p v-if="error" role="alert" class="workspace-form-error">{{ error }}</p>
        </form>
        <section class="settings-section">
          <div class="agent-section-heading">
            <h2>{{ t("agentWebhookDeliveries") }}</h2>
            <small>{{ t("agentWebhookTruncated") }}</small>
          </div>
          <div class="settings-card">
            <div
              v-for="delivery in deliveries"
              :key="delivery.id"
              class="settings-card-row delivery-row"
            >
              <div class="grow">
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
            <div v-if="!deliveries.length" class="settings-empty-state">
              {{ t("agentWebhookEmpty") }}
            </div>
          </div>
        </section>
      </template>
    </section>
  </section>
</template>

<style scoped>
.settings-content {
  width: min(960px, 100%);
  margin-inline: auto;
}
.event-list {
  display: grid;
  gap: var(--spacingVerticalS);
  border: 1px solid var(--colorNeutralStroke2);
  border-radius: var(--borderRadiusMedium);
  padding: var(--spacingVerticalM);
}
.event-list legend {
  padding-inline: var(--spacingHorizontalXS);
}
.event-choice {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalS);
}
.event-choice code {
  margin-left: auto;
  color: var(--colorNeutralForeground3);
}
.delivery-row {
  align-items: center;
}
.secret-card {
  display: grid;
  gap: var(--spacingVerticalS);
  padding: var(--spacingVerticalM);
  background: var(--colorNeutralBackground3);
  border-radius: var(--borderRadiusMedium);
}
.secret-card code {
  overflow-wrap: anywhere;
}
</style>
