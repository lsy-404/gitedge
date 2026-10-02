<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { Repository } from "../lib/api";
import { ApiError, api } from "../lib/api";
import AppIcon from "../components/AppIcon.vue";
import StatusBadge from "../components/StatusBadge.vue";
import StatusState from "../components/StatusState.vue";
import DeployWizard from "../components/DeployWizard.vue";
import RepositoryCode from "../components/RepositoryCode.vue";
import RepositoryCollaboration from "../components/RepositoryCollaboration.vue";
import { eventActiveId } from "../ui/formEvents";

const route = useRoute();
const router = useRouter();
const { t } = useI18n();
const owner = computed(() => String(route.params.owner));
const repoName = computed(() => String(route.params.repo));
const section = computed(() =>
  route.params.view ? "code" : String(route.params.section || route.path.split("/")[3] || "code")
);
const tabs = ["code", "issues", "pulls", "discussions", "wiki"] as const;
/** Commit graph and compare views belong to the Code tab. */
const activeTab = computed(() => tabs.find((tab) => tab === section.value) ?? "code");
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

/** Narrow screens scroll the tab strip, so keep the selected tab visible. */
watch(
  () => [activeTab.value, repository.value],
  async () => {
    await nextTick();
    document.getElementById(`tab-${activeTab.value}`)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  }
);

function selectTab(event: Event) {
  const tab = eventActiveId(event).replace(/^tab-/, "");
  if (tab === activeTab.value) return;
  void router.push(
    tab === "code"
      ? `/${owner.value}/${repoName.value}`
      : `/${owner.value}/${repoName.value}/${tab}`
  );
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
        <StatusBadge>
          <AppIcon v-if="repository.visibility === 'private'" slot="start" name="lock" :size="12" />
          {{ t(repository.visibility) }}
        </StatusBadge>
        <fluent-button
          v-if="repository.canWrite"
          type="button"
          class="repo-deploy"
          @click="showDeploy = !showDeploy"
        >
          {{ t("deploy") }}
        </fluent-button>
      </div>
      <p class="repo-desc">{{ repository.description || t("noDescription") }}</p>
      <DeployWizard v-if="showDeploy && repository.canWrite" :repository="repository" />
      <fluent-tablist
        class="repo-tabs"
        :aria-label="t('repositoryNav')"
        :activeid="`tab-${activeTab}`"
        @change="selectTab"
      >
        <fluent-tab id="tab-code"><AppIcon slot="start" name="code" />{{ t("code") }}</fluent-tab>
        <fluent-tab id="tab-issues"
          ><AppIcon slot="start" name="issue" />{{ t("issues") }}</fluent-tab
        >
        <fluent-tab id="tab-pulls"><AppIcon slot="start" name="pr" />{{ t("pulls") }}</fluent-tab>
        <fluent-tab id="tab-discussions">{{ t("discussions") }}</fluent-tab>
        <fluent-tab id="tab-wiki"><AppIcon slot="start" name="wiki" />{{ t("wiki") }}</fluent-tab>
      </fluent-tablist>
      <RepositoryCode
        v-if="section === 'code' || section === 'commits' || section === 'compare'"
        :repository="repository"
        :section="section"
      />
      <RepositoryCollaboration v-else :repository="repository" :section="section" />
    </template>
  </section>
</template>
