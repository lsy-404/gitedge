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
  width: min(1120px, calc(100% - 48px));
  margin: 32px auto;
}
.profile-header {
  display: flex;
  gap: 20px;
  align-items: center;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
}
.profile-avatar {
  display: grid;
  width: 88px;
  height: 88px;
  place-items: center;
  border-radius: 50%;
  background: var(--subtle);
  border: 1px solid var(--border);
  color: var(--accent);
  font-size: 32px;
  font-weight: 600;
}
.profile-header h1,
.profile-panel h2 {
  margin: 0;
}
.profile-header .eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 12px;
}
.profile-header .muted {
  margin: 4px 0 0;
}
.profile-columns {
  display: grid;
  grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
  gap: 32px;
  padding-top: 24px;
}
.profile-sidebar {
  min-width: 0;
}
.profile-bio {
  margin: 0 0 20px;
}
.profile-detail {
  display: grid;
  gap: 4px;
  margin: 12px 0;
  overflow-wrap: anywhere;
}
.profile-detail span {
  color: var(--muted);
  font-size: 12px;
}
.profile-content {
  display: grid;
  gap: 24px;
  min-width: 0;
}
.profile-panel {
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
}
.profile-panel > h2,
.profile-panel-heading {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  font-size: 18px;
}
.profile-panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}
.profile-panel-heading h2 {
  font-size: inherit;
}
.profile-readme {
  max-height: 70vh;
  overflow: auto;
  padding-top: 16px;
}
.profile-repositories {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.profile-repositories li {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.profile-repositories li:last-child {
  border-bottom: 0;
}
.profile-repositories p {
  margin: 5px 0 0;
  font-size: 13px;
}
@media (max-width: 700px) {
  .public-profile {
    width: calc(100% - 32px);
    margin: 20px auto;
  }
  .profile-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  .profile-avatar {
    width: 64px;
    height: 64px;
    font-size: 24px;
  }
}
</style>
