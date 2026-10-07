<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ApiError,
  api,
  errorMessage,
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
import TextAreaField from "../components/TextAreaField.vue";
import NoticeBar from "../components/NoticeBar.vue";
import AppIcon from "../components/AppIcon.vue";
import { useRoute, useRouter } from "vue-router";
import SettingsSidebar from "../components/SettingsSidebar.vue";
import "../styles/settings.css";

const permissions = ["read", "write"] as const;
const { t, d } = useI18n();
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
const loadError = ref("");
const repositoriesError = ref("");
const actionError = ref("");
const agentFormError = ref("");
const sessionFormError = ref("");
const profileError = ref("");
const profileNotice = ref("");
const profileSaving = ref(false);
let loadVersion = 0;
const createdSession = ref<CreatedAgentSession | null>(null);
const credentialDialogOpen = computed({
  get: () => createdSession.value !== null,
  set: (open: boolean) => {
    if (!open) clearCredentials();
  },
});
const agentForm = ref({ handle: "", name: "", description: "" });
const profileForm = ref({ handle: "", name: "", description: "", profilePublic: false });
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
  const version = ++loadVersion;
  loading.value = true;
  loadError.value = "";
  repositoriesError.value = "";
  const [agentResult, repoResult] = await Promise.allSettled([api.agents(), api.repositories()]);
  if (version !== loadVersion) return;
  if (agentResult.status === "rejected") {
    const cause = agentResult.reason;
    loadError.value =
      cause instanceof ApiError && cause.status === 404 ? t("agentsUnavailable") : t("apiError");
    loading.value = false;
    return;
  }
  agents.value = agentResult.value;
  if (repoResult.status === "fulfilled") repositories.value = repoResult.value;
  else {
    repositories.value = [];
    repositoriesError.value = errorMessage(repoResult.reason, t);
  }
  loading.value = false;
  if (!selectedAgent.value && agentResult.value[0]) selectedAgent.value = agentResult.value[0].id;
  else await loadSessions();
}
async function reloadRepositories() {
  repositoriesError.value = "";
  try {
    repositories.value = await api.repositories();
  } catch (cause) {
    repositoriesError.value = errorMessage(cause, t);
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
  agentFormError.value = "";
  try {
    const agent = await api.createAgent(agentForm.value);
    agents.value = [agent, ...agents.value];
    selectedAgent.value = agent.id;
    agentForm.value = { handle: "", name: "", description: "" };
    showAgentForm.value = false;
    if (route.query.new)
      await router.replace({ path: route.path, query: { ...route.query, new: undefined } });
  } catch (cause) {
    agentFormError.value = errorMessage(cause, t, { 409: "agentHandleInUse" });
  } finally {
    saving.value = false;
  }
}
async function saveProfile(agent: Agent) {
  profileSaving.value = true;
  profileError.value = "";
  profileNotice.value = "";
  try {
    const updated = await api.updateAgent(agent.id, { ...profileForm.value });
    agents.value = agents.value.map((row) => (row.id === updated.id ? updated : row));
    if (agent.id === selectedAgent.value) {
      resetProfileForm(updated);
      profileNotice.value = t("agentProfileSaved");
    }
  } catch (cause) {
    if (agent.id === selectedAgent.value) {
      profileError.value = errorMessage(cause, t, { 409: "agentHandleInUse" });
    }
  } finally {
    profileSaving.value = false;
  }
}
function resetProfileForm(agent: Agent | null) {
  profileError.value = "";
  profileNotice.value = "";
  profileForm.value = agent
    ? {
        handle: agent.handle,
        name: agent.name,
        description: agent.description,
        profilePublic: agent.profilePublic,
      }
    : { handle: "", name: "", description: "", profilePublic: false };
}
async function disableAgent(agent: Agent) {
  actionError.value = "";
  saving.value = true;
  try {
    await api.disableAgent(agent.id);
    agents.value = agents.value.map((row) =>
      row.id === agent.id ? { ...row, disabledAt: Date.now() } : row
    );
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}
async function createSession() {
  if (!selectedAgent.value) return;
  saving.value = true;
  sessionFormError.value = "";
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
  } catch (cause) {
    sessionFormError.value = errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}
async function revoke(session: AgentSession) {
  if (!selectedAgent.value) return;
  actionError.value = "";
  saving.value = true;
  try {
    await api.revokeAgentSession(selectedAgent.value, session.id);
    sessions.value = sessions.value.map((row) =>
      row.id === session.id ? { ...row, status: "revoked" } : row
    );
  } catch (cause) {
    actionError.value = errorMessage(cause, t);
  } finally {
    saving.value = false;
  }
}
function clearCredentials() {
  clearTimeout(credentialExpiryTimer);
  credentialExpiryTimer = undefined;
  createdSession.value = null;
  credentialsExpired.value = false;
}
function openAgentForm() {
  agentFormError.value = "";
  showAgentForm.value = true;
}
function openSessionForm() {
  sessionFormError.value = "";
  showSessionForm.value = true;
}
function closeSessionForm() {
  showSessionForm.value = false;
}
function closeAgentForm() {
  showAgentForm.value = false;
  if (route.query.new)
    void router.replace({ path: route.path, query: { ...route.query, new: undefined } });
}
watch(
  currentAgent,
  (agent, previous) => {
    if (agent?.id !== previous?.id) resetProfileForm(agent);
  },
  { immediate: true }
);
watch(selectedAgent, () => {
  actionError.value = "";
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
  loadVersion += 1;
  createSessionVersion += 1;
  createdSession.value = null;
});
sessionClockTimer = window.setInterval(() => {
  sessionNow.value = Date.now();
}, 30_000);
</script>

<template>
  <section class="settings-page agent-settings-page">
    <SettingsSidebar active="agents" />
    <div class="settings-content">
      <header class="settings-header">
        <div>
          <h2>{{ t("agents") }}</h2>
          <p>{{ t("multipleAgents") }}</p>
        </div>
        <button
          v-if="!loading && !loadError"
          class="btn btn-primary"
          type="button"
          @click="openAgentForm"
        >
          <AppIcon name="plus" />{{ t("createAgent") }}
        </button>
      </header>
      <div v-if="loading || loadError" class="box">
        <StatusState :loading="loading" :error="loadError" :empty="false" @retry="load" />
      </div>
      <template v-else>
        <NoticeBar v-if="actionError" intent="error">{{ actionError }}</NoticeBar>
        <NoticeBar v-if="repositoriesError" intent="warning">
          {{ repositoriesError }}
          <template #actions>
            <FluentButton size="small" type="button" @click="reloadRepositories">{{
              t("retry")
            }}</FluentButton>
          </template>
        </NoticeBar>
        <div class="agent-layout" :class="{ 'is-single': !agents.length }">
          <nav class="box agent-list" :aria-label="t('yourAgents')">
            <div class="box-header">
              <span>{{ t("yourAgents") }}</span
              ><StatusBadge class="box-header-end">{{ agents.length }}</StatusBadge>
            </div>
            <button
              v-for="agent in agents"
              :key="agent.id"
              type="button"
              class="agent-choice"
              :aria-pressed="selectedAgent === agent.id"
              @click="selectedAgent = agent.id"
            >
              <strong>{{ agent.name }}</strong>
              <small>{{
                agent.disabledAt ? t("disabled") : agent.description || t("noDescription")
              }}</small>
            </button>
            <div v-if="!agents.length" class="settings-empty">
              <AppIcon name="agent" :size="24" /><strong>{{ t("noAgents") }}</strong
              ><span>{{ t("agentEmptyHint") }}</span
              ><button class="btn btn-sm" type="button" @click="openAgentForm">
                {{ t("createAgent") }}
              </button>
            </div>
          </nav>
          <div v-if="currentAgent" class="agent-detail">
            <section class="box" aria-labelledby="agent-summary-title">
              <header class="box-header">
                <h3 id="agent-summary-title">{{ currentAgent.name }}</h3>
                <StatusBadge v-if="currentAgent.disabledAt" tone="warning">{{
                  t("disabled")
                }}</StatusBadge>
                <RouterLink
                  class="btn btn-sm box-header-end"
                  :to="`/settings/agents/${currentAgent.id}/webhook`"
                  >{{ t("agentWebhook") }}</RouterLink
                >
              </header>
              <div class="box-row">
                <div class="settings-item-copy">
                  <p>{{ currentAgent.description || t("noDescription") }}</p>
                  <div class="row-meta">
                    <RouterLink :to="currentAgent.profilePath">{{
                      currentAgent.profilePath
                    }}</RouterLink>
                    <span>{{ t("createdAt") }} {{ d(currentAgent.createdAt, "long") }}</span>
                  </div>
                </div>
              </div>
              <form
                v-if="!currentAgent.disabledAt"
                class="box-form form-stack agent-profile-form"
                @submit.prevent="saveProfile(currentAgent)"
              >
                <h4>{{ t("agentProfile") }}</h4>
                <TextField
                  v-model="profileForm.handle"
                  required
                  maxlength="40"
                  pattern="[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?"
                  :hint="t('agentHandleHint')"
                  >{{ t("agentHandle") }}</TextField
                >
                <TextField v-model="profileForm.name" required maxlength="80">{{
                  t("agentName")
                }}</TextField>
                <TextAreaField
                  v-model="profileForm.description"
                  rows="3"
                  maxlength="500"
                  :label="t('description')"
                />
                <FluentCheckbox v-model="profileForm.profilePublic">
                  {{ t("profilePublic") }}
                  <small>{{ t("profilePublicHint") }}</small>
                </FluentCheckbox>
                <NoticeBar v-if="profileError" intent="error">{{ profileError }}</NoticeBar>
                <NoticeBar v-else-if="profileNotice" intent="success">{{
                  profileNotice
                }}</NoticeBar>
                <div class="form-actions">
                  <FluentButton type="submit" tone="primary" :disabled="profileSaving">
                    {{ profileSaving ? t("loading") : t("save") }}
                  </FluentButton>
                </div>
              </form>
            </section>
            <section class="box" aria-labelledby="agent-sessions-title">
              <header class="box-header">
                <h3 id="agent-sessions-title">{{ t("sessions") }}</h3>
                <button
                  v-if="!currentAgent.disabledAt"
                  class="btn btn-primary btn-sm box-header-end"
                  type="button"
                  :disabled="!repositories.length"
                  @click="openSessionForm"
                >
                  <AppIcon name="plus" />{{ t("createAgentSession") }}
                </button>
              </header>
              <p class="box-row settings-hint">{{ t("agentSessionsHint") }}</p>
              <StatusState
                v-if="sessionsError"
                :error="sessionsError"
                :empty="false"
                @retry="loadSessions"
              />
              <StatusState v-else-if="sessionsLoading" :loading="true" :empty="false" />
              <template v-else>
                <div v-for="session in sessions" :key="session.id" class="box-row settings-item">
                  <div class="session-workspace-icon"><AppIcon name="repo" /></div>
                  <div class="settings-item-copy">
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
                      <span>{{ t("expiresAt") }} {{ d(session.expiresAt, "long") }}</span>
                    </div>
                  </div>
                  <StatusBadge :tone="sessionExpired(session) ? 'warning' : 'neutral'">{{
                    sessionStatus(session)
                  }}</StatusBadge>
                  <button
                    v-if="session.status === 'active' && !sessionExpired(session)"
                    class="btn btn-sm"
                    type="button"
                    :disabled="saving"
                    @click="revoke(session)"
                  >
                    {{ t("revokeSession") }}
                  </button>
                </div>
                <div v-if="!sessions.length" class="settings-empty">
                  <strong>{{ t("noSessions") }}</strong
                  ><span>{{ t("noSessionsHint") }}</span>
                </div>
              </template>
            </section>
            <section
              v-if="!currentAgent.disabledAt"
              class="box box-danger"
              aria-labelledby="agent-danger-title"
            >
              <header class="box-header">
                <h3 id="agent-danger-title">{{ t("dangerZone") }}</h3>
              </header>
              <div class="box-row settings-item">
                <div class="settings-item-copy">
                  <strong>{{ t("disableAgent") }}</strong>
                  <span class="settings-hint">{{ t("agentDisableHint") }}</span>
                </div>
                <FluentButton
                  class="btn btn-danger btn-sm"
                  type="button"
                  :disabled="saving"
                  @click="disableAgent(currentAgent)"
                >
                  {{ t("disableAgent") }}
                </FluentButton>
              </div>
            </section>
          </div>
          <div v-else-if="agents.length" class="box state">{{ t("selectAgent") }}</div>
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
        <FluentDialog
          :open="showAgentForm"
          :label="t('createAgent')"
          close-on-outside
          @close="closeAgentForm"
        >
          <template #title>
            <h2>{{ t("createAgent") }}</h2>
          </template>
          <p class="muted">{{ t("agentCreateHint") }}</p>
          <form class="form-stack" @submit.prevent="createAgent">
            <TextField
              v-model="agentForm.handle"
              maxlength="40"
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              :hint="t('agentHandleHint')"
              >{{ t("agentHandle") }}</TextField
            >
            <TextField v-model="agentForm.name" required maxlength="80">{{
              t("agentName")
            }}</TextField>
            <TextField v-model="agentForm.description" maxlength="500">{{
              t("description")
            }}</TextField>
            <NoticeBar v-if="agentFormError" intent="error">{{ agentFormError }}</NoticeBar>
            <div class="form-actions">
              <button class="btn" type="button" @click="closeAgentForm">{{ t("cancel") }}</button
              ><button class="btn btn-primary" type="submit" :disabled="saving">
                {{ saving ? t("loading") : t("createAgent") }}
              </button>
            </div>
          </form>
        </FluentDialog>
        <FluentDialog
          :open="showSessionForm"
          :label="t('createAgentSession')"
          close-on-outside
          @close="closeSessionForm"
        >
          <template #title>
            <h2>{{ t("createAgentSession") }}</h2>
          </template>
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
            <NoticeBar v-if="sessionFormError" intent="error">{{ sessionFormError }}</NoticeBar>
            <div class="form-actions">
              <button class="btn" type="button" @click="closeSessionForm">
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
        </FluentDialog>
      </template>
    </div>
  </section>
</template>

<style scoped>
.agent-layout {
  display: grid;
  grid-template-columns: minmax(200px, 0.7fr) minmax(0, 1.6fr);
  gap: var(--space-4);
}
.agent-layout.is-single {
  grid-template-columns: minmax(0, 1fr);
}
.agent-detail {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.agent-list {
  align-self: start;
}
.agent-choice {
  position: relative;
  display: grid;
  gap: var(--space-1);
  width: 100%;
  min-height: calc(var(--space-8) + var(--space-4));
  padding: var(--space-2) var(--space-4);
  color: var(--fg-default);
  background: transparent;
  border: 0;
  border-top: 1px solid var(--border-muted);
  font: inherit;
  text-align: left;
}
.agent-choice:hover {
  background: var(--bg-subtle);
}
.agent-choice[aria-pressed="true"] {
  background: var(--bg-selected);
}
.agent-choice[aria-pressed="true"]::before {
  position: absolute;
  inset-block: 0;
  left: 0;
  width: var(--space-1);
  background: var(--accent-strong);
  content: "";
}
.agent-choice strong,
.agent-choice small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-choice strong {
  font-weight: var(--font-weight-medium);
}
.agent-choice small {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.session-workspace-icon {
  display: grid;
  width: var(--control-height);
  height: var(--control-height);
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--fg-muted);
}
.credential-card {
  display: grid;
  gap: var(--space-3);
  min-width: min(560px, 80vw);
}
.credential-field {
  display: grid;
  gap: var(--space-1);
}
.field-label {
  color: var(--fg-secondary);
  font-size: var(--font-size-meta);
}
.credential-card code,
.credential-card pre {
  display: block;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  color: var(--accent-fg);
  background: var(--bg-subtle);
  font: var(--font-size-meta) / 1.6 var(--font-mono);
}
@media (max-width: 760px) {
  .agent-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
