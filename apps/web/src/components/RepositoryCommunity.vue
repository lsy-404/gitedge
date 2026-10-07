<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RepositoryCommunity } from "../lib/api";
import { api } from "../lib/api";
import { communitySourceUrl, isCommunityTruncated } from "../lib/community";
import AppIcon from "./AppIcon.vue";
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
    <h2 :class="{ 'visually-hidden': !listedFiles.length }">{{ t("communityFiles") }}</h2>
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else-if="community">
      <NoticeBar v-if="anyTruncated" intent="warning">{{ t("communityTruncated") }}</NoticeBar>
      <section v-if="readmeFile" class="community-readme box">
        <div class="box-header">
          <AppIcon name="book" />
          <h3>{{ t("communityReadme") }}</h3>
          <a class="community-source" :href="communitySourceUrl(readmeFile)">{{
            t("communitySource")
          }}</a>
        </div>
        <div
          class="community-readme-body"
          tabindex="0"
          role="region"
          :aria-label="t('communityReadme')"
        >
          <p v-if="isCommunityTruncated(readmeFile)" class="community-truncated muted">
            {{ t("communityTruncated") }}
          </p>
          <MarkdownContent
            :source="readmeFile.content"
            :base-url="communitySourceUrl(readmeFile)"
          />
        </div>
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
.community-empty {
  margin: 0;
}
.community-readme .box-header h3 {
  font-size: var(--font-size-body);
}
.community-readme .community-source {
  margin-left: auto;
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-regular);
}
.community-readme-body {
  display: grid;
  gap: var(--space-3);
  max-height: 70vh;
  padding: var(--space-6) var(--space-8);
  overflow: auto;
}
.community-readme-body:focus-visible,
.community-file summary:focus-visible {
  outline-offset: -2px;
}
.community-file-list {
  display: grid;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  list-style: none;
  overflow: hidden;
}
.community-file + .community-file {
  border-top: 1px solid var(--border-default);
}
.community-file summary {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: baseline;
  padding: var(--space-3) var(--space-4);
  cursor: pointer;
  background: var(--bg-subtle);
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
  padding: var(--space-4);
  overflow: auto;
}
.community-truncated {
  margin: 0;
}
.community-file-content .community-source {
  justify-self: start;
}
@media (max-width: 560px) {
  .community-readme-body {
    padding: var(--space-4);
  }
}
</style>
