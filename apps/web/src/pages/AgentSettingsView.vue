<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  api,
  type Agent,
  type AgentSession,
  type CreatedAgentSession,
  type Repository,
} from "../lib/api";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import { agentSessionDisplayStatus } from "../lib/gitGraphView";
import { clearAgentSessionSecrets, isCredentialExpired } from "../lib/credentialSecurity";
import { oneOf } from "../ui/formEvents";
import TextField from "../components/TextField.vue";
import AppIcon from "../components/AppIcon.vue";
import { useRoute, useRouter } from "vue-router";
import "../styles/workspace.css";

const permissions = ["read", "write"] as const;
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
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
let credentialExpiryTimer: number | undefined;
let createSessionVersion = 0;
let sessionClockTimer: number | undefined;
const saving = ref(false);
const error = ref("");
const createdSession = ref<CreatedAgentSession | null>(null);
const credentialDialogOpen = computed({
  get: () => createdSession.value !== null,
  set: (open: boolean) => {
    if (!open) clearCredentials();
  },
});
const agentForm = ref({ name: "", description: "" });
const showAgentForm = ref(false);
const showSessionForm = ref(false);
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
    credentialExpiryTimer = window.setTimeout(
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
    showAgentForm.value = false;
    if (route.query.new)
      await router.replace({ path: route.path, query: { ...route.query, new: undefined } });
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
    showSessionForm.value = false;
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
function closeAgentForm() {
  showAgentForm.value = false;
  if (route.query.new)
    void router.replace({ path: route.path, query: { ...route.query, new: undefined } });
}
watch(selectedAgent, () => {
  createSessionVersion += 1;
  clearCredentials();
  void loadSessions();
});
watch(
  () => route.query.new,
  (value) => {
    if (value === "1") showAgentForm.value = true;
  },
  { immediate: true }
);
void load();
onUnmounted(() => {
  clearTimeout(credentialExpiryTimer);
  clearInterval(sessionClockTimer);
  sessionsRequestVersion.value += 1;
  createSessionVersion += 1;
  createdSession.value = null;
});
sessionClockTimer = window.setInterval(() => {
  sessionNow.value = Date.now();
}, 30_000);
</script>

<template>
  <section class="workspace-page settings-page agent-settings-page">
    <aside class="settings-sidebar">
      <h1>{{ t("settings") }}</h1>
      <p class="settings-sidebar-label">{{ t("personalSettings") }}</p>
      <nav :aria-label="t('settingsNavigation')">
        <RouterLink class="workspace-nav-item" to="/settings/account"
          ><AppIcon name="person" />{{ t("account") }}</RouterLink
        >
        <RouterLink class="workspace-nav-item is-selected" to="/settings/agents"
          ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
        >
      </nav>
    </aside>
    <div class="settings-content">
      <h2 class="settings-page-title">{{ t("agents") }}</h2>
      <div v-if="loading || error" class="box">
        <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
      </div>
      <template v-else>
        <div class="agents-page-heading">
          <div>
            <p class="muted">{{ t("multipleAgents") }}</p>
          </div>
          <button class="btn btn-primary" type="button" @click="showAgentForm = true">
            <AppIcon name="plus" />{{ t("createAgent") }}
          </button>
        </div>
        <div class="agent-layout">
          <nav class="box agent-list" :aria-label="t('yourAgents')">
            <div class="box-header agent-list-header">
              <span>{{ t("yourAgents") }}</span
              ><StatusBadge>{{ agents.length }}</StatusBadge>
            </div>
            <FluentButton
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              class="agent-choice"
              :tone="selectedAgent === agent.id ? 'secondary' : 'subtle'"
              :aria-pressed="selectedAgent === agent.id"
              @click="selectedAgent = agent.id"
            >
              <span class="agent-choice-text">
                <strong>{{ agent.name }}</strong>
                <small>{{
                  agent.disabledAt ? t("disabled") : agent.description || t("noDescription")
                }}</small>
              </span>
            </FluentButton>
            <div v-if="!agents.length" class="agent-empty">
              <AppIcon name="agent" :size="22" /><strong>{{ t("noAgents") }}</strong
              ><span class="muted">{{ t("agentEmptyHint") }}</span
              ><button class="btn btn-sm" type="button" @click="showAgentForm = true">
                {{ t("createAgent") }}
              </button>
            </div>
          </nav>
          <div v-if="currentAgent" class="agent-detail">
            <section class="settings-card agent-summary">
              <div class="panel-heading">
                <div>
                  <h2>{{ currentAgent.name }}</h2>
                  <p class="muted">{{ currentAgent.description || t("noDescription") }}</p>
                </div>
                <FluentButton
                  v-if="!currentAgent.disabledAt"
                  class="btn btn-danger btn-sm"
                  type="button"
                  @click="disableAgent(currentAgent)"
                >
                  {{ t("disableAgent") }}
                </FluentButton>
              </div>
              <small class="muted"
                >{{ t("createdAt") }} {{ new Date(currentAgent.createdAt).toLocaleString() }}</small
              >
            </section>
            <section class="settings-section agent-sessions-section">
              <div class="agent-section-heading">
                <div>
                  <h3>{{ t("sessions") }}</h3>
                  <p class="muted">{{ t("agentSessionsHint") }}</p>
                </div>
                <button
                  v-if="!currentAgent.disabledAt"
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="!repositories.length"
                  @click="showSessionForm = true"
                >
                  <AppIcon name="plus" />{{ t("createAgentSession") }}
                </button>
              </div>
              <section class="settings-card">
                <StatusState
                  v-if="sessionsError"
                  :error="sessionsError"
                  :empty="false"
                  @retry="loadSessions"
                />
                <StatusState v-else-if="sessionsLoading" :loading="true" :empty="false" />
                <template v-else>
                  <div
                    v-for="session in sessions"
                    :key="session.id"
                    class="settings-card-row session-row"
                  >
                    <div class="session-workspace-icon"><AppIcon name="repo" /></div>
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
                          >{{ t("expiresAt") }}
                          {{ new Date(session.expiresAt).toLocaleString() }}</span
                        >
                      </div>
                    </div>
                    <StatusBadge :tone="sessionExpired(session) ? 'warning' : 'neutral'">{{
                      sessionStatus(session)
                    }}</StatusBadge>
                    <button
                      v-if="session.status === 'active' && !sessionExpired(session)"
                      class="btn btn-sm"
                      type="button"
                      @click="revoke(session)"
                    >
                      {{ t("revokeSession") }}
                    </button>
                  </div>
                  <div v-if="!sessions.length" class="settings-empty-state">
                    <strong>{{ t("noSessions") }}</strong
                    ><span>{{ t("noSessionsHint") }}</span>
                  </div>
                </template>
              </section>
            </section>
          </div>
          <div v-else class="box state">{{ t("selectAgent") }}</div>
        </div>
        <FluentDialog
          v-model:open="credentialDialogOpen"
          :label="t(credentialsExpired ? 'tokenExpired' : 'copyBeforeClose')"
          close-on-outside
        >
          <template #title>
            <span>{{ t(credentialsExpired ? "tokenExpired" : "copyBeforeClose") }}</span>
          </template>
          <div v-if="createdSession">
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
          </div>
          <template #footer>
            <FluentButton type="button" tone="primary" @click="clearCredentials">
              {{ t("close") }}
            </FluentButton>
          </template>
        </FluentDialog>
        <div v-if="showAgentForm" class="workspace-modal-backdrop" @click.self="closeAgentForm">
          <section
            class="workspace-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="'create-agent-title'"
          >
            <header class="workspace-modal-heading">
              <h2 id="create-agent-title">{{ t("createAgent") }}</h2>
              <button
                class="icon-button"
                type="button"
                :aria-label="t('close')"
                @click="closeAgentForm"
              >
                <AppIcon name="close" />
              </button>
            </header>
            <p class="muted">{{ t("agentCreateHint") }}</p>
            <form class="form-stack" @submit.prevent="createAgent">
              <TextField v-model="agentForm.name" required maxlength="80">{{
                t("agentName")
              }}</TextField>
              <TextField v-model="agentForm.description" maxlength="500">{{
                t("description")
              }}</TextField>
              <div class="form-actions">
                <button class="btn" type="button" @click="closeAgentForm">{{ t("cancel") }}</button
                ><button class="btn btn-primary" type="submit" :disabled="saving">
                  {{ saving ? t("loading") : t("createAgent") }}
                </button>
              </div>
              <p v-if="error" class="workspace-form-error">{{ error }}</p>
            </form>
          </section>
        </div>
        <div
          v-if="showSessionForm"
          class="workspace-modal-backdrop"
          @click.self="showSessionForm = false"
        >
          <section
            class="workspace-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="'create-session-title'"
          >
            <header class="workspace-modal-heading">
              <h2 id="create-session-title">{{ t("createAgentSession") }}</h2>
              <button
                class="icon-button"
                type="button"
                :aria-label="t('close')"
                @click="showSessionForm = false"
              >
                <AppIcon name="close" />
              </button>
            </header>
            <p class="muted">{{ t("sessionScopeHint") }}</p>
            <form class="form-stack" @submit.prevent="createSession">
              <SelectField v-model="sessionForm.repositoryId" :label="t('repository')" required>
                <option value="" disabled>{{ t("selectRepository") }}</option>
                <option v-for="repo in repositories" :key="repo.id" :value="repo.id">
                  {{ repo.owner }}/{{ repo.name }}
                </option>
              </SelectField>
              <TextField v-model="sessionForm.baseRef" required>{{ t("baseBranch") }}</TextField>
              <SelectField
                :model-value="sessionForm.permission"
                :label="t('permission')"
                @update:model-value="sessionForm.permission = oneOf(permissions, $event, 'write')"
              >
                <option value="read">{{ t("readOnly") }}</option>
                <option value="write">{{ t("writeAccess") }}</option>
              </SelectField>
              <SelectField
                :model-value="String(sessionForm.ttlSeconds)"
                :label="t('sessionLifetime')"
                @update:model-value="sessionForm.ttlSeconds = Number($event)"
              >
                <option value="3600">1 {{ t("hour") }}</option>
                <option value="86400">1 {{ t("day") }}</option>
                <option value="604800">7 {{ t("days") }}</option>
              </SelectField>
              <p v-if="error" class="workspace-form-error">{{ error }}</p>
              <div class="form-actions">
                <button class="btn" type="button" @click="showSessionForm = false">
                  {{ t("cancel") }}</button
                ><button
                  class="btn btn-primary"
                  type="submit"
                  :disabled="saving || !repositories.length"
                >
                  {{ saving ? t("loading") : t("createAgentSession") }}
                </button>
              </div>
            </form>
          </section>
        </div>
      </template>
    </div>
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
