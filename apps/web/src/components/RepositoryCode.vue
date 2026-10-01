<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type {
  AgentSession,
  GitCommit,
  GitComparison,
  GitFile,
  GitGraph,
  GitRef,
  GitTree,
  Repository,
} from "../lib/api";
import { ApiError, api } from "../lib/api";
import StatusState from "./StatusState.vue";

const props = defineProps<{ repository: Repository; section: string }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const refs = ref<GitRef[]>([]);
const tree = ref<GitTree | null>(null);
const file = ref<GitFile | null>(null);
const graph = ref<GitGraph | null>(null);
const commits = ref<GitCommit[]>([]);
const comparison = ref<GitComparison | null>(null);
const loading = ref(false);
const error = ref("");
const emptyReason = ref("");
const offset = ref(0);
const hasMoreCommits = ref(false);
const limit = 50;
const token = ref<{ remote: string; token: string; expiresAt: number } | null>(null);
const tokenScope = ref<"read" | "write">("read");
const tokenBusy = ref(false);
const refName = computed(() =>
  String(route.params.ref || route.query.ref || props.repository.defaultBranch)
);
const filePath = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join("/") : String(value || "");
});
const isBlob = computed(
  () => String(route.params.view || "") === "blob" || route.path.includes("/blob/")
);
const branchRefs = computed(() => refs.value.filter((item) => item.name.startsWith("refs/heads/")));
const tagRefs = computed(() => refs.value.filter((item) => item.name.startsWith("refs/tags/")));
const shortRefs = (items: GitRef[]) =>
  items.map((item) => ({ ...item, shortName: item.name.replace(/^refs\/(heads|tags)\//, "") }));
const graphLayout = computed(() => {
  const list = graph.value?.commits ?? [];
  const index = new Map(list.map((commit, row) => [commit.oid, row]));
  const lanes: string[] = [];
  const points: Array<{ commit: GitCommit; row: number; lane: number }> = [];
  const edges: Array<{ fromRow: number; fromLane: number; toRow: number; toLane: number }> = [];
  for (const [row, commit] of list.entries()) {
    let lane = lanes.indexOf(commit.oid);
    if (lane < 0) {
      lane = lanes.findIndex((value) => !value);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = commit.oid;
    }
    points.push({ commit, row, lane });
    const parents = commit.parents.filter((parent) => index.has(parent));
    if (parents.length === 0) lanes[lane] = "";
    parents.forEach((parent, parentIndex) => {
      const toRow = index.get(parent);
      if (toRow === undefined) return;
      let toLane = lanes.indexOf(parent);
      if (toLane < 0) {
        toLane = parentIndex === 0 ? lane : lanes.findIndex((value) => !value);
        if (toLane < 0) toLane = lanes.length;
        lanes[toLane] = parent;
      }
      edges.push({ fromRow: row, fromLane: lane, toRow, toLane });
    });
    if (parents.length > 0 && lanes[lane] === commit.oid) lanes[lane] = parents[0];
  }
  return {
    points,
    edges,
    width: Math.max(1, ...points.map((point) => point.lane + 1)) * 22 + 16,
    height: points.length * 42 + 10,
  };
});
const commitRefs = computed(() => {
  const index = new Map<string, string[]>();
  for (const item of refs.value) {
    const names = index.get(item.oid) ?? [];
    names.push(item.name.replace(/^refs\/(heads|tags)\//, ""));
    index.set(item.oid, names);
  }
  return index;
});
function hasSessionBase(session: AgentSession): session is AgentSession & { baseOid: string } {
  return session.baseOid !== null;
}
const sessionByOid = computed(
  () =>
    new Map(
      (graph.value?.sessions ?? []).filter(hasSessionBase).map((item) => [item.baseOid, item])
    )
);
const title = computed(() => filePath.value.split("/").at(-1) || props.repository.name);
const compareBase = computed({
  get: () => String(route.query.base || props.repository.defaultBranch),
  set: (value: string) => {
    void router.replace({ query: { ...route.query, base: value } });
  },
});
const defaultCompareHead = computed(
  () =>
    shortRefs(branchRefs.value).find((item) => item.shortName !== props.repository.defaultBranch)
      ?.shortName || props.repository.defaultBranch
);
const compareHead = computed({
  get: () => String(route.query.head || defaultCompareHead.value),
  set: (value: string) => {
    void router.replace({ query: { ...route.query, head: value } });
  },
});
let requestVersion = 0;

function showError(cause: unknown) {
  error.value =
    cause instanceof ApiError && cause.status === 404
      ? t("resourceNotFound")
      : cause instanceof ApiError && cause.status === 403
        ? t("permissionDenied")
        : t("apiError");
}
async function load() {
  const version = ++requestVersion;
  loading.value = true;
  error.value = "";
  emptyReason.value = "";
  tree.value = null;
  file.value = null;
  graph.value = null;
  comparison.value = null;
  try {
    const refData = await api.refs(props.repository.id);
    if (version !== requestVersion) return;
    refs.value = refData;
    if (props.section === "commits") {
      const [items, graphData, activeSessions] = await Promise.all([
        api.commits(props.repository.id, refName.value, offset.value, limit),
        api.graph(props.repository.id, refName.value, 100),
        api.repositorySessions(props.repository.id).catch(() => []),
      ]);
      if (version !== requestVersion) return;
      commits.value = offset.value === 0 ? items : [...commits.value, ...items];
      hasMoreCommits.value = items.length === limit;
      graph.value = graphData;
      emptyReason.value = items.length === 0 && offset.value === 0 ? "commits" : "";
      return;
    }
    if (props.section === "compare") {
      const base = String(route.query.base || props.repository.defaultBranch);
      const head = String(route.query.head || defaultCompareHead.value);
      comparison.value = await api.compare(
        props.repository.id,
        base,
        head,
        route.query.headSessionId?.toString()
      );
      return;
    }
    if (isBlob.value && filePath.value) {
      file.value = await api.file(props.repository.id, refName.value, filePath.value);
      return;
    }
    tree.value = await api.tree(props.repository.id, refName.value, filePath.value);
    if (
      !filePath.value &&
      tree.value.entries.some((entry) => entry.name.toLowerCase() === "readme.md")
    ) {
      const readme = tree.value.entries.find((entry) => entry.name.toLowerCase() === "readme.md");
      if (readme) file.value = await api.file(props.repository.id, refName.value, readme.path);
    }
    emptyReason.value = tree.value.entries.length === 0 ? "tree" : "";
  } catch (cause) {
    if (version !== requestVersion) return;
    showError(cause);
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
async function loadMore() {
  offset.value = commits.value.length;
  await load();
}
async function changeRef(value: string) {
  offset.value = 0;
  commits.value = [];
  await router.push({
    path: `/${props.repository.owner}/${props.repository.name}`,
    query: value ? { ref: value } : {},
  });
}
function handleRefChange(event: Event) {
  const target = event.target;
  if (target instanceof HTMLSelectElement) void changeRef(target.value);
}
function copyRemote() {
  void navigator.clipboard.writeText(props.repository.remote);
}
function openTree(path: string, type: "tree" | "blob") {
  router.push(
    `/${props.repository.owner}/${props.repository.name}/${type}/${encodeURIComponent(refName.value)}/${path.split("/").map(encodeURIComponent).join("/")}`
  );
}
async function issueToken() {
  tokenBusy.value = true;
  error.value = "";
  try {
    token.value = await api.repositoryToken(props.repository.id, {
      scope: tokenScope.value,
      ttlSeconds: 3600,
    });
  } catch (cause) {
    showError(cause);
  } finally {
    tokenBusy.value = false;
  }
}
function clearToken() {
  token.value = null;
}
function downloadText() {
  if (!file.value?.content) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([file.value.content], { type: "text/plain;charset=utf-8" })
  );
  link.download = title.value;
  link.click();
  URL.revokeObjectURL(link.href);
}
let previousRepositoryId = props.repository.id;
let previousSection = props.section;
let previousRef = refName.value;
watch(
  () => [
    props.repository.id,
    props.section,
    refName.value,
    filePath.value,
    isBlob.value,
    route.query.base,
    route.query.head,
  ],
  () => {
    const resetCommits =
      previousRepositoryId !== props.repository.id ||
      previousSection !== props.section ||
      previousRef !== refName.value;
    if (resetCommits) {
      offset.value = 0;
      commits.value = [];
      hasMoreCommits.value = false;
    }
    previousRepositoryId = props.repository.id;
    previousSection = props.section;
    previousRef = refName.value;
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="code-section">
    <div v-if="section === 'code'" class="code-toolbar">
      <label class="ref-picker"
        >{{ t("branchOrTag") }}
        <select :value="refName" @change="handleRefChange">
          <optgroup :label="t('branches')">
            <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </optgroup>
          <optgroup v-if="tagRefs.length" :label="t('tags')">
            <option v-for="item in shortRefs(tagRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </optgroup>
        </select>
      </label>
      <RouterLink
        class="button ghost"
        :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
        >{{ t("commitGraph") }}</RouterLink
      >
      <RouterLink class="button ghost" :to="`/${repository.owner}/${repository.name}/compare`">{{
        t("compare")
      }}</RouterLink>
      <div class="clone-control">
        <span>{{ t("cloneUrl") }}</span
        ><code>{{ repository.remote }}</code
        ><button class="text-button" @click="copyRemote">{{ t("copy") }}</button>
      </div>
      <template v-if="repository.canWrite"
        ><select v-model="tokenScope">
          <option value="read">{{ t("readToken") }}</option>
          <option value="write">{{ t("writeToken") }}</option></select
        ><button class="button" :disabled="tokenBusy" @click="issueToken">
          {{ t("createCloneToken") }}
        </button></template
      >
    </div>
    <div v-if="token" class="token-once panel">
      <div>
        <strong>{{ t("tokenShownOnce") }}</strong>
        <p>{{ t("tokenExpiry", { date: new Date(token.expiresAt).toLocaleString() }) }}</p>
      </div>
      <code>{{ token.token }}</code
      ><code>{{ token.remote }}</code
      ><button class="button" @click="clearToken">{{ t("close") }}</button>
    </div>
    <div v-if="loading || error" class="content-card">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <template v-else-if="section === 'code'">
      <div class="browser-grid">
        <section class="content-card file-panel">
          <div class="panel-heading">
            <strong>{{ filePath || refName }}</strong
            ><span>{{ tree?.entries.length ?? 0 }} {{ t("items") }}</span>
          </div>
          <div v-if="filePath" class="file-entry">
            <button
              class="text-button"
              @click="
                router.push(
                  `/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`
                )
              "
            >
              ↑ {{ t("repositoryRoot") }}
            </button>
          </div>
          <button
            v-for="entry in tree?.entries"
            :key="entry.path"
            class="file-entry"
            @click="openTree(entry.path, entry.type === 'tree' ? 'tree' : 'blob')"
          >
            <span class="file-type">{{ entry.type === "tree" ? "▸" : "·" }}</span
            ><span>{{ entry.name }}</span
            ><small>{{ entry.type === "tree" ? t("directory") : entry.oid.slice(0, 8) }}</small>
          </button>
          <div v-if="emptyReason === 'tree'" class="empty-inline">{{ t("emptyTree") }}</div>
        </section>
        <section v-if="file || emptyReason === 'tree'" class="content-card preview-panel">
          <template v-if="file"
            ><div class="panel-heading">
              <strong>{{ title }}</strong
              ><button class="text-button" @click="downloadText">{{ t("download") }}</button>
            </div>
            <p v-if="file.binary || file.content === null" class="muted">
              {{ t("binaryPreviewUnavailable") }}
            </p>
            <pre v-else class="text-preview">{{ file.content }}</pre>
          </template>
        </section>
      </div>
      <section
        v-if="file?.path.toLowerCase().endsWith('.md') && file.content !== null"
        class="content-card readme-panel"
      >
        <p class="eyebrow">{{ t("readme") }}</p>
        <h2>{{ title }}</h2>
        <pre class="text-preview">{{ file.content }}</pre>
      </section>
    </template>
    <template v-else-if="section === 'commits'">
      <section class="content-card graph-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">{{ t("commitGraph") }}</p>
            <strong>{{ refName }}</strong>
          </div>
          <span v-if="graph?.truncated" class="muted">{{ t("graphLimit") }}</span>
        </div>
        <p v-if="!graph?.commits.length && !loading" class="empty-inline">{{ t("noCommits") }}</p>
        <div v-else class="graph-scroll">
          <svg
            :width="graphLayout.width"
            :height="graphLayout.height"
            role="img"
            :aria-label="t('commitGraph')"
          >
            <line
              v-for="(edge, i) in graphLayout.edges"
              :key="`edge-${i}`"
              :x1="12 + edge.fromLane * 22"
              :y1="20 + edge.fromRow * 42"
              :x2="12 + edge.toLane * 22"
              :y2="20 + edge.toRow * 42"
              :stroke="edge.fromLane === edge.toLane ? '#8b83f7' : '#d5a36a'"
              stroke-width="2"
            />
            <circle
              v-for="point in graphLayout.points"
              :key="point.commit.oid"
              :cx="12 + point.lane * 22"
              :cy="20 + point.row * 42"
              r="5"
              :fill="sessionByOid.has(point.commit.oid) ? '#e6c99a' : '#8b83f7'"
            />
          </svg>
        </div>
        <div
          v-for="point in graphLayout.points"
          :key="point.commit.oid"
          class="commit-row"
          :style="{ paddingLeft: `${graphLayout.width + 10}px` }"
        >
          <RouterLink
            :to="{
              path: `/${repository.owner}/${repository.name}/commits`,
              query: { ref: refName, oid: point.commit.oid },
            }"
            class="commit-subject"
            >{{ point.commit.message.split("\n")[0] }}</RouterLink
          ><code>{{ point.commit.oid.slice(0, 8) }}</code
          ><span v-for="name in commitRefs.get(point.commit.oid)" :key="name" class="badge">{{
            name
          }}</span
          ><span v-if="sessionByOid.get(point.commit.oid)" class="badge agent-badge"
            >{{ t("agentSession") }} · {{ sessionByOid.get(point.commit.oid)?.workspaceName }}</span
          ><small
            >{{ point.commit.author.name }} ·
            {{ new Date(point.commit.author.timestamp * 1000).toLocaleString() }}</small
          >
        </div>
        <div v-if="graph?.sessions.length" class="session-overlay">
          <strong>{{ t("agentSessions") }}</strong
          ><span v-for="session in graph.sessions" :key="session.id"
            >{{ session.agentName }} / {{ session.workspaceName }} · {{ session.status }}</span
          >
        </div>
        <button v-if="hasMoreCommits" class="button" @click="loadMore">
          {{ t("loadMore") }}
        </button>
      </section>
      <section v-if="route.query.oid" class="content-card commit-detail">
        <p class="eyebrow">{{ t("commitDetails") }}</p>
        <code>{{ route.query.oid }}</code>
        <p
          v-for="commit in commits.filter((item) => item.oid === route.query.oid)"
          :key="commit.oid"
        >
          {{ commit.message }}
        </p>
        <strong>{{ t("parents") }}</strong>
        <div
          v-for="parent in commits.find((item) => item.oid === route.query.oid)?.parents"
          :key="parent"
        >
          <RouterLink
            :to="{
              path: `/${repository.owner}/${repository.name}/commits`,
              query: { ref: refName, oid: parent },
            }"
            >{{ parent }}</RouterLink
          >
        </div>
      </section>
    </template>
    <section v-else class="content-card compare-panel">
      <p class="eyebrow">{{ t("compare") }}</p>
      <div class="compare-form">
        <label
          >{{ t("baseBranch")
          }}<select v-model="compareBase">
            <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </select></label
        ><label
          >{{ t("headBranch")
          }}<select v-model="compareHead">
            <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </select></label
        ><button class="button primary" @click="load">{{ t("compare") }}</button>
      </div>
      <p v-if="comparison" class="muted">
        {{ comparison.commits.length }} {{ t("commits") }} · {{ comparison.files.length }}
        {{ t("changedFiles") }}
      </p>
      <div v-for="change in comparison?.files" :key="change.path" class="item-row">
        <strong>{{ change.path }}</strong
        ><span class="badge">{{ change.type }}</span>
        <pre v-if="change.patch" class="diff-preview">{{ change.patch }}</pre>
      </div>
    </section>
  </section>
</template>

<style scoped>
.code-section {
  display: grid;
  gap: 18px;
}
.code-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 14px;
  background: var(--surface);
  border: 1px solid var(--line);
}
.code-toolbar select,
.compare-form select {
  color: inherit;
  background: var(--lift);
  border: 1px solid var(--line);
  padding: 8px;
}
.ref-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 12px;
}
.clone-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 320px;
  color: var(--muted);
  font-size: 12px;
}
.clone-control code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--lift);
  padding: 7px;
  color: var(--warm);
}
.browser-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
  gap: 18px;
}
.content-card {
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 16px;
  min-width: 0;
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.panel-heading span,
.file-entry small,
.commit-row small {
  color: var(--muted);
}
.file-entry {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 0;
  border-bottom: 1px solid #2c2932;
  padding: 8px 4px;
}
.file-entry:hover {
  background: var(--lift);
}
.file-entry small {
  margin-left: auto;
  font-family: monospace;
}
.file-type {
  color: var(--accent);
}
.empty-inline {
  padding: 24px;
  text-align: center;
  color: var(--muted);
}
.text-preview,
.diff-preview {
  overflow: auto;
  max-height: 70vh;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #d4d0dc;
  font:
    12px/1.65 "IBM Plex Mono",
    monospace;
}
.readme-panel {
  margin-top: 18px;
}
.readme-panel h2 {
  margin-top: 0;
}
.graph-panel {
  position: relative;
  overflow: hidden;
}
.graph-scroll {
  position: absolute;
  left: 12px;
  top: 86px;
  pointer-events: none;
}
.commit-row {
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  border-bottom: 1px solid #2c2932;
  color: var(--muted);
  font-size: 12px;
}
.commit-subject {
  color: #eee;
  flex: 1;
}
.commit-row code,
.commit-detail code {
  color: var(--warm);
  font: 11px monospace;
}
.badge.agent-badge {
  color: var(--warm);
  border-color: #625640;
}
.session-overlay {
  display: grid;
  gap: 5px;
  padding-top: 14px;
  color: var(--muted);
  font-size: 12px;
}
.token-once {
  display: grid;
  gap: 12px;
  overflow-wrap: anywhere;
}
.token-once p {
  margin: 5px 0 0;
  color: var(--muted);
}
.token-once code {
  padding: 10px;
  background: var(--lift);
  color: var(--warm);
}
.compare-form {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}
.compare-form label {
  display: grid;
  gap: 6px;
  color: var(--muted);
}
.diff-preview {
  flex-basis: 100%;
  width: 100%;
  max-height: 320px;
}
.item-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
@media (max-width: 720px) {
  .browser-grid {
    grid-template-columns: 1fr;
  }
  .commit-row {
    padding-left: 46px !important;
  }
}
</style>
