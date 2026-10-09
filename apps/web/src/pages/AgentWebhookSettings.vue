<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { ApiError, api, errorMessage } from "../lib/api";
import {
  AgentDeliveryModeSchema,
  AgentWebhookEventSchema,
  type AgentDeliveryMode,
  type AgentWebhookDelivery,
  type AgentWebhookEvent,
  type AgentWebhookSettings,
} from "../../../../packages/contracts/src/agents";
import type { AgentFeedStatus } from "../../../../packages/contracts/src/agent-events";
import SelectField from "../components/SelectField.vue";
import { oneOf } from "../ui/formEvents";
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
const eventOptions = AgentWebhookEventSchema.options;
const deliveryModes = AgentDeliveryModeSchema.options;
const deliveryMode = ref<AgentDeliveryMode>("webhook");
const feedStatus = ref<AgentFeedStatus | null>(null);
const feedError = ref("");
const deliverySaving = ref(false);
const deliveryNotice = ref("");
const eventLabels: Record<AgentWebhookEvent, string> = {
  "agent.assigned": "agentWebhookAssigned",
  "agent.mentioned": "agentWebhookMentioned",
  "pull_request.updated": "agentWebhookPullUpdated",
  "review.requested": "agentWebhookReviewRequested",
  "review.submitted": "agentWebhookReviewSubmitted",
  "check.completed": "agentWebhookCheckCompleted",
  "comment.created": "agentWebhookCommentCreated",
};
function toggleEvent(event: AgentWebhookEvent, checked: unknown) {
  if (typeof checked !== "boolean") return;
  settings.value.events = checked
    ? [...new Set([...settings.value.events, event])]
    : settings.value.events.filter((item) => item !== event);
}
function eventLabel(event: AgentWebhookEvent) {
  return t(eventLabels[event]);
}
async function loadDelivery(version: number) {
  feedError.value = "";
  try {
    const [agent, status] = await Promise.all([
      api.agent(agentId.value),
      api.agentFeedStatus(agentId.value),
    ]);
    if (version !== loadVersion) return;
    deliveryMode.value = agent.deliveryMode;
    feedStatus.value = status;
  } catch {
    if (version === loadVersion) feedError.value = t("agentFeedLoadError");
  }
}
async function saveDelivery() {
  deliverySaving.value = true;
  deliveryNotice.value = "";
  error.value = "";
  try {
    await api.updateAgent(agentId.value, { deliveryMode: deliveryMode.value });
    deliveryNotice.value = t("agentDeliverySaved");
    await loadDelivery(loadVersion);
  } catch (cause) {
    error.value = errorMessage(cause, t);
  } finally {
    deliverySaving.value = false;
  }
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
    await loadDelivery(version);
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
          <h2>{{ t("agentDelivery") }}</h2>
          <p>{{ t("agentDeliveryDescription") }}</p>
        </div>
      </header>
      <div v-if="loading || loadError" class="box">
        <StatusState :loading="loading" :error="loadError" :empty="false" @retry="load" />
      </div>
      <template v-else>
        <form
          class="box box-form form-stack"
          aria-labelledby="agent-delivery-title"
          @submit.prevent="saveDelivery"
        >
          <h3 id="agent-delivery-title">{{ t("agentDelivery") }}</h3>
          <p class="field-hint">{{ t("agentDeliveryDescription") }}</p>
          <SelectField
            :model-value="deliveryMode"
            :label="t('agentDeliveryMode')"
            @update:model-value="deliveryMode = oneOf(deliveryModes, $event, 'webhook')"
          >
            <option v-for="mode in deliveryModes" :key="mode" :value="mode">
              {{ t(`agentDeliveryMode_${mode}`) }}
            </option>
          </SelectField>
          <p v-if="deliveryMode !== 'webhook'" class="field-hint">
            {{ t("agentDeliveryPullHint") }}
          </p>
          <NoticeBar v-if="feedError" intent="warning">{{ feedError }}</NoticeBar>
          <dl v-else-if="feedStatus" class="feed-status" :aria-label="t('agentFeedStatus')">
            <div>
              <dt>{{ t("agentFeedLastPoll") }}</dt>
              <dd>
                {{
                  feedStatus.lastPolledAt
                    ? d(feedStatus.lastPolledAt, "long")
                    : t("agentFeedNeverPolled")
                }}
              </dd>
            </div>
            <div>
              <dt>{{ t("agentFeedLatestCursor") }}</dt>
              <dd>{{ feedStatus.latestCursor ?? "-" }}</dd>
            </div>
            <div>
              <dt>{{ t("agentFeedRetained") }}</dt>
              <dd>{{ feedStatus.retained }}</dd>
            </div>
          </dl>
          <p v-if="feedStatus" class="field-hint">
            {{
              t("agentFeedRetention", { days: feedStatus.retentionDays, max: feedStatus.maxEvents })
            }}
          </p>
          <NoticeBar v-if="deliveryNotice" intent="success">{{ deliveryNotice }}</NoticeBar>
          <div class="form-actions">
            <FluentButton type="submit" tone="primary" :disabled="deliverySaving">{{
              t("save")
            }}</FluentButton>
          </div>
        </form>
        <form class="box box-form form-stack" @submit.prevent="save()">
          <h3>{{ t("agentWebhook") }}</h3>
          <p class="field-hint">{{ t("agentWebhookDescription") }}</p>
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
.feed-status {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-3);
  margin: 0;
}
.feed-status dt {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.feed-status dd {
  margin: 0;
  font-weight: var(--font-weight-semibold);
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
