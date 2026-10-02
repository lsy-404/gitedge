<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, type Organization } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";
import TextAreaField from "../components/TextAreaField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import "../styles/workspace.css";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const organizations = ref<Organization[]>([]);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const showForm = ref(false);
const saving = ref(false);
const filter = ref("");
const form = ref({ slug: "", displayName: "", description: "" });
const visibleOrganizations = computed(() => {
  const query = filter.value.trim().toLowerCase();
  return query
    ? organizations.value.filter((organization) =>
        `${organization.displayName} ${organization.slug}`.toLowerCase().includes(query)
      )
    : organizations.value;
});

async function load() {
  loading.value = true;
  error.value = "";
  try {
    organizations.value = await api.organizations();
  } catch {
    error.value = t("apiError");
  } finally {
    loading.value = false;
  }
}
async function create() {
  saving.value = true;
  formError.value = "";
  try {
    await api.createOrganization(form.value);
    form.value = { slug: "", displayName: "", description: "" };
    showForm.value = false;
    if (route.query.new)
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
  () => route.query.new,
  (value) => {
    showForm.value = value === "1";
  },
  { immediate: true }
);
onMounted(load);
</script>

<template>
  <section class="workspace-page organization-list-page">
    <aside class="workspace-sidebar organization-list-sidebar">
      <div class="workspace-sidebar-heading">
        <h1>{{ t("organizations") }}</h1>
        <button
          class="icon-button"
          type="button"
          :aria-label="t('newOrganization')"
          @click="router.replace({ path: '/organizations', query: { ...route.query, new: '1' } })"
        >
          <AppIcon name="plus" />
        </button>
      </div>
      <RouterLink class="workspace-nav-item" to="/dashboard"
        ><AppIcon name="home" />{{ t("dashboard") }}</RouterLink
      >
      <RouterLink class="workspace-nav-item is-selected" to="/organizations"
        ><AppIcon name="organization" />{{ t("allOrganizations") }}</RouterLink
      >
      <label class="workspace-search organization-search"
        ><AppIcon name="search" /><input
          v-model="filter"
          type="search"
          :placeholder="t('findOrganization')"
      /></label>
      <div class="organization-list-sidebar-title">{{ t("yourOrganizations") }}</div>
      <RouterLink
        v-for="organization in visibleOrganizations"
        :key="organization.slug"
        class="workspace-nav-item"
        :to="`/organizations/${organization.slug}`"
      >
        <span class="organization-sidebar-mark">{{
          organization.displayName.slice(0, 1).toUpperCase()
        }}</span
        ><span class="repo-nav-name">{{ organization.displayName }}</span>
      </RouterLink>
      <p v-if="!loading && !error && !visibleOrganizations.length" class="sidebar-empty muted">
        {{ t("noOrganizationsYet") }}
      </p>
    </aside>

    <main class="organization-list-content">
      <header class="workspace-page-heading">
        <div>
          <p class="workspace-eyebrow">{{ t("workspace") }}</p>
          <h2>{{ t("yourOrganizations") }}</h2>
          <p class="muted">{{ t("organizationListHint") }}</p>
        </div>
        <button
          class="btn btn-primary"
          type="button"
          @click="router.replace({ path: '/organizations', query: { ...route.query, new: '1' } })"
        >
          <AppIcon name="plus" />{{ t("newOrganization") }}
        </button>
      </header>
      <section class="workspace-panel organization-directory">
        <div class="workspace-panel-heading">
          <h3>
            {{ t("organizations") }} <StatusBadge>{{ visibleOrganizations.length }}</StatusBadge>
          </h3>
          <label class="workspace-search organization-inline-search"
            ><AppIcon name="search" /><input
              v-model="filter"
              type="search"
              :placeholder="t('findOrganization')"
          /></label>
        </div>
        <StatusState
          v-if="loading || error"
          :loading="loading"
          :error="error"
          :empty="false"
          @retry="load"
        />
        <div v-else-if="visibleOrganizations.length" class="organization-directory-list">
          <RouterLink
            v-for="organization in visibleOrganizations"
            :key="organization.slug"
            class="organization-directory-row"
            :to="`/organizations/${organization.slug}`"
          >
            <span class="organization-directory-mark">{{
              organization.displayName.slice(0, 1).toUpperCase()
            }}</span>
            <span class="organization-directory-copy"
              ><strong>{{ organization.displayName }}</strong
              ><small>{{ organization.slug }}</small
              ><span>{{ organization.description || t("noDescription") }}</span></span
            >
            <AppIcon name="chevronRight" />
          </RouterLink>
        </div>
        <div v-else-if="organizations.length" class="settings-empty-state">
          {{ t("noMatchingOrganizations") }}
        </div>
        <div v-else class="dashboard-repo-onboarding organization-onboarding">
          <span class="onboarding-icon"><AppIcon name="organization" :size="24" /></span>
          <h4>{{ t("organizationEmpty") }}</h4>
          <p class="muted">{{ t("organizationOnboardingHint") }}</p>
          <button
            class="btn btn-primary"
            type="button"
            @click="router.replace({ path: '/organizations', query: { ...route.query, new: '1' } })"
          >
            <AppIcon name="plus" />{{ t("newOrganization") }}
          </button>
        </div>
      </section>
    </main>

    <div v-if="showForm" class="workspace-modal-backdrop" @click.self="closeForm">
      <section
        class="workspace-modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="'new-organization-title'"
      >
        <header class="workspace-modal-heading">
          <h2 id="new-organization-title">{{ t("newOrganization") }}</h2>
          <button class="icon-button" type="button" :aria-label="t('close')" @click="closeForm">
            <AppIcon name="close" />
          </button>
        </header>
        <p class="muted">{{ t("organizationCreateHint") }}</p>
        <form class="form-stack" @submit.prevent="create">
          <TextField v-model="form.slug" required>{{ t("slug") }}</TextField>
          <TextField v-model="form.displayName" required>{{ t("displayName") }}</TextField>
          <TextAreaField v-model="form.description" rows="3" :label="t('description')" />
          <FormActions :saving="saving" :error="formError" @cancel="closeForm" />
        </form>
      </section>
    </div>
  </section>
</template>
