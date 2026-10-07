<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryCommunity } from "../lib/api";
import { api } from "../lib/api";
import { communitySourceUrl, isCommunityTruncated } from "../lib/community";
import MarkdownContent from "./MarkdownContent.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const props = withDefaults(
  defineProps<{ repositoryId: string; refName: string; showReadme?: boolean }>(),
  {
    showReadme: false,
  }
);
const { t } = useI18n();
const community = ref<RepositoryCommunity | null>(null);
const loading = ref(true);
const error = ref("");
let loadVersion = 0;

const files = computed(() => {
  const value = community.value;
  if (!value) return [];
  const all = [
    ...value.files,
    ...value.issueTemplates,
    ...(value.pullRequestTemplate ? [value.pullRequestTemplate] : []),
  ];
  return [...new Map(all.map((file) => [`${file.repositoryId}:${file.path}`, file])).values()];
});
const readmeFile = computed(() =>
  props.showReadme
    ? files.value.find(
        (file) =>
          file.kind.toLowerCase() === "readme" ||
          /(^|\/)README(?:\.md|\.markdown)?$/i.test(file.path)
      )
    : undefined
);
const listedFiles = computed(() => files.value.filter((file) => file !== readmeFile.value));
const anyTruncated = computed(() => {
  const response = community.value;
  if (!response) return false;
  return response.truncated || files.value.some(isCommunityTruncated);
});

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.repositoryCommunity(props.repositoryId, props.refName);
    if (version === loadVersion) community.value = result;
  } catch {
    if (version === loadVersion) {
      community.value = null;
      error.value = t("communityLoadError");
    }
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => [props.repositoryId, props.refName], load, { immediate: true });
</script>

<template>
  <section class="repository-community" :aria-label="t('communityFiles')">
    <h2>{{ t("communityFiles") }}</h2>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else-if="community">
      <NoticeBar v-if="anyTruncated" intent="warning">{{ t("communityTruncated") }}</NoticeBar>
      <section v-if="readmeFile" class="community-readme">
        <div class="community-readme-heading">
          <h3>{{ t("communityReadme") }}</h3>
          <a :href="communitySourceUrl(readmeFile)">{{ t("communitySource") }}</a>
        </div>
        <p v-if="isCommunityTruncated(readmeFile)" class="community-truncated muted">
          {{ t("communityTruncated") }}
        </p>
        <MarkdownContent :source="readmeFile.content" :base-url="communitySourceUrl(readmeFile)" />
      </section>
      <p v-if="!listedFiles.length && !readmeFile" class="community-empty muted">
        {{ t("communityNoFiles") }}
      </p>
      <ul v-if="listedFiles.length" class="community-file-list">
        <li
          v-for="file in listedFiles"
          :key="`${file.repositoryId}:${file.path}`"
          class="community-file"
        >
          <details>
            <summary>
              <span>{{ file.title }}</span>
              <small>{{ file.path }}</small>
              <small v-if="file.inherited" class="community-inherited">
                {{ t("communityInherited", { owner: file.owner, repository: file.repository }) }}
              </small>
            </summary>
            <div class="community-file-content">
              <p v-if="isCommunityTruncated(file)" class="community-truncated muted">
                {{ t("communityTruncated") }}
              </p>
              <MarkdownContent :source="file.content" :base-url="communitySourceUrl(file)" />
              <a class="community-source" :href="communitySourceUrl(file)">{{
                t("communitySource")
              }}</a>
            </div>
          </details>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.repository-community {
  display: grid;
  gap: var(--space-4);
  min-width: 0;
}
.repository-community h2,
.community-empty {
  margin: 0;
}
.community-readme {
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  max-height: 70vh;
  overflow: auto;
}
.community-readme > :not(.community-readme-heading) {
  margin: var(--space-4);
}
.community-readme-heading {
  position: sticky;
  top: 0;
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3) var(--space-4);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
}
.community-readme-heading h3 {
  margin: 0;
  font-size: var(--font-size-body);
}
.community-file-list {
  display: grid;
  margin: 0;
  padding: 0;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  list-style: none;
  overflow: hidden;
}
.community-file + .community-file {
  border-top: 1px solid var(--border-muted);
}
.community-file summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  align-items: baseline;
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
}
.community-file summary:hover {
  background: var(--bg-subtle);
}
.community-file[open] summary {
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
}
.community-file summary span {
  font-weight: var(--font-weight-semibold);
}
.community-file summary small {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.community-inherited {
  margin-left: auto;
}
.community-file-content {
  display: grid;
  gap: var(--space-3);
  max-height: 70vh;
  overflow: auto;
  padding: var(--space-4);
}
.community-truncated {
  margin: 0;
}
.community-source {
  justify-self: start;
  font-size: var(--font-size-meta);
}
</style>
