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
import StatusState from "../components/StatusState.vue";
import { agentSessionDisplayStatus } from "../lib/gitGraphView";
import { clearAgentSessionSecrets, isCredentialExpired } from "../lib/credentialSecurity";

const { t } = useI18n();
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
    <div v-if="loading || error" class="content-card">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <template v-else>
      <form class="content-card agent-form" @submit.prevent="createAgent">
        <div>
          <p class="eyebrow">{{ t("createAgent") }}</p>
          <h2>{{ t("multipleAgents") }}</h2>
        </div>
        <label>{{ t("agentName") }}<input v-model="agentForm.name" required maxlength="80" /></label
        ><label
          >{{ t("description") }}<input v-model="agentForm.description" maxlength="500" /></label
        ><button class="button primary" :disabled="saving">{{ t("createAgent") }}</button>
      </form>
      <div class="agent-layout">
        <nav class="content-card agent-list">
          <p class="eyebrow">{{ t("yourAgents") }}</p>
          <button
            v-for="agent in agents"
            :key="agent.id"
            class="agent-choice"
            :class="{ selected: selectedAgent === agent.id }"
            @click="selectedAgent = agent.id"
          >
            <strong>{{ agent.name }}</strong
            ><small>{{
              agent.disabledAt ? t("disabled") : agent.description || t("noDescription")
            }}</small>
          </button>
          <p v-if="!agents.length" class="muted">{{ t("noAgents") }}</p>
        </nav>
        <div v-if="currentAgent" class="agent-detail">
          <section class="content-card">
            <div class="panel-heading">
              <div>
                <p class="eyebrow">{{ t("agent") }}</p>
                <h2>{{ currentAgent.name }}</h2>
              </div>
              <button
                v-if="!currentAgent.disabledAt"
                class="button"
                @click="disableAgent(currentAgent)"
              >
                {{ t("disableAgent") }}
              </button>
            </div>
            <p class="muted">{{ currentAgent.description }}</p>
            <small
              >{{ t("createdAt") }} {{ new Date(currentAgent.createdAt).toLocaleString() }}</small
            >
          </section>
          <form
            v-if="!currentAgent.disabledAt"
            class="content-card session-form"
            @submit.prevent="createSession"
          >
            <p class="eyebrow">{{ t("createAgentSession") }}</p>
            <label
              >{{ t("repository")
              }}<select v-model="sessionForm.repositoryId" required>
                <option value="" disabled>{{ t("selectRepository") }}</option>
                <option v-for="repo in repositories" :key="repo.id" :value="repo.id">
                  {{ repo.owner }}/{{ repo.name }}
                </option>
              </select></label
            ><label>{{ t("baseBranch") }}<input v-model="sessionForm.baseRef" required /></label
            ><label
              >{{ t("permission")
              }}<select v-model="sessionForm.permission">
                <option value="read">{{ t("readOnly") }}</option>
                <option value="write">{{ t("writeAccess") }}</option>
              </select></label
            ><label
              >{{ t("sessionLifetime")
              }}<select v-model.number="sessionForm.ttlSeconds">
                <option :value="3600">1 {{ t("hour") }}</option>
                <option :value="86400">1 {{ t("day") }}</option>
                <option :value="604800">7 {{ t("days") }}</option>
              </select></label
            ><button class="button primary" :disabled="saving || !repositories.length">
              {{ t("createAgentSession") }}
            </button>
          </form>
          <section class="content-card">
            <p class="eyebrow">{{ t("sessions") }}</p>
            <StatusState
              v-if="sessionsError"
              :error="sessionsError"
              :empty="false"
              @retry="loadSessions"
            />
            <StatusState v-else-if="sessionsLoading" :loading="true" :empty="false" />
            <template v-else>
              <div v-for="session in sessions" :key="session.id" class="session-row">
                <div>
                  <strong>{{ session.workspaceName }}</strong
                  ><small
                    >{{
                      repositories.find((repo) => repo.id === session.repositoryId)?.slug ||
                      session.repositoryId
                    }}
                    · {{ session.baseRef }} ·
                    {{ t(session.permission === "read" ? "readOnly" : "writeAccess") }}</small
                  ><small
                    >{{ t("expiresAt") }} {{ new Date(session.expiresAt).toLocaleString() }} ·
                    {{ sessionStatus(session) }}</small
                  >
                </div>
                <button
                  v-if="session.status === 'active' && !sessionExpired(session)"
                  class="button"
                  @click="revoke(session)"
                >
                  {{ t("revokeSession") }}
                </button>
              </div>
              <p v-if="!sessions.length" class="muted">{{ t("noSessions") }}</p>
            </template>
          </section>
        </div>
        <div v-else class="content-card state">{{ t("selectAgent") }}</div>
      </div>
      <section v-if="createdSession" class="credential-overlay">
        <article class="content-card credential-card">
          <button class="text-button close-button" @click="clearCredentials">
            {{ t("close") }}
          </button>
          <p class="eyebrow">{{ t("oneTimeCredentials") }}</p>
          <h2>{{ t(credentialsExpired ? "tokenExpired" : "copyBeforeClose") }}</h2>
          <label v-if="!credentialsExpired"
            >{{ t("apiBearerToken") }}<code>Bearer {{ createdSession.token }}</code></label
          ><label v-if="!credentialsExpired"
            >{{ t("gitToken") }}<code>{{ createdSession.gitToken }}</code></label
          ><label
            >{{ t("gitRemote") }}<code>{{ createdSession.remote }}</code></label
          ><label
            >{{ t("agentInstructions") }}
            <pre>{{ createdSession.instructions || t("noInstructions") }}</pre>
          </label>
          <p class="muted">{{ t("credentialsNotSaved") }}</p>
          <button class="button primary" @click="clearCredentials">{{ t("close") }}</button>
        </article>
      </section>
    </template>
  </section>
</template>

<style scoped>
.content-card {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 18px;
}
.agent-form,
.session-form {
  display: grid;
  gap: 12px;
  margin-bottom: 18px;
}
.agent-form label,
.session-form label,
.credential-card label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.agent-form input,
.session-form input,
.session-form select {
  padding: 10px;
  border: 1px solid var(--line);
  background: var(--lift);
  color: inherit;
  font: inherit;
}
.agent-layout {
  display: grid;
  grid-template-columns: minmax(190px, 0.7fr) minmax(0, 1.5fr);
  gap: 18px;
}
.agent-detail {
  display: grid;
  gap: 18px;
}
.agent-list {
  align-self: start;
}
.agent-choice {
  display: grid;
  gap: 5px;
  width: 100%;
  padding: 12px 8px;
  text-align: left;
  border: 0;
  border-bottom: 1px solid var(--line);
  color: inherit;
  background: transparent;
}
.agent-choice.selected {
  background: var(--lift);
  border-left: 2px solid var(--accent);
}
.agent-choice small,
.session-row small,
.muted {
  color: var(--muted);
}
.panel-heading,
.session-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.session-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.session-row div {
  display: grid;
  gap: 5px;
}
.credential-overlay {
  position: fixed;
  z-index: 10;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: #09090dcc;
}
.credential-card {
  position: relative;
  display: grid;
  gap: 14px;
  width: min(720px, 100%);
  max-height: 90vh;
  overflow: auto;
}
.credential-card code,
.credential-card pre {
  display: block;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  padding: 10px;
  color: var(--warm);
  background: var(--lift);
  font:
    12px/1.6 "IBM Plex Mono",
    monospace;
}
.close-button {
  position: absolute;
  right: 14px;
  top: 14px;
}
@media (max-width: 700px) {
  .agent-layout {
    grid-template-columns: 1fr;
  }
}
</style>
