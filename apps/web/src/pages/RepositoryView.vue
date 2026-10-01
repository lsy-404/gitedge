<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { api, type Issue, type PullRequest, type Repository, type WikiPage } from "../lib/api";
import StatusState from "../components/StatusState.vue";
import FormActions from "../components/FormActions.vue";
import { sessionState } from "../lib/session";

const route = useRoute();
const { t } = useI18n();
const owner = computed(() => String(route.params.owner));
const repoName = computed(() => String(route.params.repo));
const section = computed(() => String(route.params.section || "code"));
const repository = ref<Repository | null>(null);
const issues = ref<Issue[]>([]);
const pulls = ref<PullRequest[]>([]);
const wiki = ref<WikiPage[]>([]);
const canWrite = ref(false);
const loading = ref(true);
const error = ref("");
const showForm = ref(false);
const saving = ref(false);
const formError = ref("");
const issueForm = ref({ title: "", body: "" });
const pullForm = ref({ title: "", body: "", head: "", base: "main" });
const wikiForm = ref({ slug: "", title: "", body: "" });

async function load() {
  loading.value = true;
  error.value = "";
  canWrite.value = false;
  try {
    if (sessionState.user) {
      const repositories = await api.repositories();
      repository.value =
        repositories.find((item) => item.owner === owner.value && item.name === repoName.value) ||
        null;
      canWrite.value = repository.value !== null;
    }
    if (!repository.value)
      repository.value = await api.publicRepository(owner.value, repoName.value);
    if (!repository.value) throw new Error("not-found");
    if (section.value === "issues") {
      issues.value = canWrite.value
        ? await api.issues(repository.value.id)
        : await api.publicIssues(owner.value, repoName.value);
    }
    if (section.value === "pulls") {
      pulls.value = canWrite.value
        ? await api.pulls(repository.value.id)
        : await api.publicPulls(owner.value, repoName.value);
    }
    if (section.value === "wiki") {
      wiki.value = canWrite.value
        ? await api.wiki(repository.value.id)
        : await api.publicWiki(owner.value, repoName.value);
    }
  } catch {
    error.value = t("apiError");
  } finally {
    loading.value = false;
  }
}

async function createIssue() {
  if (!repository.value) return;
  await submit(
    async () => api.createIssue(repository.value!.id, issueForm.value),
    () => {
      issueForm.value = { title: "", body: "" };
    }
  );
}

async function createPullRequest() {
  if (!repository.value) return;
  await submit(
    async () => api.createPullRequest(repository.value!.id, pullForm.value),
    () => {
      pullForm.value = { title: "", body: "", head: "", base: "main" };
    }
  );
}

async function createWikiPage() {
  if (!repository.value) return;
  await submit(
    async () => api.createWikiPage(repository.value!.id, wikiForm.value),
    () => {
      wikiForm.value = { slug: "", title: "", body: "" };
    }
  );
}

async function submit(action: () => Promise<unknown>, reset: () => void) {
  saving.value = true;
  formError.value = "";
  try {
    await action();
    reset();
    showForm.value = false;
    await load();
  } catch {
    formError.value = t("apiError");
  } finally {
    saving.value = false;
  }
}

watch(() => [route.params.owner, route.params.repo, route.params.section], load, {
  immediate: true,
});
</script>

<template>
  <section class="page repo-page">
    <RouterLink class="back-link" to="/dashboard">← {{ t("back") }}</RouterLink>
    <div class="repo-title">
      <div class="repo-icon large">{{ repoName.slice(0, 1).toUpperCase() }}</div>
      <div>
        <p class="eyebrow">{{ owner }} / {{ t("repository") }}</p>
        <h1>{{ repoName }}</h1>
        <p class="muted">{{ repository?.description || t("noDescription") }}</p>
      </div>
    </div>
    <nav class="repo-tabs" :aria-label="t('repositoryNav')">
      <RouterLink :class="{ active: section === 'code' }" :to="`/${owner}/${repoName}`">{{
        t("code")
      }}</RouterLink>
      <RouterLink :class="{ active: section === 'issues' }" :to="`/${owner}/${repoName}/issues`"
        >{{ t("issues") }}
        <small v-if="section === 'issues' && !loading">{{ issues.length }}</small></RouterLink
      >
      <RouterLink :class="{ active: section === 'pulls' }" :to="`/${owner}/${repoName}/pulls`"
        >{{ t("pulls") }}
        <small v-if="section === 'pulls' && !loading">{{ pulls.length }}</small></RouterLink
      >
      <RouterLink :class="{ active: section === 'wiki' }" :to="`/${owner}/${repoName}/wiki`">{{
        t("wiki")
      }}</RouterLink>
    </nav>
    <div v-if="!loading && !error && canWrite && section !== 'code'" class="section-actions">
      <button class="button primary" @click="showForm = !showForm">
        +
        {{
          section === "issues"
            ? t("createIssue")
            : section === "pulls"
              ? t("createPull")
              : t("createWiki")
        }}
      </button>
    </div>
    <form
      v-if="showForm && section === 'issues'"
      class="panel create-form"
      @submit.prevent="createIssue"
    >
      <label>{{ t("issueTitle") }}<input v-model="issueForm.title" required /></label
      ><label>{{ t("issueBody") }}<textarea v-model="issueForm.body" rows="4" /></label
      ><FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <form
      v-if="showForm && section === 'pulls'"
      class="panel create-form"
      @submit.prevent="createPullRequest"
    >
      <label>{{ t("issueTitle") }}<input v-model="pullForm.title" required /></label
      ><label>{{ t("issueBody") }}<textarea v-model="pullForm.body" rows="4" /></label
      ><label>{{ t("headBranch") }}<input v-model="pullForm.head" required /></label
      ><label>{{ t("baseBranch") }}<input v-model="pullForm.base" required /></label
      ><FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <form
      v-if="showForm && section === 'wiki'"
      class="panel create-form"
      @submit.prevent="createWikiPage"
    >
      <label>{{ t("slug") }}<input v-model="wikiForm.slug" required /></label
      ><label>{{ t("pageTitle") }}<input v-model="wikiForm.title" required /></label
      ><label>{{ t("pageBody") }}<textarea v-model="wikiForm.body" rows="6" required /></label
      ><FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <div class="content-card">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" /><template
        v-if="!loading && !error && section === 'code'"
        ><div class="code-toolbar">
          <code>{{ repository?.defaultBranch || "main" }}</code
          ><span
            >{{ t("cloneUrl") }}:
            <code>{{
              `/${repository?.owner || owner}/${repository?.name || repoName}.git`
            }}</code></span
          >
        </div>
        <div class="state">
          <div>
            <strong>{{ t("noCode") }}</strong>
            <p class="muted">{{ t("pushFirst") }}</p>
          </div>
        </div></template
      ><template v-else-if="!loading && !error && section === 'issues'"
        ><div v-for="issue in issues" :key="issue.number" class="item-row">
          <span class="number">#{{ issue.number }}</span
          ><strong>{{ issue.title }}</strong
          ><span :class="['badge', issue.state]">{{ t(issue.state) }}</span
          ><small>{{ issue.author }}</small>
        </div>
        <div v-if="!issues.length" class="state">{{ t("empty") }}</div></template
      ><template v-else-if="!loading && !error && section === 'pulls'"
        ><div v-for="pull in pulls" :key="pull.number" class="item-row">
          <span class="number">#{{ pull.number }}</span
          ><strong>{{ pull.title }}</strong
          ><span :class="['badge', pull.state]">{{ t(pull.state) }}</span
          ><small>{{ pull.headRef }} → {{ pull.baseRef }}</small>
        </div>
        <div v-if="!pulls.length" class="state">{{ t("empty") }}</div></template
      ><template v-else-if="!loading && !error && section === 'wiki'"
        ><div v-for="page in wiki" :key="page.slug" class="item-row">
          <span class="wiki-mark">W</span><strong>{{ page.title }}</strong
          ><small>r{{ page.revision }}</small>
        </div>
        <div v-if="!wiki.length" class="state">{{ t("empty") }}</div></template
      >
    </div>
  </section>
</template>
