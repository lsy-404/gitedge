<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { api, type Issue, type PullRequest, type Repository, type WikiPage } from "../lib/api";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";
import FormActions from "../components/FormActions.vue";
import { sessionState } from "../lib/session";

const route = useRoute();
const { t, locale } = useI18n();
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
const copied = ref(false);
const cloneUrl = computed(() => `${window.location.origin}/${owner.value}/${repoName.value}.git`);
const openIssues = computed(() => issues.value.filter((item) => item.state === "open").length);
const openPulls = computed(() => pulls.value.filter((item) => item.state === "open").length);
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

async function copyCloneUrl() {
  try {
    await navigator.clipboard.writeText(cloneUrl.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(value);
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
  <section class="page">
    <div class="repo-head">
      <AppIcon name="repo" :size="20" />
      <span class="path">{{ owner }}</span>
      <span class="path muted">/</span>
      <strong>{{ repoName }}</strong>
      <span v-if="repository" class="pill">
        {{ repository.visibility === "private" ? t("private") : t("public") }}
      </span>
    </div>
    <p class="repo-desc">{{ repository?.description || t("noDescription") }}</p>
    <nav class="tabs" :aria-label="t('repositoryNav')">
      <RouterLink :class="{ active: section === 'code' }" :to="`/${owner}/${repoName}`">
        <AppIcon name="code" />{{ t("code") }}
      </RouterLink>
      <RouterLink :class="{ active: section === 'issues' }" :to="`/${owner}/${repoName}/issues`">
        <AppIcon name="issue" />{{ t("issues") }}
        <span v-if="section === 'issues' && !loading && !error" class="count">{{
          issues.length
        }}</span>
      </RouterLink>
      <RouterLink :class="{ active: section === 'pulls' }" :to="`/${owner}/${repoName}/pulls`">
        <AppIcon name="pr" />{{ t("pulls") }}
        <span v-if="section === 'pulls' && !loading && !error" class="count">{{
          pulls.length
        }}</span>
      </RouterLink>
      <RouterLink :class="{ active: section === 'wiki' }" :to="`/${owner}/${repoName}/wiki`">
        <AppIcon name="wiki" />{{ t("wiki") }}
      </RouterLink>
    </nav>

    <div v-if="!loading && !error && canWrite && section !== 'code'" class="page-head">
      <span />
      <button class="btn primary" @click="showForm = !showForm">
        <AppIcon name="plus" />
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
      class="box box-form form-stack"
      @submit.prevent="createIssue"
    >
      <label class="field">{{ t("issueTitle") }}<input v-model="issueForm.title" required /></label>
      <label class="field"
        >{{ t("issueBody") }}<textarea v-model="issueForm.body" rows="4" />
      </label>
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <form
      v-if="showForm && section === 'pulls'"
      class="box box-form form-stack"
      @submit.prevent="createPullRequest"
    >
      <label class="field">{{ t("issueTitle") }}<input v-model="pullForm.title" required /></label>
      <label class="field">{{ t("issueBody") }}<textarea v-model="pullForm.body" rows="4" /></label>
      <label class="field">{{ t("headBranch") }}<input v-model="pullForm.head" required /></label>
      <label class="field">{{ t("baseBranch") }}<input v-model="pullForm.base" required /></label>
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>
    <form
      v-if="showForm && section === 'wiki'"
      class="box box-form form-stack"
      @submit.prevent="createWikiPage"
    >
      <label class="field">{{ t("slug") }}<input v-model="wikiForm.slug" required /></label>
      <label class="field">{{ t("pageTitle") }}<input v-model="wikiForm.title" required /></label>
      <label class="field"
        >{{ t("pageBody") }}<textarea v-model="wikiForm.body" rows="6" required />
      </label>
      <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
    </form>

    <div class="box">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
      <template v-if="!loading && !error && section === 'code'">
        <div class="clone">
          <span class="branch"
            ><AppIcon name="branch" />{{ repository?.defaultBranch || "main" }}</span
          >
          <code>{{ cloneUrl }}</code>
          <button class="btn" :aria-label="t('copy')" @click="copyCloneUrl">
            <AppIcon :name="copied ? 'check' : 'copy'" />{{ copied ? t("copied") : t("copy") }}
          </button>
        </div>
        <div class="state">
          <strong>{{ t("noCode") }}</strong>
          <p>{{ t("pushFirst") }}</p>
        </div>
      </template>
      <template v-else-if="!loading && !error && section === 'issues'">
        <div class="box-header">
          <span class="state-icon open"
            ><AppIcon name="issue" /> {{ openIssues }} {{ t("open") }}</span
          >
          <span class="muted"
            ><AppIcon name="issue-closed" /> {{ issues.length - openIssues }}
            {{ t("closed") }}</span
          >
        </div>
        <div v-for="issue in issues" :key="issue.number" class="box-row">
          <AppIcon
            :class="['state-icon', issue.state === 'open' ? 'open' : 'done']"
            :name="issue.state === 'open' ? 'issue' : 'issue-closed'"
          />
          <div class="grow">
            <div class="row-title">{{ issue.title }}</div>
            <div class="row-meta">
              <span>#{{ issue.number }} · {{ t("openedBy", { author: issue.author }) }}</span>
              <span>{{ t("updatedOn", { date: formatDate(issue.updatedAt) }) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!issues.length" class="state">{{ t("empty") }}</div>
      </template>
      <template v-else-if="!loading && !error && section === 'pulls'">
        <div class="box-header">
          <span class="state-icon open"><AppIcon name="pr" /> {{ openPulls }} {{ t("open") }}</span>
          <span class="muted">{{ pulls.length - openPulls }} {{ t("closed") }}</span>
        </div>
        <div v-for="pull in pulls" :key="pull.number" class="box-row">
          <AppIcon :class="['state-icon', pull.state]" name="pr" />
          <div class="grow">
            <div class="row-title">
              {{ pull.title }}<span :class="['pill', pull.state]">{{ t(pull.state) }}</span>
            </div>
            <div class="row-meta">
              <span>#{{ pull.number }} · {{ t("openedBy", { author: pull.author }) }}</span>
              <span class="mono">{{ pull.headRef }} → {{ pull.baseRef }}</span>
            </div>
          </div>
        </div>
        <div v-if="!pulls.length" class="state">{{ t("empty") }}</div>
      </template>
      <template v-else-if="!loading && !error && section === 'wiki'">
        <div v-for="page in wiki" :key="page.slug" class="box-row">
          <AppIcon class="state-icon" name="wiki" />
          <div class="grow">
            <div class="row-title">{{ page.title }}</div>
            <div class="row-meta">
              <span>r{{ page.revision }} · {{ page.updatedBy }}</span>
              <span>{{ t("updatedOn", { date: formatDate(page.updatedAt) }) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!wiki.length" class="state">{{ t("empty") }}</div>
      </template>
    </div>
  </section>
</template>
