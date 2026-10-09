<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, type Organization, type Repository, errorMessage } from "../lib/api";
import { sessionState } from "../lib/session";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import TextField from "../components/TextField.vue";
import RepositoryImportDialog from "../components/RepositoryImportDialog.vue";
import { FluentCheckbox } from "@platform-kit/fluent/vue";
import { RepositorySlugSchema } from "../../../../packages/contracts/src/repository-controls";
import "../styles/workspace.css";

const visibilities = ["private", "public"] as const;
const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const repos = ref<Repository[]>([]);
const loading = ref(true);
const error = ref("");
const organizationsError = ref("");
let loadVersion = 0;
const showForm = ref(false);
const showImport = ref(false);
const ownerOptions = computed(() => [
  {
    value: sessionState.user?.identifier ?? "",
    label: `${sessionState.user?.identifier ?? ""} (${t("personal")})`,
  },
  ...organizations.value.map((organization) => ({
    value: organization.slug,
    label: organization.displayName,
  })),
]);
const saving = ref(false);
const formError = ref("");
const form = ref<{
  name: string;
  description: string;
  visibility: Repository["visibility"];
  initializeReadme: boolean;
}>({
  name: "",
  description: "",
  visibility: "private",
  initializeReadme: false,
});
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

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  organizationsError.value = "";
  const [repoResult, orgResult] = await Promise.allSettled([
    api.repositories(),
    api.organizations(),
  ]);
  if (version !== loadVersion) return;
  if (repoResult.status === "fulfilled") repos.value = repoResult.value;
  else error.value = errorMessage(repoResult.reason, t);
  if (orgResult.status === "fulfilled") organizations.value = orgResult.value;
  else {
    organizations.value = [];
    organizationsError.value = errorMessage(orgResult.reason, t);
  }
  owner.value = owner.value || sessionState.user?.identifier || "";
  loading.value = false;
}

async function createRepository() {
  const parsedName = RepositorySlugSchema.safeParse(form.value.name);
  if (!parsedName.success) {
    formError.value = t("repositoryNameInvalid");
    return;
  }
  saving.value = true;
  formError.value = "";
  try {
    await api.createRepository({ ...form.value, name: parsedName.data, owner: owner.value });
    form.value = { name: "", description: "", visibility: "private", initializeReadme: false };
    showForm.value = false;
    await router.replace({ path: route.path, query: { ...route.query, new: undefined } });
    await load();
  } catch (cause) {
    formError.value = errorMessage(cause, t, { 409: "nameTaken" });
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
      <nav :aria-label="t('dashboard')">
        <RouterLink class="workspace-nav-item is-selected" to="/dashboard">
          <AppIcon name="home" />{{ t("dashboardOverview") }}
        </RouterLink>
        <RouterLink class="workspace-nav-item" to="/organizations">
          <AppIcon name="organization" />{{ t("organizations") }}
        </RouterLink>
        <RouterLink class="workspace-nav-item" to="/settings/agents">
          <AppIcon name="agent" />{{ t("agents") }}
        </RouterLink>
      </nav>

      <div class="workspace-sidebar-group" role="group" aria-labelledby="dashboard-sidebar-title">
        <div class="workspace-sidebar-heading">
          <p id="dashboard-sidebar-title" class="workspace-sidebar-title">
            {{ t("repositories") }}
          </p>
          <button
            class="btn btn-subtle btn-sm icon-button"
            type="button"
            :aria-label="t('newRepo')"
            @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
          >
            <AppIcon name="plus" />
          </button>
        </div>
        <label class="workspace-search">
          <AppIcon name="search" />
          <input
            v-model="filter"
            type="search"
            :placeholder="t('findRepository')"
            :aria-label="t('findRepository')"
          />
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
            <span v-if="repo.visibility === 'private'" class="visually-hidden">{{
              t("private")
            }}</span>
          </RouterLink>
          <p v-if="!visibleRepos.length" class="sidebar-empty muted">
            {{ t("noMatchingRepositories") }}
          </p>
        </div>
      </div>
    </aside>

    <div class="dashboard-content">
      <header class="workspace-page-heading">
        <div>
          <h1>{{ t("welcomeBack", { name: sessionState.user?.identifier || "" }) }}</h1>
          <p class="muted">{{ t("dashboardIntro") }}</p>
        </div>
        <div class="workspace-heading-actions">
          <button class="btn" type="button" @click="showImport = true">
            <AppIcon name="repo" />{{ t("importRepository") }}
          </button>
          <button
            class="btn btn-primary"
            type="button"
            @click="router.replace({ path: '/dashboard', query: { ...route.query, new: '1' } })"
          >
            <AppIcon name="plus" />{{ t("newRepo") }}
          </button>
        </div>
      </header>

      <div class="dashboard-columns">
        <div class="dashboard-main-column">
          <section class="box">
            <div class="box-header workspace-panel-heading">
              <div>
                <h2>{{ t("recentRepositories") }}</h2>
                <p class="muted">{{ t("recentRepositoriesHint") }}</p>
              </div>
              <label class="workspace-search">
                <AppIcon name="search" />
                <input
                  v-model="filter"
                  type="search"
                  :placeholder="t('findRepository')"
                  :aria-label="t('findRepository')"
                />
              </label>
            </div>
            <StatusState
              v-if="loading || error"
              :loading="loading"
              :error="error"
              :empty="false"
              @retry="load"
            />
            <div v-else-if="repos.length">
              <RouterLink
                v-for="repo in recentRepos.filter((item) =>
                  visibleRepos.some((match) => match.id === item.id)
                )"
                :key="repo.id"
                class="box-row workspace-repository-row"
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
                      t("updatedOn", { date: d(repo.updatedAt, "short") })
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
              <h3>{{ t("noRepositoriesYet") }}</h3>
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
          <section class="box">
            <div class="box-header workspace-panel-heading">
              <div>
                <h2>{{ t("gettingStarted") }}</h2>
                <p class="muted">{{ t("gettingStartedHint") }}</p>
              </div>
            </div>
            <RouterLink class="box-row dashboard-action-row" to="/organizations">
              <span class="action-icon"><AppIcon name="organization" /></span>
              <span
                ><strong>{{ t("createOrganization") }}</strong
                ><small>{{ t("organizationActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
            <RouterLink class="box-row dashboard-action-row" to="/settings/agents">
              <span class="action-icon"><AppIcon name="agent" /></span>
              <span
                ><strong>{{ t("configureAgent") }}</strong
                ><small>{{ t("agentActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
            <RouterLink class="box-row dashboard-action-row" to="/settings/account">
              <span class="action-icon"><AppIcon name="gear" /></span>
              <span
                ><strong>{{ t("secureAccount") }}</strong
                ><small>{{ t("accountActionHint") }}</small></span
              >
              <AppIcon class="action-chevron" name="chevronRight" />
            </RouterLink>
          </section>
          <section class="box dashboard-organizations">
            <div class="box-header workspace-panel-heading">
              <h2>{{ t("yourOrganizations") }}</h2>
              <RouterLink to="/organizations">{{ t("viewAll") }}</RouterLink>
            </div>
            <StatusState
              v-if="loading || organizationsError"
              :loading="loading"
              :error="organizationsError"
              :empty="false"
              @retry="load"
            />
            <template v-else>
              <RouterLink
                v-for="organization in organizations.slice(0, 4)"
                :key="organization.slug"
                class="box-row organization-mini-row"
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
              <p v-if="!organizations.length" class="workspace-empty-inline">
                {{ t("noOrganizationsYet") }}
              </p>
            </template>
          </section>
        </aside>
      </div>
    </div>

    <FluentDialog :open="showForm" :label="t('newRepository')" close-on-outside @close="closeForm">
      <template #title>
        <h2>{{ t("newRepository") }}</h2>
      </template>
      <p class="muted">{{ t("repositoryOnboardingText") }}</p>
      <form class="form-stack" @submit.prevent="createRepository">
        <SelectField v-model="owner" :label="t('repositoryOwner')" required>
          <option :value="sessionState.user?.identifier">
            {{ sessionState.user?.identifier }} ({{ t("personal") }})
          </option>
          <option
            v-for="organization in organizations"
            :key="organization.slug"
            :value="organization.slug"
          >
            {{ organization.displayName }}
          </option>
        </SelectField>
        <TextField v-model="form.name" required>{{ t("repositoryName") }}</TextField>
        <TextField v-model="form.description">{{ t("description") }}</TextField>
        <SelectField
          :model-value="form.visibility"
          :label="t('visibility')"
          @update:model-value="form.visibility = oneOf(visibilities, $event, 'private')"
        >
          <option value="private">{{ t("private") }}</option>
          <option value="public">{{ t("public") }}</option>
        </SelectField>
        <FluentCheckbox v-model="form.initializeReadme">
          {{ t("repositoryInitializeReadme") }}
          <small>{{ t("repositoryInitializeReadmeHint") }}</small>
        </FluentCheckbox>
        <FormActions :saving="saving" :error="formError" @cancel="closeForm" />
      </form>
    </FluentDialog>

    <RepositoryImportDialog
      :open="showImport"
      :owners="ownerOptions"
      :default-owner="owner || sessionState.user?.identifier || ''"
      @close="showImport = false"
      @imported="load"
    />
  </section>
</template>
