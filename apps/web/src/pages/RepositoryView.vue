<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { AgentSession, Repository, RepositorySettings } from "../lib/api";
import { ApiError, api } from "../lib/api";
import AppIcon, { type IconName } from "../components/AppIcon.vue";
import StatusBadge from "../components/StatusBadge.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";
import DeployWizard from "../components/DeployWizard.vue";
import RepositoryCode from "../components/RepositoryCode.vue";
import RepositoryCollaboration from "../components/RepositoryCollaboration.vue";
import RepositorySettingsPanel from "../components/RepositorySettings.vue";
import RepositoryTasks from "../components/RepositoryTasks.vue";
const RepositoryActions = defineAsyncComponent(() => import("../components/RepositoryActions.vue"));
const route = useRoute();
const { t, d } = useI18n();
const owner = computed(() => String(route.params.owner));
const repoName = computed(() => String(route.params.repo));
const base = computed(() => `/${owner.value}/${repoName.value}`);
const section = computed(() =>
  route.params.view ? "code" : String(route.params.section || route.path.split("/")[3] || "code")
);
const activeTab = computed(() => section.value);
const tabs: { key: string; label: string; icon: IconName; write?: boolean }[] = [
  { key: "code", label: "code", icon: "code" },
  { key: "commits", label: "commitGraph", icon: "clock" },
  { key: "compare", label: "compare", icon: "diff" },
  { key: "issues", label: "issues", icon: "issue" },
  { key: "pulls", label: "pulls", icon: "pr" },
  { key: "tasks", label: "tasks", icon: "task" },
  { key: "agents", label: "agents", icon: "agent", write: true },
  { key: "actions", label: "ghActionsTab", icon: "activity", write: true },
  { key: "discussions", label: "discussions", icon: "discussion" },
  { key: "wiki", label: "wiki", icon: "wiki" },
  { key: "deploy", label: "ghDeployTab", icon: "cloud", write: true },
  { key: "settings", label: "ghSettings", icon: "gear", write: true },
];
const repository = ref<Repository | null>(null);
function sectionEnabled(key: string): boolean {
  const current = repository.value;
  if (!current) return true;
  if (key === "issues") return current.issuesEnabled;
  if (key === "pulls") return current.pullsEnabled;
  if (key === "discussions") return current.discussionsEnabled;
  if (key === "wiki") return current.wikiEnabled;
  if (key === "tasks") return current.tasksEnabled;
  if (key === "agents") return current.agentsEnabled;
  if (key === "deploy") return current.deploymentsEnabled && !current.archived;
  if (key === "actions") return current.actionsEnabled;
  if (key === "commits") return current.graphEnabled;
  if (key === "compare") return current.graphEnabled || current.pullsEnabled;
  return true;
}
const collaborationRepository = computed(() =>
  repository.value
    ? { ...repository.value, canWrite: repository.value.canWrite && !repository.value.archived }
    : null
);
function settingsUpdated(settings: RepositorySettings): void {
  if (!repository.value) return;
  repository.value = {
    ...repository.value,
    name: settings.name,
    slug: settings.slug,
    description: settings.description,
    visibility: settings.visibility,
    defaultBranch: settings.defaultBranch,
    archived: settings.archived,
    issuesEnabled: settings.issuesEnabled,
    pullsEnabled: settings.pullsEnabled,
    discussionsEnabled: settings.discussionsEnabled,
    wikiEnabled: settings.wikiEnabled,
    tasksEnabled: settings.tasksEnabled,
    agentsEnabled: settings.agentsEnabled,
    deploymentsEnabled: settings.deploymentsEnabled,
    graphEnabled: settings.graphEnabled,
    actionsEnabled: settings.actionsEnabled,
    actionsNetworkEnabled: settings.actionsNetworkEnabled,
    onlineEditingEnabled: settings.onlineEditingEnabled,
    allowMergeCommit: settings.allowMergeCommit,
    allowSquashMerge: settings.allowSquashMerge,
    allowRebaseMerge: settings.allowRebaseMerge,
    deleteBranchOnMerge: settings.deleteBranchOnMerge,
    requiredApprovals: settings.requiredApprovals,
    requirePassingChecks: settings.requirePassingChecks,
  };
  void loadCounts(repository.value, loadVersion);
}
const loading = ref(true);
const error = ref("");
const notFound = ref(false);
const accessDenied = ref(false);
const counts = ref<Record<string, number>>({});
const sessions = ref<AgentSession[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref("");
let loadVersion = 0;
let sessionVersion = 0;
async function loadCounts(current: Repository, version: number) {
  const [issues, pulls, discussions] = await Promise.allSettled([
    current.issuesEnabled ? api.issues(current.id) : Promise.resolve(null),
    current.pullsEnabled ? api.pulls(current.id) : Promise.resolve(null),
    current.discussionsEnabled ? api.discussions(current.id) : Promise.resolve(null),
  ]);
  if (version !== loadVersion) return;
  counts.value = {
    ...(issues.status === "fulfilled"
      ? { issues: (issues.value ?? []).filter((item) => item.state === "open").length }
      : {}),
    ...(pulls.status === "fulfilled"
      ? { pulls: (pulls.value ?? []).filter((item) => item.state === "open").length }
      : {}),
    ...(discussions.status === "fulfilled" && discussions.value
      ? { discussions: discussions.value.length }
      : {}),
  };
}
function refreshCounts() {
  if (repository.value) void loadCounts(repository.value, loadVersion);
}
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  accessDenied.value = false;
  repository.value = null;
  counts.value = {};
  sessions.value = [];
  sessionsLoading.value = false;
  sessionsError.value = "";
  sessionVersion += 1;
  try {
    const result = await api.repository(owner.value, repoName.value);
    if (version !== loadVersion) return;
    repository.value = result;
    void loadCounts(result, version);
  } catch (cause) {
    if (version !== loadVersion) return;
    notFound.value = cause instanceof ApiError && cause.status === 404;
    accessDenied.value = cause instanceof ApiError && cause.status === 403;
    error.value = notFound.value || accessDenied.value ? "" : t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
async function loadSessions() {
  const version = ++sessionVersion;
  if (!repository.value?.canWrite || !repository.value.agentsEnabled || section.value !== "agents")
    return;
  sessionsLoading.value = true;
  sessionsError.value = "";
  try {
    const result = await api.repositorySessions(repository.value.id);
    if (version === sessionVersion) sessions.value = result;
  } catch {
    if (version === sessionVersion) sessionsError.value = t("apiError");
  } finally {
    if (version === sessionVersion) sessionsLoading.value = false;
  }
}
function sessionStatus(session: AgentSession) {
  return session.status === "active" && session.expiresAt <= Date.now()
    ? "expired"
    : session.status;
}
watch(() => [route.params.owner, route.params.repo], load, { immediate: true });
watch(() => [section.value, repository.value?.id], loadSessions);
watch(
  () => route.fullPath,
  () => {
    if (repository.value) void loadCounts(repository.value, loadVersion);
  }
);
</script>
<template>
  <section class="repo-page">
    <div v-if="loading || error" class="repository-access">
      <StatusState :loading="loading" :error="error" @retry="load" />
    </div>
    <div v-else-if="notFound" class="repository-access state">
      <AppIcon name="repo" :size="48" />
      <h1>{{ t("ghRepoMissingTitle") }}</h1>
      <p>{{ t("ghRepoMissingText") }}</p>
      <RouterLink class="btn" to="/dashboard">{{ t("ghBackHome") }}</RouterLink>
    </div>
    <div v-else-if="accessDenied" class="repository-access state">
      <AppIcon name="lock" :size="48" />
      <h1>{{ t("ghRepoAccessDeniedTitle") }}</h1>
      <p>{{ t("ghRepoAccessDeniedText") }}</p>
      <RouterLink class="btn" to="/dashboard">{{ t("ghBackHome") }}</RouterLink>
    </div>
    <template v-else-if="repository">
      <nav class="repository-nav" :aria-label="t('repositoryNav')">
        <RouterLink
          v-for="tab in tabs.filter(
            (tab) => (!tab.write || repository?.canWrite) && sectionEnabled(tab.key)
          )"
          :key="tab.key"
          :to="tab.key === 'code' ? base : `${base}/${tab.key}`"
          :class="{ selected: activeTab === tab.key }"
          :aria-current="activeTab === tab.key ? 'page' : undefined"
          ><AppIcon :name="tab.icon" />{{ t(tab.label)
          }}<span v-if="counts[tab.key] !== undefined && counts[tab.key] > 0" class="nav-count">{{
            counts[tab.key]
          }}</span></RouterLink
        >
      </nav>
      <div
        v-if="!['issues', 'pulls', 'discussions', 'wiki'].includes(section)"
        class="repository-heading"
      >
        <div class="repository-heading-inner">
          <AppIcon name="repo" :size="20" />
          <h1>
            <span class="repo-owner">{{ owner }} / </span>{{ repoName }}
          </h1>
          <StatusBadge
            ><AppIcon v-if="repository.visibility === 'private'" name="lock" :size="12" />{{
              t(repository.visibility)
            }}</StatusBadge
          >
          <div class="repository-heading-actions">
            <RouterLink
              v-if="repository.graphEnabled"
              class="btn btn-sm secondary-repo-action"
              :to="`${base}/commits`"
              ><AppIcon name="clock" />{{ t("commits") }}</RouterLink
            ><RouterLink
              v-if="repository.canWrite && repository.deploymentsEnabled && !repository.archived"
              class="btn btn-sm"
              :to="`${base}/deploy`"
              ><AppIcon name="cloud" />{{ t("deploy") }}</RouterLink
            >
          </div>
        </div>
      </div>
      <div class="repository-content">
        <NoticeBar v-if="repository.archived" intent="info">{{
          t("settingsRepositoryArchived")
        }}</NoticeBar>
        <div v-if="!sectionEnabled(section)" class="state">{{ t("settingsFeatureDisabled") }}</div>
        <RepositoryCode
          v-else-if="['code', 'commits', 'compare'].includes(section)"
          :repository="repository"
          :section="section"
          :graph-enabled="repository.graphEnabled"
          @changed="refreshCounts"
        />
        <template v-else-if="section === 'deploy' && repository.canWrite && !repository.archived"
          ><div class="repository-panel-head">
            <h2>{{ t("ghDeployTab") }}</h2>
            <p>{{ t("ghDeployDescription") }}</p>
          </div>
          <DeployWizard :repository="repository"
        /></template>
        <RepositoryActions
          v-else-if="section === 'actions' && repository.actionsEnabled"
          :repository-id="repository.id"
          :default-branch="repository.defaultBranch"
          :can-write="repository.canWrite"
          :archived="repository.archived"
          :actions-network-enabled="repository.actionsNetworkEnabled"
        />
        <template v-else-if="section === 'agents' && repository.canWrite"
          ><div class="page-head">
            <div>
              <h2>{{ t("agents") }}</h2>
              <p>{{ t("ghSessionsDescription") }}</p>
            </div>
            <RouterLink class="btn btn-primary" to="/settings/agents"
              ><AppIcon name="agent" />{{ t("ghManageAgents") }}</RouterLink
            >
          </div>
          <div class="box">
            <div class="box-header">
              <AppIcon name="branch" />{{ t("sessions")
              }}<span class="badge">{{ sessions.length }}</span
              ><button class="btn btn-sm" style="margin-left: auto" @click="loadSessions">
                {{ t("ghRefresh") }}
              </button>
            </div>
            <StatusState
              :loading="sessionsLoading"
              :error="sessionsError"
              :empty="!sessionsLoading && !sessions.length"
              @retry="loadSessions"
              ><template #empty
                ><AppIcon name="agent" :size="48" />
                <h3>{{ t("ghNoSessionsTitle") }}</h3>
                <p>{{ t("ghNoSessionsText") }}</p>
                <RouterLink class="btn btn-primary" to="/settings/agents?new=1">{{
                  t("ghNewAgent")
                }}</RouterLink></template
              ></StatusState
            >
            <table
              v-if="!sessionsLoading && !sessionsError && sessions.length"
              class="repo-session-table"
            >
              <thead>
                <tr>
                  <th>{{ t("ghSession") }}</th>
                  <th>{{ t("ghBranch") }}</th>
                  <th>{{ t("permission") }}</th>
                  <th>{{ t("expiresAt") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="session in sessions" :key="session.id">
                  <td>
                    <strong>{{ session.agentName }}</strong>
                    <p>
                      <StatusBadge
                        :tone="sessionStatus(session) === 'active' ? 'success' : 'neutral'"
                        >{{ t(sessionStatus(session)) }}</StatusBadge
                      >
                    </p>
                  </td>
                  <td>
                    <RouterLink
                      v-if="repository.graphEnabled"
                      :to="{ path: `${base}/commits`, query: { ref: session.baseRef } }"
                      ><AppIcon name="branch" />{{ session.baseRef }}</RouterLink
                    >
                  </td>
                  <td>{{ t(session.permission === "read" ? "ghReadOnly" : "ghReadWrite") }}</td>
                  <td class="muted">{{ d(session.expiresAt, "long") }}</td>
                </tr>
              </tbody>
            </table>
          </div></template
        >
        <RepositoryTasks
          v-else-if="section === 'tasks' && collaborationRepository"
          :repository="collaborationRepository"
        />
        <RepositorySettingsPanel
          v-else-if="section === 'settings' && repository.canWrite"
          :repository="repository"
          @updated="settingsUpdated"
        />
        <RepositoryCollaboration
          v-else-if="
            ['issues', 'pulls', 'discussions', 'wiki'].includes(section) && collaborationRepository
          "
          :repository="collaborationRepository"
          :section="section"
        />
        <div v-else class="state">
          <AppIcon name="lock" :size="32" />
          <p>{{ t("permissionDenied") }}</p>
          <RouterLink class="btn" :to="base">{{ t("ghViewCode") }}</RouterLink>
        </div>
      </div>
    </template>
  </section>
</template>
