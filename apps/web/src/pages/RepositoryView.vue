<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { AgentSession, Repository } from "../lib/api";
import { ApiError, api } from "../lib/api";
import { sessionState } from "../lib/session";
import AppIcon, { type IconName } from "../components/AppIcon.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import DeployWizard from "../components/DeployWizard.vue";
import RepositoryCode from "../components/RepositoryCode.vue";
import RepositoryCollaboration from "../components/RepositoryCollaboration.vue";
const route = useRoute();
const { t, locale } = useI18n();
const owner = computed(() => String(route.params.owner));
const repoName = computed(() => String(route.params.repo));
const base = computed(() => `/${owner.value}/${repoName.value}`);
const section = computed(() =>
  route.params.view ? "code" : String(route.params.section || route.path.split("/")[3] || "code")
);
const activeTab = computed(() =>
  ["commits", "compare"].includes(section.value) ? "code" : section.value
);
const tabs: { key: string; label: string; icon: IconName; write?: boolean }[] = [
  { key: "code", label: "code", icon: "code" },
  { key: "issues", label: "issues", icon: "issue" },
  { key: "pulls", label: "pulls", icon: "pr" },
  { key: "agents", label: "agents", icon: "agent", write: true },
  { key: "discussions", label: "discussions", icon: "discussion" },
  { key: "wiki", label: "wiki", icon: "wiki" },
  { key: "deploy", label: "ghDeployTab", icon: "cloud", write: true },
  { key: "settings", label: "ghSettings", icon: "gear", write: true },
];
const repository = ref<Repository | null>(null);
const loading = ref(true);
const error = ref("");
const notFound = ref(false);
const counts = ref<Record<string, number>>({});
const sessions = ref<AgentSession[]>([]);
const sessionsLoading = ref(false);
const sessionsError = ref("");
let loadVersion = 0;
let sessionVersion = 0;
async function loadCounts(id: string, version: number) {
  const [issues, pulls, discussions] = await Promise.allSettled([
    api.issues(id),
    api.pulls(id),
    api.discussions(id),
  ]);
  if (version !== loadVersion) return;
  counts.value = {
    ...(issues.status === "fulfilled"
      ? { issues: issues.value.filter((item) => item.state === "open").length }
      : {}),
    ...(pulls.status === "fulfilled"
      ? { pulls: pulls.value.filter((item) => item.state === "open").length }
      : {}),
    ...(discussions.status === "fulfilled" ? { discussions: discussions.value.length } : {}),
  };
}
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  repository.value = null;
  counts.value = {};
  try {
    const result = await api.repository(owner.value, repoName.value);
    if (version !== loadVersion) return;
    repository.value = result;
    void loadCounts(result.id, version);
  } catch (cause) {
    if (version !== loadVersion) return;
    notFound.value = cause instanceof ApiError && cause.status === 404;
    error.value = notFound.value ? "" : t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
async function loadSessions() {
  const version = ++sessionVersion;
  if (!repository.value?.canWrite || section.value !== "agents") return;
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
function formatDate(value: number) {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(
    value
  );
}
watch(() => [route.params.owner, route.params.repo], load, { immediate: true });
watch(() => [section.value, repository.value?.id], loadSessions);
watch(
  () => route.fullPath,
  () => {
    if (repository.value) void loadCounts(repository.value.id, loadVersion);
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
    <template v-else-if="repository">
      <nav class="repository-nav" :aria-label="t('repositoryNav')">
        <RouterLink
          v-for="tab in tabs.filter((tab) => !tab.write || repository?.canWrite)"
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
      <div class="repository-heading">
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
            <RouterLink class="btn btn-sm secondary-repo-action" :to="`${base}/commits`"
              ><AppIcon name="clock" />{{ t("commits") }}</RouterLink
            ><RouterLink v-if="repository.canWrite" class="btn btn-sm" :to="`${base}/deploy`"
              ><AppIcon name="cloud" />{{ t("deploy") }}</RouterLink
            >
          </div>
        </div>
      </div>
      <div class="repository-content">
        <RepositoryCode
          v-if="['code', 'commits', 'compare'].includes(section)"
          :repository="repository"
          :section="section"
        />
        <template v-else-if="section === 'deploy' && repository.canWrite"
          ><div class="repository-panel-head">
            <h2>{{ t("ghDeployTab") }}</h2>
            <p>{{ t("ghDeployDescription") }}</p>
          </div>
          <DeployWizard :repository="repository"
        /></template>
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
                    <RouterLink :to="{ path: `${base}/commits`, query: { ref: session.baseRef } }"
                      ><AppIcon name="branch" />{{ session.baseRef }}</RouterLink
                    >
                  </td>
                  <td>{{ t(session.permission === "read" ? "ghReadOnly" : "ghReadWrite") }}</td>
                  <td class="muted">{{ formatDate(session.expiresAt) }}</td>
                </tr>
              </tbody>
            </table>
          </div></template
        >
        <template v-else-if="section === 'settings' && repository.canWrite"
          ><div class="repository-panel-head">
            <h2>{{ t("ghRepoSettings") }}</h2>
          </div>
          <div class="repo-settings-grid">
            <section class="box">
              <h3>{{ t("ghGeneral") }}</h3>
              <label class="muted">{{ t("repositoryName") }}</label>
              <p>
                <strong>{{ repoName }}</strong>
              </p>
              <label class="muted">{{ t("ghDefaultBranch") }}</label>
              <p><AppIcon name="branch" /> {{ repository.defaultBranch }}</p>
            </section>
            <section class="box">
              <h3>{{ t("ghRepoAccess") }}</h3>
              <StatusBadge>{{ t(repository.visibility) }}</StatusBadge>
              <p>
                {{ t(repository.visibility === "private" ? "ghPrivateAccess" : "ghPublicAccess") }}
              </p>
              <RouterLink
                class="btn"
                :to="
                  owner === sessionState.user?.identifier
                    ? '/settings/account'
                    : `/organizations/${owner}`
                "
                >{{ t("ghManageAccess") }}</RouterLink
              >
            </section>
            <section class="box">
              <h3>{{ t("ghRepoTools") }}</h3>
              <p>{{ t("ghRepoToolsText") }}</p>
              <div class="toolbar">
                <RouterLink class="btn" :to="base"
                  ><AppIcon name="code" />{{ t("ghViewCode") }}</RouterLink
                ><RouterLink class="btn" :to="`${base}/agents`"
                  ><AppIcon name="agent" />{{ t("agents") }}</RouterLink
                >
              </div>
            </section>
          </div></template
        >
        <RepositoryCollaboration
          v-else-if="['issues', 'pulls', 'discussions', 'wiki'].includes(section)"
          :repository="repository"
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
