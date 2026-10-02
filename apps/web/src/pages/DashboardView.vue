<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, type Organization, type Repository } from "../lib/api";
import { sessionState } from "../lib/session";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";
import SelectField from "../components/SelectField.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { oneOf } from "../ui/formEvents";
import TextField from "../components/TextField.vue";

const visibilities = ["private", "public"] as const;
const { t, locale } = useI18n();
const repos = ref<Repository[]>([]);
const loading = ref(true);
const error = ref("");
const showForm = ref(false);
const saving = ref(false);
const formError = ref("");
const form = ref({ name: "", description: "", visibility: "private" as "public" | "private" });
const organizations = ref<Organization[]>([]);
const owner = ref("");
const filter = ref("");
const visibleRepos = computed(() => {
  const query = filter.value.trim().toLowerCase();
  if (!query) return repos.value;
  return repos.value.filter((repo) => `${repo.owner}/${repo.name}`.toLowerCase().includes(query));
});

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
      <h1>{{ t("repositories") }}</h1>
      <fluent-button type="button" appearance="primary" @click="showForm = !showForm">
        <AppIcon slot="start" name="plus" />{{ t("newRepo") }}
      </fluent-button>
    </div>
    <form v-if="showForm" class="box box-form form-stack" @submit.prevent="createRepository">
      <SelectField v-model="owner" :label="t('repositoryOwner')" required>
        <fluent-option :value="sessionState.user?.identifier">
          {{ sessionState.user?.identifier }} ({{ t("personal") }})
        </fluent-option>
        <fluent-option
          v-for="organization in organizations"
          :key="organization.slug"
          :value="organization.slug"
        >
          {{ organization.displayName }}
        </fluent-option>
      </SelectField>
      <TextField v-model="form.name" required>{{ t("repositoryName") }}</TextField>
      <TextField v-model="form.description">{{ t("description") }}</TextField>
      <SelectField
        :model-value="form.visibility"
        :label="t('visibility')"
        @update:model-value="form.visibility = oneOf(visibilities, $event, 'private')"
      >
        <fluent-option value="private">{{ t("private") }}</fluent-option>
        <fluent-option value="public">{{ t("public") }}</fluent-option>
      </SelectField>
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <div v-if="!loading && !error && repos.length" class="toolbar">
      <TextField v-model="filter" type="search" :placeholder="t('findRepository')">
        <AppIcon slot="start" name="search" />
        <span class="visually-hidden">{{ t("findRepository") }}</span>
      </TextField>
    </div>
    <div class="box">
      <StatusState
        :loading="loading"
        :error="error"
        :empty="!loading && !error && !visibleRepos.length"
        @retry="load"
      />
      <template v-if="!loading && !error">
        <RouterLink
          v-for="repo in visibleRepos"
          :key="repo.id"
          class="box-row"
          :to="`/${repo.owner}/${repo.name}`"
        >
          <AppIcon class="state-icon" name="repo" />
          <div class="grow">
            <div class="row-title">
              {{ repo.owner }} / {{ repo.name }}
              <StatusBadge>{{
                repo.visibility === "private" ? t("private") : t("public")
              }}</StatusBadge>
            </div>
            <p class="muted">{{ repo.description || t("noDescription") }}</p>
            <div class="row-meta">
              <span class="mono">{{ repo.defaultBranch }}</span>
              <span>{{ t("updatedOn", { date: formatUpdatedAt(repo.updatedAt) }) }}</span>
            </div>
          </div>
        </RouterLink>
      </template>
    </div>
  </section>
</template>
