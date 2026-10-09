<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { GitCommit, Repository } from "../lib/api";
import { api, errorMessage } from "../lib/api";
import { resolveCommitOid } from "../lib/codeAnchor";
import { repositoryCodeLocation } from "../lib/gitGraphView";
import AppIcon from "./AppIcon.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repository: Repository }>();
const { t, d } = useI18n();
const route = useRoute();
const commits = ref<GitCommit[]>([]);
const inspected = ref(0);
const nextCursor = ref<string | null>(null);
const pinnedRef = ref("");
const isDirectory = ref(false);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const moreError = ref("");
let version = 0;

const refName = computed(() => String(route.query.ref || props.repository.defaultBranch));
const path = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join("/") : String(value || "");
});
const backLocation = computed(() =>
  repositoryCodeLocation(
    props.repository.owner,
    props.repository.name,
    isDirectory.value ? "tree" : "blob",
    path.value,
    refName.value
  )
);

function commitPath(oid: string) {
  return {
    path: `/${props.repository.owner}/${props.repository.name}/commit/${oid}`,
    query: { ref: pinnedRef.value },
  };
}
async function load() {
  const current = ++version;
  loading.value = true;
  error.value = "";
  moreError.value = "";
  commits.value = [];
  inspected.value = 0;
  nextCursor.value = null;
  try {
    const refs = await api.refs(props.repository.id);
    const pinned = resolveCommitOid(refs, refName.value) ?? refName.value;
    const parent = path.value.split("/").slice(0, -1).join("/");
    const [history, siblings] = await Promise.all([
      api.pathHistory(props.repository.id, pinned, path.value),
      api.tree(props.repository.id, pinned, parent).catch(() => null),
    ]);
    if (current !== version) return;
    pinnedRef.value = pinned;
    isDirectory.value =
      siblings?.entries.find((entry) => entry.path === path.value)?.type === "tree";
    commits.value = history.commits;
    inspected.value = history.inspected;
    nextCursor.value = history.nextCursor;
  } catch (cause) {
    if (current === version) error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}
async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  const current = version;
  loadingMore.value = true;
  moreError.value = "";
  try {
    const history = await api.pathHistory(
      props.repository.id,
      pinnedRef.value,
      path.value,
      nextCursor.value
    );
    if (current !== version) return;
    commits.value = [...commits.value, ...history.commits];
    inspected.value += history.inspected;
    nextCursor.value = history.nextCursor;
  } catch (cause) {
    if (current === version) moreError.value = errorMessage(cause, t);
  } finally {
    loadingMore.value = false;
  }
}

watch([() => props.repository.id, refName, path], load, { immediate: true });
</script>

<template>
  <section class="box history-panel">
    <div class="box-header">
      <AppIcon name="clock" />
      <h2>{{ t("fileHistoryTitle", { path }) }}</h2>
      <RouterLink class="btn btn-sm" :to="backLocation">{{ t("viewFileNormal") }}</RouterLink>
    </div>
    <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    <template v-if="!loading && !error">
      <ul v-if="commits.length" class="history-list">
        <li v-for="commit in commits" :key="commit.oid" class="history-row">
          <RouterLink class="history-subject" :to="commitPath(commit.oid)">{{
            commit.message.split("\n")[0]
          }}</RouterLink>
          <div class="history-meta">
            <span>{{ commit.author.name }}</span>
            <time :datetime="new Date(commit.author.timestamp * 1000).toISOString()">{{
              d(commit.author.timestamp * 1000, "long")
            }}</time>
            <code>{{ commit.oid.slice(0, 8) }}</code>
          </div>
        </li>
      </ul>
      <p v-else-if="!nextCursor" class="state">{{ t("historyEmpty") }}</p>
      <NoticeBar v-if="moreError" intent="error">{{ moreError }}</NoticeBar>
      <div class="history-footer">
        <span>{{ t("historyInspected", { count: inspected }) }}</span>
        <span>{{ t("historyNote", { ref: refName }) }}</span>
        <FluentButton v-if="nextCursor" type="button" :busy="loadingMore" @click="loadMore">{{
          moreError ? t("retry") : t("historyLoadMore")
        }}</FluentButton>
      </div>
    </template>
  </section>
</template>
