<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PublicProfile } from "../lib/api";
import { api } from "../lib/api";
import MarkdownContent from "../components/MarkdownContent.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";

const props = defineProps<{ owner: string }>();
const { t } = useI18n();
const profile = ref<PublicProfile | null>(null);
const loading = ref(true);
const error = ref("");
let loadVersion = 0;

const publicRepositories = computed(() =>
  (profile.value?.repositories ?? []).filter((repository) => repository.visibility === "public")
);
const readmeRepository = computed(() =>
  profile.value?.readme
    ? publicRepositories.value.find(
        (repository) => repository.id === profile.value?.readme?.repositoryId
      )
    : undefined
);
const readmeSourcePath = computed(() => {
  const readme = profile.value?.readme;
  const repository = readmeRepository.value;
  if (!readme || !repository) return "";
  const path = readme.path.split("/").map(encodeURIComponent).join("/");
  return `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.slug)}/blob/${path}?ref=${encodeURIComponent(repository.defaultBranch)}`;
});
const readmeBaseUrl = computed(() => readmeSourcePath.value || undefined);
const websiteUrl = computed(() => {
  const value = profile.value?.website;
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
});

async function load(): Promise<void> {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  try {
    const result = await api.publicProfile(props.owner);
    if (version === loadVersion) profile.value = result;
  } catch {
    if (version === loadVersion) {
      profile.value = null;
      error.value = t("profileLoadError");
    }
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}

watch(() => props.owner, load, { immediate: true });
</script>

<template>
  <section class="public-profile">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else-if="profile">
      <NoticeBar v-if="profile.truncated" intent="warning">
        {{ t("profileRepositoriesTruncated") }}
      </NoticeBar>
      <header class="profile-header">
        <div class="profile-avatar" aria-hidden="true">
          {{ profile.owner.slice(0, 1).toUpperCase() }}
        </div>
        <div>
          <p class="eyebrow">{{ t("profilePublic") }}</p>
          <h1>{{ profile.displayName || profile.owner }}</h1>
          <p class="muted">@{{ profile.owner }}</p>
        </div>
      </header>

      <div class="profile-columns">
        <aside class="profile-sidebar">
          <p v-if="profile.bio" class="profile-bio">{{ profile.bio }}</p>
          <p v-if="profile.location" class="profile-detail">
            <span>{{ t("profileLocation") }}</span
            >{{ profile.location }}
          </p>
          <p v-if="websiteUrl" class="profile-detail">
            <span>{{ t("profileWebsite") }}</span>
            <a :href="websiteUrl" target="_blank" rel="noreferrer noopener">{{
              profile.website
            }}</a>
          </p>
        </aside>

        <div class="profile-content">
          <section v-if="profile.readme" class="profile-panel">
            <div class="profile-panel-heading">
              <h2>{{ t("profileReadme") }}</h2>
              <a v-if="readmeSourcePath" :href="readmeSourcePath">{{ t("profileReadmeSource") }}</a>
            </div>
            <MarkdownContent
              class="profile-readme"
              :source="profile.readme.content"
              :base-url="readmeBaseUrl"
            />
          </section>

          <section class="profile-panel">
            <h2>{{ t("profileRepositories") }}</h2>
            <ul v-if="publicRepositories.length" class="profile-repositories">
              <li v-for="repository in publicRepositories" :key="repository.id">
                <RouterLink
                  :to="`/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.slug)}`"
                >
                  {{ repository.owner }}/{{ repository.name }}
                </RouterLink>
                <p v-if="repository.description" class="muted">{{ repository.description }}</p>
              </li>
            </ul>
            <p v-else class="muted">{{ t("profileNoRepositories") }}</p>
          </section>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.public-profile {
  width: min(1120px, calc(100% - 2 * var(--space-6)));
  margin: var(--space-8) auto;
}
.profile-header {
  display: flex;
  gap: var(--space-5);
  align-items: center;
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--border-default);
}
.profile-avatar {
  display: grid;
  width: 88px;
  height: 88px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: var(--radius-full);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: 32px;
  font-weight: var(--font-weight-semibold);
}
.profile-header h1,
.profile-panel h2 {
  margin: 0;
  overflow-wrap: anywhere;
}
.profile-header .eyebrow {
  margin: 0 0 var(--space-1);
}
.profile-header .muted {
  margin: var(--space-1) 0 0;
}
.profile-columns {
  display: grid;
  grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
  gap: var(--space-8);
  padding-top: var(--space-6);
}
.profile-sidebar {
  min-width: 0;
}
.profile-bio {
  margin: 0 0 var(--space-5);
}
.profile-detail {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0;
  overflow-wrap: anywhere;
}
.profile-detail span {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.profile-content {
  display: grid;
  gap: var(--space-6);
  min-width: 0;
}
.profile-panel {
  min-width: 0;
  padding: var(--space-5);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
}
.profile-panel > h2,
.profile-panel-heading {
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-default);
  font-size: var(--font-size-lg);
  line-height: var(--line-height-body);
}
.profile-panel-heading {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  align-items: center;
}
.profile-panel-heading h2 {
  font-size: inherit;
}
.profile-readme {
  max-height: 70vh;
  overflow: auto;
  padding-top: var(--space-4);
}
.profile-repositories {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.profile-repositories li {
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-muted);
}
.profile-repositories li:last-child {
  border-bottom: 0;
}
.profile-repositories p {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-meta);
}
@media (max-width: 700px) {
  .public-profile {
    width: calc(100% - var(--space-8));
    margin: var(--space-5) auto;
  }
  .profile-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
  }
  .profile-avatar {
    width: 64px;
    height: 64px;
    font-size: var(--font-size-section);
  }
}
</style>
