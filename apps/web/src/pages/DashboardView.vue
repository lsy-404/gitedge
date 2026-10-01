<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { api, type Organization, type Repository } from "../lib/api";
import { sessionState } from "../lib/session";
import FormActions from "../components/FormActions.vue";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";

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
      <button class="btn primary" @click="showForm = !showForm">
        <AppIcon name="plus" />{{ t("newRepo") }}
      </button>
    </div>
    <form v-if="showForm" class="box box-form form-stack" @submit.prevent="createRepository">
      <label class="field"
        >{{ t("repositoryOwner")
        }}<select v-model="owner" required>
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
        </select></label
      >
      <label class="field">{{ t("repositoryName") }}<input v-model="form.name" required /></label>
      <label class="field">{{ t("description") }}<input v-model="form.description" /></label>
      <label class="field"
        >{{ t("visibility")
        }}<select v-model="form.visibility">
          <option value="private">{{ t("private") }}</option>
          <option value="public">{{ t("public") }}</option>
        </select></label
      >
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <div v-if="!loading && !error && repos.length" class="toolbar">
      <input
        v-model="filter"
        class="search"
        type="search"
        :placeholder="t('findRepository')"
        :aria-label="t('findRepository')"
      />
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
              <span class="pill">{{
                repo.visibility === "private" ? t("private") : t("public")
              }}</span>
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
