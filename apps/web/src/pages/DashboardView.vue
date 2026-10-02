<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, type Organization, type Repository } from "../lib/api";
import { sessionState } from "../lib/session";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import TextField from "../components/TextField.vue";
import "../styles/workspace.css";

const visibilities = ["private", "public"] as const;
const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const repos = ref<Repository[]>([]);
const loading = ref(true);
const error = ref("");
const showForm = ref(false);
const saving = ref(false);
const formError = ref("");
const form = ref({ name: "", description: "", visibility: "private" as "public" | "private" });
const organizations = ref<Organization[]>([]);
const owner = ref("");
const filter = ref(typeof route.query.q === "string" ? route.query.q : "");
const visibleRepos = computed(() => {
  const query = filter.value.trim().toLowerCase();
  if (!query) return repos.value;
  return repos.value.filter((repo) =>
    `${repo.owner}/${repo.name} ${repo.description || ""}`.toLowerCase().includes(query)
  );
});
const recentRepos = computed(() => [...repos.value].sort((a, b) => b.updatedAt - a.updatedAt));

function formatUpdatedAt(value: number): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(value);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    repos.value = await api.repositories();
    organizations.value = await api.organizations();
    owner.value = owner.value || sessionState.user?.identifier || "";
  } catch {
    error.value = t("apiError");
  } finally {
    loading.value = false;
  }
}

async function createRepository() {
  saving.value = true;
  formError.value = "";
  try {
    await api.createRepository({ ...form.value, owner: owner.value });
    form.value = { name: "", description: "", visibility: "private" };
    showForm.value = false;
    await router.replace({ path: route.path, query: { ...route.query, new: undefined } });
    await load();
  } catch {
    formError.value = t("apiError");
  } finally {
    saving.value = false;
  }
}

function closeForm() {
  showForm.value = false;
  if (route.query.new)
    void router.replace({ path: route.path, query: { ...route.query, new: undefined } });
}

watch(
  () => route.query.q,
  (query) => {
    filter.value = typeof query === "string" ? query : "";
  }
);
watch(filter, (query) => {
  const normalized = query.trim();
  if (normalized === (typeof route.query.q === "string" ? route.query.q : "")) return;
  void router.replace({ path: route.path, query: { ...route.query, q: normalized || undefined } });
});
watch(
  () => route.query.new,
  (value) => {
    showForm.value = value === "1";
  },
  { immediate: true }
);

onMounted(load);
</script>

<template>
  <section class="workspace-page dashboard-page">
    <aside class="workspace-sidebar dashboard-sidebar">
      <div class="workspace-sidebar-heading">
        <h1>{{ t("dashboard") }}</h1>
        <RouterLink class="icon-button" to="/organizations" :aria-label="t('organizations')">
          <AppIcon name="organization" />
        </RouterLink>
      </div>
      <RouterLink class="workspace-nav-item is-selected" to="/dashboard">
        <AppIcon name="home" />{{ t("dashboardOverview") }}
      </RouterLink>
      <RouterLink class="workspace-nav-item" to="/organizations">
        <AppIcon name="organization" />{{ t("organizations") }}
      </RouterLink>
      <RouterLink class="workspace-nav-item" to="/settings/agents">
        <AppIcon name="agent" />{{ t("agents") }}
      </RouterLink>

      <div class="workspace-sidebar-heading repo-sidebar-title">
        <h2>{{ t("repositories") }}</h2>
        <button
          class="icon-button"
          type="button"
          :aria-label="t('newRepo')"
          @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
        >
          <AppIcon name="plus" />
        </button>
      </div>
      <label class="workspace-search">
        <AppIcon name="search" />
        <input v-model="filter" type="search" :placeholder="t('findRepository')" />
      </label>
      <StatusState
        v-if="loading || error"
        :loading="loading"
        :error="error"
        :empty="false"
        @retry="load"
      />
      <div v-else class="dashboard-repo-nav">
        <RouterLink
          v-for="repo in visibleRepos"
          :key="repo.id"
          class="workspace-nav-item repo-nav-item"
          :to="`/${repo.owner}/${repo.name}`"
        >
          <span class="repo-dot"><AppIcon name="repo" /></span>
          <span class="repo-nav-name">{{ repo.owner }}/{{ repo.name }}</span>
          <span v-if="repo.visibility === 'private'" class="sr-only">{{ t("private") }}</span>
        </RouterLink>
        <p v-if="!visibleRepos.length" class="sidebar-empty muted">
          {{ t("noMatchingRepositories") }}
        </p>
      </div>
      <button
        class="workspace-nav-item sidebar-create"
        type="button"
        @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
      >
        <AppIcon name="plus" />{{ t("newRepo") }}
      </button>
    </aside>

    <div class="dashboard-content">
      <header class="workspace-page-heading">
        <div>
          <p class="workspace-eyebrow">{{ t("dashboard") }}</p>
          <h2>{{ t("welcomeBack", { name: sessionState.user?.identifier || "" }) }}</h2>
          <p class="muted">{{ t("dashboardIntro") }}</p>
        </div>
        <button
          class="btn btn-primary"
          type="button"
          @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
        >
          <AppIcon name="plus" />{{ t("newRepo") }}
        </button>
      </header>

      <div class="dashboard-columns">
        <div class="dashboard-main-column">
          <section class="workspace-panel">
            <div class="workspace-panel-heading">
              <div>
                <h3>{{ t("recentRepositories") }}</h3>
                <p class="muted">{{ t("recentRepositoriesHint") }}</p>
              </div>
              <label class="workspace-search dashboard-list-search">
                <AppIcon name="search" />
                <input v-model="filter" type="search" :placeholder="t('findRepository')" />
              </label>
            </div>
            <StatusState
              v-if="loading || error"
              :loading="loading"
              :error="error"
              :empty="false"
              @retry="load"
            />
            <div v-else-if="repos.length" class="workspace-repository-list">
              <RouterLink
                v-for="repo in recentRepos.filter((item) =>
                  visibleRepos.some((match) => match.id === item.id)
                )"
                :key="repo.id"
                class="workspace-repository-row"
                :to="`/${repo.owner}/${repo.name}`"
              >
                <div class="repository-row-main">
                  <AppIcon name="repo" />
                  <div class="repository-row-copy">
                    <span class="repository-name">{{ repo.owner }} / {{ repo.name }}</span>
                    <span class="repository-description">{{
                      repo.description || t("noDescription")
                    }}</span>
                    <span class="repository-updated">{{
                      t("updatedOn", { date: formatUpdatedAt(repo.updatedAt) })
                    }}</span>
                  </div>
                </div>
                <StatusBadge>{{
                  repo.visibility === "private" ? t("private") : t("public")
                }}</StatusBadge>
              </RouterLink>
              <p
                v-if="
                  !recentRepos.some((item) => visibleRepos.some((match) => match.id === item.id))
                "
                class="workspace-empty-inline"
              >
                {{ t("noMatchingRepositories") }}
              </p>
            </div>
            <div v-else class="dashboard-repo-onboarding">
              <span class="onboarding-icon"><AppIcon name="repo" :size="24" /></span>
              <h4>{{ t("noRepositoriesYet") }}</h4>
              <p class="muted">{{ t("repositoryOnboardingText") }}</p>
              <button
                class="btn btn-primary"
                type="button"
                @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
              >
                <AppIcon name="plus" />{{ t("createFirstRepository") }}
              </button>
              <div class="onboarding-git-help">
                <strong>{{ t("haveExistingGitRepository") }}</strong>
                <p>{{ t("existingGitRepositoryHint") }}</p>
                <code>git remote add origin &lt;repository-url&gt;</code>
                <code>git push -u origin HEAD</code>
              </div>
            </div>
          </section>
        </div>

        <aside class="dashboard-right-column">
          <section class="workspace-panel getting-started-panel">
            <div class="workspace-panel-heading">
              <div>
                <h3>{{ t("gettingStarted") }}</h3>
                <p class="muted">{{ t("gettingStartedHint") }}</p>
              </div>
            </div>
            <RouterLink class="dashboard-action-row" to="/organizations">
              <span class="action-icon"><AppIcon name="organization" /></span>
              <span
                ><strong>{{ t("createOrganization") }}</strong
                ><small>{{ t("organizationActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
            <RouterLink class="dashboard-action-row" to="/settings/agents">
              <span class="action-icon"><AppIcon name="agent" /></span>
              <span
                ><strong>{{ t("configureAgent") }}</strong
                ><small>{{ t("agentActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
            <RouterLink class="dashboard-action-row" to="/settings/account">
              <span class="action-icon"><AppIcon name="gear" /></span>
              <span
                ><strong>{{ t("secureAccount") }}</strong
                ><small>{{ t("accountActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
          </section>
          <section class="workspace-panel dashboard-organizations">
            <div class="workspace-panel-heading">
              <h3>{{ t("yourOrganizations") }}</h3>
              <RouterLink to="/organizations">{{ t("viewAll") }}</RouterLink>
            </div>
            <StatusState
              v-if="loading || error"
              :loading="loading"
              :error="error"
              :empty="false"
              @retry="load"
            />
            <template v-else>
              <RouterLink
                v-for="organization in organizations.slice(0, 4)"
                :key="organization.slug"
                class="organization-mini-row"
                :to="`/organizations/${organization.slug}`"
              >
                <span class="organization-mark">{{
                  organization.displayName.slice(0, 1).toUpperCase()
                }}</span>
                <span
                  ><strong>{{ organization.displayName }}</strong
                  ><small>{{ organization.slug }}</small></span
                >
              </RouterLink>
              <p v-if="!organizations.length" class="sidebar-empty muted">
                {{ t("noOrganizationsYet") }}
              </p>
            </template>
          </section>
        </aside>
      </div>
    </div>

    <div v-if="showForm" class="workspace-modal-backdrop" @click.self="closeForm">
      <section
        class="workspace-modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="'new-repository-title'"
      >
        <header class="workspace-modal-heading">
          <h2 id="new-repository-title">{{ t("newRepository") }}</h2>
          <button class="icon-button" type="button" :aria-label="t('close')" @click="closeForm">
            <AppIcon name="close" />
          </button>
        </header>
        <p class="muted">{{ t("repositoryOnboardingText") }}</p>
        <form class="form-stack" @submit.prevent="createRepository">
          <SelectField v-model="owner" :label="t('repositoryOwner')" required>
            <fluent-option :value="sessionState.user?.identifier"
              >{{ sessionState.user?.identifier }} ({{ t("personal") }})</fluent-option
            >
            <fluent-option
              v-for="organization in organizations"
              :key="organization.slug"
              :value="organization.slug"
              >{{ organization.displayName }}</fluent-option
            >
          </SelectField>
          <TextField v-model="form.name" required>{{ t("repositoryName") }}</TextField>
          <TextField v-model="form.description">{{ t("description") }}</TextField>
          <SelectField
            :model-value="form.visibility"
            :label="t('visibility')"
            @update:model-value="form.visibility = oneOf(visibilities, $event, 'private')"
          >
            <fluent-option value="private">{{ t("private") }}</fluent-option
            ><fluent-option value="public">{{ t("public") }}</fluent-option>
          </SelectField>
          <FormActions :saving="saving" :error="formError" @cancel="closeForm" />
        </form>
      </section>
    </div>
  </section>
</template>
