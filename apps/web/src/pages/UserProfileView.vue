<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PublicProfile } from "../lib/api";
import { api } from "../lib/api";
import MarkdownContent from "../components/MarkdownContent.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";
import AppIcon from "../components/AppIcon.vue";
import TextField from "../components/TextField.vue";
import SelectField from "../components/SelectField.vue";
import { sessionState } from "../lib/session";

const props = defineProps<{ owner: string }>();
const { t, d } = useI18n();
const profile = ref<PublicProfile | null>(null);
const loading = ref(true);
const error = ref("");
const activeTab = ref<"overview" | "repositories" | "stars">("overview");
const query = ref("");
const sort = ref<"updated" | "name" | "stars">("updated");
let loadVersion = 0;

const publicRepositories = computed(() =>
  [...(profile.value?.repositories ?? [])]
    .filter((repository) => repository.visibility === "public")
    .sort((a, b) => {
      if (sort.value === "name") return a.name.localeCompare(b.name);
      if (sort.value === "stars") return b.starCount - a.starCount || a.name.localeCompare(b.name);
      return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);
    })
);
const filteredRepositories = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return publicRepositories.value.filter(
    (repository) =>
      !search ||
      `${repository.name} ${repository.description} ${repository.topics.join(" ")}`
        .toLocaleLowerCase()
        .includes(search)
  );
});
const featuredRepositories = computed(() =>
  [...publicRepositories.value]
    .sort((a, b) => b.starCount - a.starCount || b.updatedAt - a.updatedAt)
    .slice(0, 6)
);
const totalStars = computed(() =>
  publicRepositories.value.reduce((total, repository) => total + repository.starCount, 0)
);
const totalForks = computed(() =>
  publicRepositories.value.reduce((total, repository) => total + repository.forkCount, 0)
);
const avatarUrl = computed(() => {
  const value = profile.value?.avatarUrl;
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
});
const joinedDate = computed(() => {
  const joinedAt = profile.value?.joinedAt;
  return joinedAt ? new Date(joinedAt) : null;
});
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

const isOwner = computed(
  () =>
    sessionState.user?.identifier.toLocaleLowerCase() === props.owner.toLocaleLowerCase() &&
    sessionState.view !== "guest"
);

watch(
  () => props.owner,
  () => {
    activeTab.value = "overview";
    query.value = "";
    sort.value = "updated";
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="public-profile">
    <StatusState v-if="loading || error" :loading="loading" :error="error" @retry="load" />
    <template v-else-if="profile">
      <NoticeBar v-if="profile.truncated" intent="warning">
        {{ t("profileRepositoriesTruncated") }}
      </NoticeBar>
      <header class="profile-header">
        <img v-if="avatarUrl" class="profile-avatar" :src="avatarUrl" alt="" />
        <div v-else class="profile-avatar" aria-hidden="true">
          {{ profile.owner.slice(0, 1).toUpperCase() }}
        </div>
        <div>
          <p class="eyebrow">{{ t("profilePublic") }}</p>
          <h1>{{ profile.displayName || profile.owner }}</h1>
          <p class="muted">@{{ profile.owner }}</p>
          <p v-if="joinedDate" class="muted joined-date">
            {{ t("profileJoined", { date: d(joinedDate, "short") }) }}
          </p>
        </div>
        <RouterLink v-if="isOwner" class="btn profile-edit" to="/settings/account">
          <AppIcon name="gear" />{{ t("profileEdit") }}
        </RouterLink>
      </header>

      <div class="profile-tabs" role="group" :aria-label="t('profileNavigation')">
        <button
          type="button"
          :aria-pressed="activeTab === 'overview'"
          @click="activeTab = 'overview'"
        >
          {{ t("profileOverview") }}
        </button>
        <button
          type="button"
          :aria-pressed="activeTab === 'repositories'"
          @click="activeTab = 'repositories'"
        >
          {{ t("profileRepositories") }} <span>{{ publicRepositories.length }}</span>
        </button>
        <button type="button" :aria-pressed="activeTab === 'stars'" @click="activeTab = 'stars'">
          <AppIcon name="star" />{{ t("profileStarsTab") }}
          <span>{{ profile.starredRepositories.length }}</span>
        </button>
      </div>

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
          <section class="profile-stats" :aria-label="t('profileStatistics')">
            <div>
              <strong>{{ publicRepositories.length }}</strong
              ><span>{{ t("profileRepositories") }}</span>
            </div>
            <div>
              <strong>{{ totalStars }}</strong
              ><span><AppIcon class="stat-icon" name="star" /> {{ t("profileStars") }}</span>
            </div>
            <div>
              <strong>{{ totalForks }}</strong
              ><span><AppIcon class="stat-icon" name="fork" /> {{ t("profileForks") }}</span>
            </div>
          </section>
          <section v-if="activeTab === 'overview' && profile.readme" class="profile-panel">
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

          <section v-if="activeTab === 'overview'" class="profile-panel">
            <h2>{{ t("profilePopularRepositories") }}</h2>
            <ul v-if="featuredRepositories.length" class="profile-repositories">
              <li v-for="repository in featuredRepositories" :key="repository.id">
                <RouterLink
                  :to="`/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.slug)}`"
                >
                  {{ repository.owner }}/{{ repository.name }}
                </RouterLink>
                <p v-if="repository.description" class="muted">{{ repository.description }}</p>
                <div class="repository-meta">
                  <span v-for="topic in repository.topics.slice(0, 4)" :key="topic" class="topic">{{
                    topic
                  }}</span
                  ><span v-if="repository.starCount"
                    ><AppIcon name="star" :size="14" /> {{ repository.starCount }}</span
                  ><span v-if="repository.forkCount"
                    ><AppIcon name="fork" :size="14" /> {{ repository.forkCount }}</span
                  >
                </div>
              </li>
            </ul>
            <p v-else class="muted">{{ t("profileNoRepositories") }}</p>
          </section>
          <section v-else-if="activeTab === 'repositories'" class="profile-panel">
            <div class="profile-panel-heading">
              <h2>{{ t("profileRepositories") }}</h2>
              <span class="muted">{{
                t("profileRepositoryCount", { count: filteredRepositories.length })
              }}</span>
            </div>
            <div class="repository-controls">
              <TextField v-model="query" class="search-field" type="search">
                <AppIcon name="search" />{{ t("profileSearchRepositories") }}
              </TextField>
              <SelectField v-model="sort" :label="t('profileSort')">
                <option value="updated">{{ t("profileSortUpdated") }}</option>
                <option value="name">{{ t("profileSortName") }}</option>
                <option value="stars">{{ t("profileSortStars") }}</option>
              </SelectField>
            </div>
            <ul v-if="filteredRepositories.length" class="profile-repositories">
              <li v-for="repository in filteredRepositories" :key="repository.id">
                <RouterLink
                  :to="`/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.slug)}`"
                  >{{ repository.owner }}/{{ repository.name }}</RouterLink
                >
                <p v-if="repository.description" class="muted">{{ repository.description }}</p>
                <div class="repository-meta">
                  <span v-for="topic in repository.topics.slice(0, 4)" :key="topic" class="topic">{{
                    topic
                  }}</span
                  ><span v-if="repository.starCount"
                    ><AppIcon name="star" :size="14" /> {{ repository.starCount }}</span
                  ><span v-if="repository.forkCount"
                    ><AppIcon name="fork" :size="14" /> {{ repository.forkCount }}</span
                  >
                </div>
              </li>
            </ul>
            <p v-else class="muted">
              {{ query ? t("profileNoSearchResults") : t("profileNoRepositories") }}
            </p>
          </section>
          <section v-else class="profile-panel">
            <div class="profile-panel-heading">
              <h2>{{ t("profileStarsTab") }}</h2>
              <span class="muted">{{
                t("profileRepositoryCount", { count: profile.starredRepositories.length })
              }}</span>
            </div>
            <NoticeBar v-if="profile.starredTruncated" intent="warning">{{
              t("profileStarsTruncated")
            }}</NoticeBar>
            <ul v-if="profile.starredRepositories.length" class="profile-repositories">
              <li v-for="repository in profile.starredRepositories" :key="repository.id">
                <RouterLink
                  :to="`/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`"
                  >{{ repository.owner }}/{{ repository.name }}</RouterLink
                >
                <p v-if="repository.description" class="muted">{{ repository.description }}</p>
                <div class="repository-meta">
                  <span v-for="topic in repository.topics.slice(0, 4)" :key="topic" class="topic">{{
                    topic
                  }}</span
                  ><span><AppIcon name="star" :size="14" /> {{ repository.starCount }}</span>
                </div>
              </li>
            </ul>
            <p v-else class="muted">{{ t("profileNoStars") }}</p>
          </section>
          <section v-if="activeTab === 'overview'" class="profile-panel">
            <h2>{{ t("profileActivity") }}</h2>
            <ol v-if="profile.activity.length" class="profile-activity">
              <li
                v-for="(item, index) in profile.activity"
                :key="`${item.kind}-${item.repository}-${item.number}-${item.createdAt}-${index}`"
              >
                <AppIcon
                  :name="
                    item.kind === 'issue'
                      ? 'issue'
                      : item.kind === 'pull_request'
                        ? 'pr'
                        : 'discussion'
                  "
                />
                <div>
                  <p>
                    {{
                      t(`profileActivity_${item.kind}`, {
                        repository: `${item.owner}/${item.repository}`,
                      })
                    }}
                  </p>
                  <RouterLink
                    :to="`/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.repository)}/${item.targetKind === 'issue' ? 'issues' : item.targetKind === 'pull_request' ? 'pulls' : 'discussions'}/${item.number}`"
                    >{{ item.title }}</RouterLink
                  >
                  <span class="muted">{{ d(item.createdAt, "long") }}</span>
                </div>
              </li>
            </ol>
            <p v-else class="muted">{{ t("profileNoActivity") }}</p>
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
  object-fit: cover;
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
.profile-tabs {
  display: flex;
  gap: var(--space-5);
  border-bottom: 1px solid var(--border-default);
  margin-top: var(--space-5);
}
.profile-tabs button {
  padding: var(--space-3) var(--space-2);
  border: 0;
  border-bottom: 3px solid transparent;
  background: transparent;
  color: var(--fg-secondary);
  cursor: pointer;
}
.profile-tabs button[aria-pressed="true"] {
  border-bottom-color: var(--accent-strong);
  color: var(--fg-default);
  font-weight: var(--font-weight-semibold);
}
.profile-tabs span {
  margin-left: var(--space-1);
  padding: 2px 7px;
  border-radius: var(--radius-full);
  background: var(--bg-selected);
  font-size: var(--font-size-meta);
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
.profile-stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  padding: var(--space-3) 0;
}
.profile-stats div {
  display: grid;
  gap: var(--space-1);
}
.profile-stats strong {
  font-size: var(--font-size-section);
}
.profile-stats span,
.repository-meta {
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.repository-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-2);
}
.topic {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
.repository-controls {
  display: flex;
  gap: var(--space-3);
  justify-content: space-between;
  align-items: end;
  padding: var(--space-4) 0;
}
.repository-controls .select-field {
  display: grid;
  gap: var(--space-1);
  color: var(--fg-secondary);
  font-size: var(--font-size-meta);
}
.repository-controls select {
  min-width: 150px;
}
.repository-controls .search-field {
  flex: 1;
  max-width: 460px;
}
.repository-controls .search-field input {
  width: 100%;
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
.profile-activity {
  margin: 0;
  padding: 0;
  list-style: none;
}
.profile-activity li {
  display: flex;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border-muted);
}
.profile-activity li:last-child {
  border-bottom: 0;
}
.profile-activity li > .icon {
  flex: 0 0 auto;
  margin-top: var(--space-1);
  color: var(--fg-muted);
}
.profile-activity li > div {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
}
.profile-activity p {
  margin: 0;
  color: var(--fg-secondary);
}
.profile-activity .muted {
  font-size: var(--font-size-meta);
}
.profile-edit {
  margin-left: auto;
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
  .repository-controls {
    align-items: stretch;
    flex-direction: column;
  }
  .repository-controls select {
    width: 100%;
  }
}
</style>
