<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { ExploreRepository, ExploreTopic } from "../lib/api";
import { api } from "../lib/api";
import ExploreRepositoryList from "../components/ExploreRepositoryList.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";
import TextField from "../components/TextField.vue";
import "../styles/workspace.css";
import "../styles/social.css";

const SEARCH_DELAY_MS = 300;
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

function single(value: unknown): string {
  return typeof value === "string" ? value : "";
}
const sort = computed<"updated" | "stars">(() =>
  single(route.query.sort) === "stars" ? "stars" : "updated"
);
const topic = computed(() => single(route.query.topic));
const search = ref(single(route.query.q));
const items = ref<ExploreRepository[]>([]);
const nextCursor = ref<string | null>(null);
const popularTopics = ref<ExploreTopic[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function filters(cursor?: string) {
  return {
    sort: sort.value,
    q: single(route.query.q) || undefined,
    topic: topic.value || undefined,
    cursor,
  };
}
async function load(): Promise<void> {
  const current = ++version;
  loading.value = true;
  error.value = "";
  try {
    const page = await api.explore(filters());
    if (current !== version) return;
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch {
    if (current === version) error.value = t("exploreLoadError");
  } finally {
    if (current === version) loading.value = false;
  }
}
async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  const current = version;
  loadingMore.value = true;
  try {
    const page = await api.explore(filters(nextCursor.value));
    if (current !== version) return;
    items.value = [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch {
    if (current === version) error.value = t("exploreLoadError");
  } finally {
    loadingMore.value = false;
  }
}
async function loadTopics(): Promise<void> {
  try {
    popularTopics.value = await api.exploreTopics();
  } catch {
    popularTopics.value = [];
  }
}
function update(changes: Record<string, string | undefined>): void {
  const next = { ...route.query, ...changes };
  for (const key of Object.keys(next)) if (!next[key]) delete next[key];
  void router.replace({ path: "/explore", query: next });
}
function onSearchInput(): void {
  clearTimeout(timer);
  timer = setTimeout(() => update({ q: search.value.trim() || undefined }), SEARCH_DELAY_MS);
}
watch(() => [route.query.q, route.query.sort, route.query.topic], load, { immediate: true });
watch(
  () => route.query.q,
  (value) => {
    if (single(value) !== search.value.trim()) search.value = single(value);
  }
);
void loadTopics();
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <section class="workspace-page explore-page">
    <header class="workspace-page-heading">
      <div>
        <h1>{{ t("exploreTitle") }}</h1>
        <p class="muted">{{ t("exploreIntro") }}</p>
      </div>
    </header>
    <div class="explore-controls">
      <TextField
        v-model="search"
        type="search"
        :placeholder="t('exploreSearchPlaceholder')"
        @input="onSearchInput"
        >{{ t("exploreSearchLabel") }}</TextField
      >
      <div class="explore-sort" role="group" :aria-label="t('exploreSortLabel')">
        <button
          type="button"
          class="btn"
          :class="{ 'btn-subtle': sort !== 'updated' }"
          :aria-pressed="sort === 'updated'"
          @click="update({ sort: undefined })"
        >
          {{ t("exploreSortUpdated") }}
        </button>
        <button
          type="button"
          class="btn"
          :class="{ 'btn-subtle': sort !== 'stars' }"
          :aria-pressed="sort === 'stars'"
          @click="update({ sort: 'stars' })"
        >
          {{ t("exploreSortStars") }}
        </button>
      </div>
    </div>
    <div v-if="topic" class="explore-topics">
      <span class="topic-chip">{{ t("exploreTopicActive", { topic }) }}</span>
      <button type="button" class="btn btn-sm btn-subtle" @click="update({ topic: undefined })">
        {{ t("exploreTopicClear") }}
      </button>
    </div>
    <div v-else-if="popularTopics.length" class="explore-topics">
      <strong>{{ t("exploreTopicsTitle") }}</strong>
      <ul class="topic-chips">
        <li v-for="item in popularTopics" :key="item.topic">
          <RouterLink class="topic-chip" :to="{ path: '/explore', query: { topic: item.topic } }">{{
            item.topic
          }}</RouterLink>
        </li>
      </ul>
    </div>
    <StatusState
      v-if="loading || (error && !items.length)"
      :loading="loading"
      :error="error"
      :empty="false"
      @retry="load"
    />
    <div v-else-if="!items.length" class="settings-empty">
      <p>{{ t("exploreEmpty") }}</p>
      <p class="muted">{{ t("exploreEmptyHint") }}</p>
    </div>
    <template v-else>
      <NoticeBar v-if="error" intent="error">{{ error }}</NoticeBar>
      <ExploreRepositoryList :items="items" />
      <div v-if="nextCursor" class="form-actions">
        <button type="button" class="btn" :disabled="loadingMore" @click="loadMore">
          {{ t("exploreLoadMore") }}
        </button>
      </div>
    </template>
  </section>
</template>
