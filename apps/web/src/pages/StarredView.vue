<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ExploreRepository } from "../lib/api";
import { api } from "../lib/api";
import ExploreRepositoryList from "../components/ExploreRepositoryList.vue";
import NoticeBar from "../components/NoticeBar.vue";
import StatusState from "../components/StatusState.vue";
import "../styles/social.css";

const { t } = useI18n();
const items = ref<ExploreRepository[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const page = await api.starredRepositories();
    items.value = page.items;
    nextCursor.value = page.nextCursor;
  } catch {
    error.value = t("starredLoadError");
  } finally {
    loading.value = false;
  }
}
async function loadMore(): Promise<void> {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const page = await api.starredRepositories(nextCursor.value);
    items.value = [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
  } catch {
    error.value = t("starredLoadError");
  } finally {
    loadingMore.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section class="explore-page">
    <header class="workspace-page-heading">
      <div>
        <h1>{{ t("starredTitle") }}</h1>
        <p class="muted">{{ t("starredIntro") }}</p>
      </div>
    </header>
    <StatusState
      v-if="loading || (error && !items.length)"
      :loading="loading"
      :error="error"
      :empty="false"
      @retry="load"
    />
    <div v-else-if="!items.length" class="settings-empty">
      <p>{{ t("starredEmpty") }}</p>
      <p class="muted">{{ t("starredEmptyHint") }}</p>
      <RouterLink class="btn" to="/explore">{{ t("exploreNav") }}</RouterLink>
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
