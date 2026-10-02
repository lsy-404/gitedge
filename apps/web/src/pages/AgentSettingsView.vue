<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  api,
  type Agent,
  type AgentSession,
  type CreatedAgentSession,
  type Repository,
} from "../lib/api";
import { Dialog } from "@fluentui/web-components/dialog/class.js";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import { agentSessionDisplayStatus } from "../lib/gitGraphView";
import { clearAgentSessionSecrets, isCredentialExpired } from "../lib/credentialSecurity";
import { oneOf } from "../ui/formEvents";
import TextField from "../components/TextField.vue";

const permissions = ["read", "write"] as const;
const { t } = useI18n();
const credentialDialog = ref<HTMLElement | null>(null);
const agents = ref<Agent[]>([]);
const repositories = ref<Repository[]>([]);
const sessions = ref<AgentSession[]>([]);
const selectedAgent = ref("");
const loading = ref(false);
const sessionsError = ref("");
const sessionsLoading = ref(false);
const sessionsRequestVersion = ref(0);
const sessionNow = ref(Date.now());
const credentialsExpired = ref(false);
let credentialExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let createSessionVersion = 0;
let sessionClockTimer: ReturnType<typeof setInterval> | undefined;
const saving = ref(false);
const error = ref("");
const createdSession = ref<CreatedAgentSession | null>(null);
const agentForm = ref({ name: "", description: "" });
const sessionForm = ref<{
  repositoryId: string;
  baseRef: string;
  permission: "read" | "write";
  ttlSeconds: number;
}>({ repositoryId: "", baseRef: "main", permission: "write", ttlSeconds: 3600 });
const currentAgent = computed(
  () => agents.value.find((agent) => agent.id === selectedAgent.value) ?? null
);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [agentList, repoList] = await Promise.all([api.agents(), api.repositories()]);
    agents.value = agentList;
    repositories.value = repoList;
    if (!selectedAgent.value && agentList[0]) selectedAgent.value = agentList[0].id;
    else await loadSessions();
  } catch (cause) {
    error.value =
      cause instanceof ApiError && cause.status === 404 ? t("agentsUnavailable") : t("apiError");
  } finally {
    loading.value = false;
  }
}
async function loadSessions() {
  const requestVersion = sessionsRequestVersion.value + 1;
  sessionsRequestVersion.value = requestVersion;
  const agentId = selectedAgent.value;
  sessionsError.value = "";
  if (!agentId) {
    sessions.value = [];
    sessionsLoading.value = false;
    return;
  }
  sessions.value = [];
  sessionsLoading.value = true;
  try {
    const result = await api.agentSessions(agentId);
    if (requestVersion === sessionsRequestVersion.value && agentId === selectedAgent.value) {
      sessions.value = result;
    }
  } catch {
    if (requestVersion === sessionsRequestVersion.value && agentId === selectedAgent.value) {
      sessionsError.value = t("apiError");
    }
  } finally {
    if (requestVersion === sessionsRequestVersion.value && agentId === selectedAgent.value) {
      sessionsLoading.value = false;
    }
  }
}
function sessionStatus(session: AgentSession): string {
  return t(agentSessionDisplayStatus(session, sessionNow.value));
}
function sessionExpired(session: AgentSession): boolean {
  return agentSessionDisplayStatus(session, sessionNow.value) === "expired";
}
function showCreatedCredentials(session: CreatedAgentSession): void {
  clearTimeout(credentialExpiryTimer);
  credentialsExpired.value = isCredentialExpired(session.expiresAt, Date.now());
  createdSession.value = credentialsExpired.value ? clearAgentSessionSecrets(session) : session;
  if (!credentialsExpired.value) {
    credentialExpiryTimer = setTimeout(
      () => {
        const current = createdSession.value;
        if (!current || current.id !== session.id) return;
        createdSession.value = clearAgentSessionSecrets(current);
        credentialsExpired.value = true;
      },
      Math.max(0, session.expiresAt - Date.now())
    );
  }
}
async function createAgent() {
  saving.value = true;
  error.value = "";
  try {
    const agent = await api.createAgent(agentForm.value);
    agents.value = [agent, ...agents.value];
    selectedAgent.value = agent.id;
    agentForm.value = { name: "", description: "" };
  } catch {
    error.value = t("apiError");
  } finally {
    saving.value = false;
  }
}
async function disableAgent(agent: Agent) {
  try {
    await api.disableAgent(agent.id);
    agents.value = agents.value.map((row) =>
      row.id === agent.id ? { ...row, disabledAt: Date.now() } : row
    );
  } catch {
    error.value = t("apiError");
  }
}
async function createSession() {
  if (!selectedAgent.value) return;
  saving.value = true;
  error.value = "";
  const agentId = selectedAgent.value;
  const requestVersion = ++createSessionVersion;
  try {
    const session = await api.createAgentSession(agentId, sessionForm.value);
    if (requestVersion !== createSessionVersion || agentId !== selectedAgent.value) {
      await api.revokeAgentSession(agentId, session.id);
      return;
    }
    showCreatedCredentials(session);
    sessions.value = [session, ...sessions.value];
  } catch {
    error.value = t("apiError");
  } finally {
    saving.value = false;
  }
}
async function revoke(session: AgentSession) {
  if (!selectedAgent.value) return;
  try {
    await api.revokeAgentSession(selectedAgent.value, session.id);
    sessions.value = sessions.value.map((row) =>
      row.id === session.id ? { ...row, status: "revoked" } : row
    );
  } catch {
    error.value = t("apiError");
  }
}
function clearCredentials() {
  clearTimeout(credentialExpiryTimer);
  credentialExpiryTimer = undefined;
  createdSession.value = null;
  credentialsExpired.value = false;
}
/** The credentials dialog is modal: Fluent supplies the focus trap and Escape handling. */
watch(createdSession, async (session) => {
  if (!session) return;
  await nextTick();
  if (credentialDialog.value instanceof Dialog) credentialDialog.value.show();
});
/** Fluent reports open state changes as a CustomEvent whose detail carries `newState`. */
function onDialogToggle(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const detail: unknown = event.detail;
  if (typeof detail === "object" && detail !== null && "newState" in detail) {
    if (detail.newState === "closed") clearCredentials();
  }
}
watch(selectedAgent, () => {
  createSessionVersion += 1;
  clearCredentials();
  void loadSessions();
});
void load();
onUnmounted(() => {
  clearTimeout(credentialExpiryTimer);
  clearInterval(sessionClockTimer);
  sessionsRequestVersion.value += 1;
  createSessionVersion += 1;
  createdSession.value = null;
});
sessionClockTimer = setInterval(() => {
  sessionNow.value = Date.now();
}, 30_000);
</script>

<template>
  <section class="page agent-settings">
    <p class="eyebrow">{{ t("settings") }} / {{ t("agents") }}</p>
    <h1>{{ t("agents") }}</h1>
    <div v-if="loading || error" class="box">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <template v-else>
      <form class="box box-form form-stack agent-form" @submit.prevent="createAgent">
        <div>
          <p class="eyebrow">{{ t("createAgent") }}</p>
          <h2>{{ t("multipleAgents") }}</h2>
        </div>
        <TextField v-model="agentForm.name" required maxlength="80">{{ t("agentName") }}</TextField>
        <TextField v-model="agentForm.description" maxlength="500">{{
          t("description")
        }}</TextField>
        <div class="form-actions">
          <fluent-button type="submit" appearance="primary" :disabled="saving">{{
            t("createAgent")
          }}</fluent-button>
        </div>
      </form>
      <div class="agent-layout">
        <nav class="box agent-list" :aria-label="t('yourAgents')">
          <div class="box-header">{{ t("yourAgents") }}</div>
          <fluent-button
            v-for="agent in agents"
            :key="agent.id"
            type="button"
            class="agent-choice"
            :appearance="selectedAgent === agent.id ? 'secondary' : 'transparent'"
            :aria-pressed="selectedAgent === agent.id"
            @click="selectedAgent = agent.id"
          >
            <span class="agent-choice-text">
              <strong>{{ agent.name }}</strong>
              <small>{{
                agent.disabledAt ? t("disabled") : agent.description || t("noDescription")
              }}</small>
            </span>
          </fluent-button>
          <p v-if="!agents.length" class="muted box-form">{{ t("noAgents") }}</p>
        </nav>
        <div v-if="currentAgent" class="agent-detail">
          <section class="box box-form">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">{{ t("agent") }}</p>
                <h2>{{ currentAgent.name }}</h2>
              </div>
              <fluent-button
                v-if="!currentAgent.disabledAt"
                type="button"
                @click="disableAgent(currentAgent)"
              >
                {{ t("disableAgent") }}
              </fluent-button>
            </div>
            <p class="muted">{{ currentAgent.description }}</p>
            <small class="muted"
              >{{ t("createdAt") }} {{ new Date(currentAgent.createdAt).toLocaleString() }}</small
            >
          </section>
          <form
            v-if="!currentAgent.disabledAt"
            class="box box-form form-stack session-form"
            @submit.prevent="createSession"
          >
            <p class="eyebrow">{{ t("createAgentSession") }}</p>
            <SelectField v-model="sessionForm.repositoryId" :label="t('repository')" required>
              <fluent-option value="" disabled>{{ t("selectRepository") }}</fluent-option>
              <fluent-option v-for="repo in repositories" :key="repo.id" :value="repo.id">
                {{ repo.owner }}/{{ repo.name }}
              </fluent-option>
            </SelectField>
            <TextField v-model="sessionForm.baseRef" required>{{ t("baseBranch") }}</TextField>
            <SelectField
              :model-value="sessionForm.permission"
              :label="t('permission')"
              @update:model-value="sessionForm.permission = oneOf(permissions, $event, 'write')"
            >
              <fluent-option value="read">{{ t("readOnly") }}</fluent-option>
              <fluent-option value="write">{{ t("writeAccess") }}</fluent-option>
            </SelectField>
            <SelectField
              :model-value="String(sessionForm.ttlSeconds)"
              :label="t('sessionLifetime')"
              @update:model-value="sessionForm.ttlSeconds = Number($event)"
            >
              <fluent-option value="3600">1 {{ t("hour") }}</fluent-option>
              <fluent-option value="86400">1 {{ t("day") }}</fluent-option>
              <fluent-option value="604800">7 {{ t("days") }}</fluent-option>
            </SelectField>
            <div class="form-actions">
              <fluent-button
                type="submit"
                appearance="primary"
                :disabled="saving || !repositories.length"
              >
                {{ t("createAgentSession") }}
              </fluent-button>
            </div>
          </form>
          <section class="box">
            <div class="box-header">{{ t("sessions") }}</div>
            <StatusState
              v-if="sessionsError"
              :error="sessionsError"
              :empty="false"
              @retry="loadSessions"
            />
            <StatusState v-else-if="sessionsLoading" :loading="true" :empty="false" />
            <template v-else>
              <div v-for="session in sessions" :key="session.id" class="box-row session-row">
                <div class="grow">
                  <div class="row-title">{{ session.workspaceName }}</div>
                  <div class="row-meta">
                    <span
                      >{{
                        repositories.find((repo) => repo.id === session.repositoryId)?.slug ||
                        session.repositoryId
                      }}
                      · {{ session.baseRef }} ·
                      {{ t(session.permission === "read" ? "readOnly" : "writeAccess") }}</span
                    >
                    <span
                      >{{ t("expiresAt") }} {{ new Date(session.expiresAt).toLocaleString() }}</span
                    >
                  </div>
                </div>
                <StatusBadge :tone="sessionExpired(session) ? 'warning' : 'neutral'">{{
                  sessionStatus(session)
                }}</StatusBadge>
                <fluent-button
                  v-if="session.status === 'active' && !sessionExpired(session)"
                  type="button"
                  @click="revoke(session)"
                >
                  {{ t("revokeSession") }}
                </fluent-button>
              </div>
              <p v-if="!sessions.length" class="muted box-form">{{ t("noSessions") }}</p>
            </template>
          </section>
        </div>
        <div v-else class="box state">{{ t("selectAgent") }}</div>
      </div>
      <fluent-dialog
        v-if="createdSession"
        ref="credentialDialog"
        type="modal"
        aria-labelledby="credential-title"
        @toggle="onDialogToggle"
      >
        <fluent-dialog-body>
          <span id="credential-title" slot="title">{{
            t(credentialsExpired ? "tokenExpired" : "copyBeforeClose")
          }}</span>
          <div class="credential-card">
            <p class="eyebrow">{{ t("oneTimeCredentials") }}</p>
            <div v-if="!credentialsExpired" class="credential-field">
              <span class="field-label">{{ t("apiBearerToken") }}</span>
              <code>Bearer {{ createdSession.token }}</code>
            </div>
            <div v-if="!credentialsExpired" class="credential-field">
              <span class="field-label">{{ t("gitToken") }}</span>
              <code>{{ createdSession.gitToken }}</code>
            </div>
            <div class="credential-field">
              <span class="field-label">{{ t("gitRemote") }}</span>
              <code>{{ createdSession.remote }}</code>
            </div>
            <div class="credential-field">
              <span class="field-label">{{ t("agentInstructions") }}</span>
              <pre>{{ createdSession.instructions || t("noInstructions") }}</pre>
            </div>
            <p class="muted">{{ t("credentialsNotSaved") }}</p>
          </div>
          <fluent-button slot="action" type="button" appearance="primary" @click="clearCredentials">
            {{ t("close") }}
          </fluent-button>
        </fluent-dialog-body>
      </fluent-dialog>
    </template>
  </section>
</template>

<style scoped>
.agent-form,
.session-form {
  margin-bottom: var(--spacingVerticalL);
}
.agent-layout {
  display: grid;
  grid-template-columns: minmax(190px, 0.7fr) minmax(0, 1.5fr);
  gap: var(--spacingHorizontalL);
}
.agent-detail {
  display: grid;
  gap: var(--spacingVerticalL);
}
.agent-list {
  align-self: start;
}
.agent-choice {
  display: flex;
  width: 100%;
  justify-content: flex-start;
  height: auto;
  padding-block: var(--spacingVerticalS);
  text-align: left;
}
.agent-choice-text {
  display: grid;
  gap: var(--spacingVerticalXXS);
}
.agent-choice small {
  color: var(--colorNeutralForeground3);
}
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacingHorizontalM);
}
.session-row {
  align-items: center;
}
.credential-card {
  display: grid;
  gap: var(--spacingVerticalM);
  min-width: min(560px, 80vw);
}
.credential-field {
  display: grid;
  gap: var(--spacingVerticalXS);
}
.field-label {
  color: var(--colorNeutralForeground2);
  font-size: var(--fontSizeBase200);
}
.credential-card code,
.credential-card pre {
  display: block;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  padding: var(--spacingVerticalS) var(--spacingHorizontalM);
  border-radius: var(--borderRadiusMedium);
  color: var(--colorBrandForegroundLink);
  background: var(--colorNeutralBackground3);
  font: var(--fontSizeBase200) / 1.6 var(--fontFamilyMonospace);
}
@media (max-width: 700px) {
  .agent-layout {
    grid-template-columns: 1fr;
  }
}
</style>
