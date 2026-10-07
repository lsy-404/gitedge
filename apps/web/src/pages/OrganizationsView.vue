<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, type Organization, errorMessage } from "../lib/api";
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
  } catch (cause) {
    error.value = errorMessage(cause, t);
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
      <nav :aria-label="t('organizations')">
        <RouterLink class="workspace-nav-item" to="/dashboard"
          ><AppIcon name="home" />{{ t("dashboard") }}</RouterLink
        >
        <RouterLink class="workspace-nav-item is-selected" to="/organizations"
          ><AppIcon name="organization" />{{ t("allOrganizations") }}</RouterLink
        >
      </nav>
      <div
        class="workspace-sidebar-group"
        role="group"
        aria-labelledby="organization-sidebar-title"
      >
        <div class="workspace-sidebar-heading">
          <p id="organization-sidebar-title" class="workspace-sidebar-title">
            {{ t("yourOrganizations") }}
          </p>
          <button
            class="btn btn-subtle btn-sm icon-button"
            type="button"
            :aria-label="t('newOrganization')"
            @click="router.replace({ path: '/organizations', query: { ...route.query, new: '1' } })"
          >
            <AppIcon name="plus" />
          </button>
        </div>
        <label class="workspace-search"
          ><AppIcon name="search" /><input
            v-model="filter"
            type="search"
            :placeholder="t('findOrganization')"
            :aria-label="t('findOrganization')"
        /></label>
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
      </div>
    </aside>

    <div class="organization-list-content">
      <header class="workspace-page-heading">
        <div>
          <h1>{{ t("yourOrganizations") }}</h1>
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
      <section class="box organization-directory">
        <div class="box-header workspace-panel-heading">
          <h2>
            {{ t("organizations") }} <StatusBadge>{{ visibleOrganizations.length }}</StatusBadge>
          </h2>
          <label class="workspace-search"
            ><AppIcon name="search" /><input
              v-model="filter"
              type="search"
              :placeholder="t('findOrganization')"
              :aria-label="t('findOrganization')"
          /></label>
        </div>
        <StatusState
          v-if="loading || error"
          :loading="loading"
          :error="error"
          :empty="false"
          @retry="load"
        />
        <div v-else-if="visibleOrganizations.length">
          <RouterLink
            v-for="organization in visibleOrganizations"
            :key="organization.slug"
            class="box-row organization-directory-row"
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
        <div v-else-if="organizations.length" class="settings-empty">
          {{ t("noMatchingOrganizations") }}
        </div>
        <div v-else class="dashboard-repo-onboarding organization-onboarding">
          <span class="onboarding-icon"><AppIcon name="organization" :size="24" /></span>
          <h3>{{ t("organizationEmpty") }}</h3>
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
    </div>

    <FluentDialog
      :open="showForm"
      :label="t('newOrganization')"
      close-on-outside
      @close="closeForm"
    >
      <template #title>
        <h2>{{ t("newOrganization") }}</h2>
      </template>
      <p class="muted">{{ t("organizationCreateHint") }}</p>
      <form class="form-stack" @submit.prevent="create">
        <TextField v-model="form.slug" required>{{ t("slug") }}</TextField>
        <TextField v-model="form.displayName" required>{{ t("displayName") }}</TextField>
        <TextAreaField v-model="form.description" rows="3" :label="t('description')" />
        <FormActions :saving="saving" :error="formError" @cancel="closeForm" />
      </form>
    </FluentDialog>
  </section>
</template>
