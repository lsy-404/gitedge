<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, type Organization } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
const { t } = useI18n();
const organizations = ref<Organization[]>([]);
const loading = ref(true);
const error = ref("");
const formError = ref("");
const showForm = ref(false);
const saving = ref(false);
const form = ref({ slug: "", displayName: "", description: "" });
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
    await load();
  } catch {
    formError.value = t("apiError");
  } finally {
    saving.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="page">
    <div class="page-head">
      <h1>{{ t("organizations") }}</h1>
      <button class="btn primary" @click="showForm = !showForm">
        <AppIcon name="plus" />{{ t("newOrganization") }}
      </button>
    </div>
    <form v-if="showForm" class="box box-form form-stack" @submit.prevent="create">
      <label class="field">{{ t("slug") }}<input v-model="form.slug" required /></label>
      <label class="field"
        >{{ t("displayName") }}<input v-model="form.displayName" required
      /></label>
      <label class="field"
        >{{ t("description") }}<textarea v-model="form.description" rows="3" />
      </label>
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <div class="box">
      <StatusState
        :loading="loading"
        :error="error"
        :empty="!loading && !error && !organizations.length"
        @retry="load"
      />
      <template v-if="!loading && !error">
        <RouterLink
          v-for="organization in organizations"
          :key="organization.slug"
          class="box-row"
          :to="`/organizations/${organization.slug}`"
        >
          <div class="grow">
            <div class="row-title">{{ organization.displayName }}</div>
            <p class="muted">{{ organization.description || t("noDescription") }}</p>
          </div>
        </RouterLink>
      </template>
    </div>
  </section>
</template>
