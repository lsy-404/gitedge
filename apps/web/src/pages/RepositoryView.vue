<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { Repository } from "../lib/api";
import { ApiError, api } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import StatusState from "../components/StatusState.vue";
import DeployWizard from "../components/DeployWizard.vue";
import RepositoryCode from "../components/RepositoryCode.vue";
import RepositoryCollaboration from "../components/RepositoryCollaboration.vue";

const route = useRoute();
const { t } = useI18n();
const owner = computed(() => String(route.params.owner));
const repoName = computed(() => String(route.params.repo));
const section = computed(() =>
  route.params.view ? "code" : String(route.params.section || route.path.split("/")[3] || "code")
);
const repository = ref<Repository | null>(null);
const loading = ref(true);
const error = ref("");
const notFound = ref(false);
const showDeploy = ref(false);
let loadVersion = 0;

async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  repository.value = null;
  try {
    const result = await api.repository(owner.value, repoName.value);
    if (version !== loadVersion) return;
    repository.value = result;
  } catch (cause) {
    if (version !== loadVersion) return;
    notFound.value = cause instanceof ApiError && cause.status === 404;
    error.value = notFound.value ? "" : t("apiError");
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => [route.params.owner, route.params.repo], load, { immediate: true });
</script>

<template>
  <section class="page repo-page">
    <StatusState
      v-if="loading || error || notFound"
      :loading="loading"
      :error="error"
      :empty="notFound"
      @retry="load"
    >
      <template #empty>{{ t("repositoryNotFound") }}</template>
    </StatusState>
    <template v-else-if="repository">
      <div class="repo-head">
        <AppIcon name="repo" :size="20" />
        <span class="path">{{ owner }}</span
        ><span class="path muted">/</span>
        <h1>{{ repoName }}</h1>
        <span class="pill">{{ t(repository.visibility) }}</span>
        <button
          v-if="repository.canWrite"
          class="btn repo-deploy"
          @click="showDeploy = !showDeploy"
        >
          {{ t("deploy") }}
        </button>
      </div>
      <p class="repo-desc">{{ repository.description || t("noDescription") }}</p>
      <DeployWizard v-if="showDeploy && repository.canWrite" :repository="repository" />
      <nav class="tabs" :aria-label="t('repositoryNav')">
        <RouterLink :class="{ active: section === 'code' }" :to="`/${owner}/${repoName}`"
          ><AppIcon name="code" />{{ t("code") }}</RouterLink
        >
        <RouterLink :class="{ active: section === 'issues' }" :to="`/${owner}/${repoName}/issues`"
          ><AppIcon name="issue" />{{ t("issues") }}</RouterLink
        >
        <RouterLink :class="{ active: section === 'pulls' }" :to="`/${owner}/${repoName}/pulls`"
          ><AppIcon name="pr" />{{ t("pulls") }}</RouterLink
        >
        <RouterLink
          :class="{ active: section === 'discussions' }"
          :to="`/${owner}/${repoName}/discussions`"
          >{{ t("discussions") }}</RouterLink
        >
        <RouterLink :class="{ active: section === 'wiki' }" :to="`/${owner}/${repoName}/wiki`"
          ><AppIcon name="wiki" />{{ t("wiki") }}</RouterLink
        >
      </nav>
      <RepositoryCode
        v-if="section === 'code' || section === 'commits' || section === 'compare'"
        :repository="repository"
        :section="section"
      />
      <RepositoryCollaboration v-else :repository="repository" :section="section" />
    </template>
  </section>
</template>
