<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import type { GitBlame, GitFile, Repository } from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import { resolveCommitOid, splitHighlightedLines } from "../lib/codeAnchor";
import { repositoryCodeLocation } from "../lib/gitGraphView";
import { useLineSelection } from "../lib/lineSelection";
import { highlightedCode } from "../lib/markdown";
import { preferencesState } from "../lib/preferences";
import { relativeAge } from "../lib/relativeTime";
import AppIcon from "./AppIcon.vue";
import CodeLines, { type BlameGutterRow } from "./CodeLines.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repository: Repository }>();
const { t, d, locale } = useI18n();
const route = useRoute();
const blame = ref<GitBlame | null>(null);
const file = ref<GitFile | null>(null);
const loading = ref(false);
const error = ref("");
const unavailable = ref(false);
const codeLines = ref<InstanceType<typeof CodeLines> | null>(null);
const { selection, select } = useLineSelection(codeLines);
let version = 0;

const refName = computed(() => String(route.query.ref || props.repository.defaultBranch));
const path = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join("/") : String(value || "");
});
const location = (view: "blob" | "history") =>
  repositoryCodeLocation(
    props.repository.owner,
    props.repository.name,
    view,
    path.value,
    refName.value
  );
const lines = computed(() =>
  typeof file.value?.content === "string"
    ? splitHighlightedLines(highlightedCode(file.value.content, file.value.path))
    : []
);
const gutter = computed(() => {
  const rows = new Map<number, BlameGutterRow>();
  if (!blame.value) return rows;
  const commits = new Map(blame.value.commits.map((commit) => [commit.oid, commit]));
  const now = Date.now();
  for (const hunk of blame.value.hunks) {
    const commit = hunk.commitOid ? commits.get(hunk.commitOid) : undefined;
    rows.set(
      hunk.startLine,
      commit
        ? {
            summary: commit.summary,
            author: commit.author.name,
            age: relativeAge(commit.author.timestamp, now, locale.value),
            href: `/${props.repository.owner}/${props.repository.name}/commit/${commit.oid}`,
            title: `${commit.author.name} · ${d(commit.author.timestamp * 1000, "long")} · ${commit.summary}`,
          }
        : { summary: t("blameOlder"), author: "", age: "", href: null, title: t("blameOlder") }
    );
  }
  return rows;
});
const unattributed = computed(() =>
  (blame.value?.hunks ?? [])
    .filter((hunk) => hunk.commitOid === null)
    .reduce((total, hunk) => total + hunk.lineCount, 0)
);

async function load() {
  const current = ++version;
  loading.value = true;
  error.value = "";
  unavailable.value = false;
  blame.value = null;
  file.value = null;
  try {
    const refs = await api.refs(props.repository.id);
    const pinned = resolveCommitOid(refs, refName.value) ?? refName.value;
    const [blameData, fileData] = await Promise.all([
      api.blame(props.repository.id, pinned, path.value),
      api.file(props.repository.id, pinned, path.value),
    ]);
    if (current !== version) return;
    if (fileData.content === null || blameData.blobOid !== fileData.oid) {
      unavailable.value = true;
      return;
    }
    blame.value = blameData;
    file.value = fileData;
  } catch (cause) {
    if (current !== version) return;
    if (cause instanceof ApiError && cause.status === 422) unavailable.value = true;
    else error.value = errorMessage(cause, t);
  } finally {
    if (current === version) loading.value = false;
  }
}

watch([() => props.repository.id, refName, path], load, { immediate: true });
</script>

<template>
  <section class="box blame-panel">
    <div class="box-header">
      <AppIcon name="file" />
      <h2>{{ t("blame") }} · {{ path }}</h2>
      <RouterLink class="btn btn-sm" :to="location('blob')">{{ t("viewFileNormal") }}</RouterLink>
      <RouterLink class="btn btn-sm" :to="location('history')"
        ><AppIcon name="clock" />{{ t("fileHistory") }}</RouterLink
      >
    </div>
    <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    <NoticeBar v-if="unavailable" intent="info">{{ t("blameUnavailable") }}</NoticeBar>
    <template v-if="blame && file && !loading && !error">
      <NoticeBar v-if="blame.partial" intent="warning">{{
        t("blamePartial", { commits: blame.inspected, count: unattributed })
      }}</NoticeBar>
      <CodeLines
        ref="codeLines"
        :lines="lines"
        :label="path"
        :selection="selection"
        :wrap="false"
        :tab-size="preferencesState.tabSize"
        :blame="gutter"
        @select="select"
      />
    </template>
  </section>
</template>
