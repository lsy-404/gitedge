<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type {
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
import { clearOneTimeToken, isCredentialExpired } from "../lib/credentialSecurity";
import { authenticatedCloneCommand, gatewayCloneUrl } from "../lib/gitClone";
import { sessionState } from "../lib/session";
import {
  agentSessionDisplayStatus,
  findGraphCommit,
  projectGitGraph,
  repositoryCodeLocation,
  type GraphSessionMarker,
} from "../lib/gitGraphView";

const props = defineProps<{ repository: Repository; section: string }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const refs = ref<GitRef[]>([]);
const tree = ref<GitTree | null>(null);
const file = ref<GitFile | null>(null);
const graph = ref<GitGraph | null>(null);
const commits = ref<GitCommit[]>([]);
const selectedCommit = computed(() =>
  findGraphCommit(String(route.query.oid || ""), graph.value, commits.value)
);
const graphView = computed(() => (graph.value ? projectGitGraph(graph.value) : null));
const now = ref(Date.now());
const comparison = ref<GitComparison | null>(null);
const loading = ref(false);
const error = ref("");
const emptyReason = ref("");
const offset = ref(0);
const hasMoreCommits = ref(false);
const limit = 50;
const token = ref<{ id: string; token: string; expiresAt: number } | null>(null);
const tokenName = ref("");
const cloneUrl = computed(() =>
  gatewayCloneUrl(window.location.origin, props.repository.owner, props.repository.name)
);
const cloneCommand = computed(() =>
  token.value?.token
    ? authenticatedCloneCommand(cloneUrl.value, token.value.token)
    : `git clone ${cloneUrl.value}`
);
const canCreateCloneToken = computed(() => props.repository.canWrite && sessionState.user !== null);
const tokenScope = ref<"read" | "write">("read");
const tokenBusy = ref(false);
const tokenExpired = ref(false);
let tokenExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let tokenRequestVersion = 0;
let clockTimer: ReturnType<typeof setInterval> | undefined;
const refName = computed(() => String(route.query.ref || props.repository.defaultBranch));
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
    rowHeight: 72,
    height: points.length * 72,
  };
});
const commitRefs = computed(() => graphView.value?.refsByOid ?? new Map<string, string[]>());
const sessionMarkers = computed(
  () => graphView.value?.sessionsByOid ?? new Map<string, GraphSessionMarker[]>()
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
      const [items, graphData] = await Promise.all([
        api.commits(props.repository.id, refName.value, offset.value, limit),
        api.graph(props.repository.id, refName.value, 100),
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
      const result = await api.compare(
        props.repository.id,
        base,
        head,
        route.query.headSessionId?.toString()
      );
      if (version !== requestVersion) return;
      comparison.value = result;
      return;
    }
    if (isBlob.value && filePath.value) {
      const fileData = await api.file(props.repository.id, refName.value, filePath.value);
      if (version !== requestVersion) return;
      file.value = fileData;
      return;
    }
    const treeData = await api.tree(props.repository.id, refName.value, filePath.value);
    if (version !== requestVersion) return;
    tree.value = treeData;
    if (
      !filePath.value &&
      tree.value.entries.some((entry) => entry.name.toLowerCase() === "readme.md")
    ) {
      const readme = tree.value.entries.find((entry) => entry.name.toLowerCase() === "readme.md");
      if (readme) {
        const readmeFile = await api.file(props.repository.id, refName.value, readme.path);
        if (version !== requestVersion) return;
        file.value = readmeFile;
      }
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
function selectCommit(oid: string) {
  void router.push({
    path: `/${props.repository.owner}/${props.repository.name}/commits`,
    query: { ref: refName.value, oid },
  });
}
function handleCommitKeydown(event: KeyboardEvent, oid: string) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectCommit(oid);
  }
}
function copyCloneUrl() {
  void navigator.clipboard.writeText(cloneUrl.value);
}
function copyCloneCommand() {
  void navigator.clipboard.writeText(cloneCommand.value);
}
function openTree(path: string, type: "tree" | "blob") {
  void router.push(
    repositoryCodeLocation(props.repository.owner, props.repository.name, type, path, refName.value)
  );
}
async function issueToken() {
  tokenBusy.value = true;
  error.value = "";
  const repositoryId = props.repository.id;
  const requestVersion = ++tokenRequestVersion;
  try {
    const issuedToken = await api.createCloneToken({
      repositoryId,
      name: tokenName.value.trim(),
      permission: tokenScope.value,
      ttlSeconds: 3600,
    });
    if (requestVersion !== tokenRequestVersion || repositoryId !== props.repository.id) return;
    token.value = issuedToken;
    tokenExpired.value = isCredentialExpired(issuedToken.expiresAt, Date.now());
    if (tokenExpired.value) token.value = clearOneTimeToken(issuedToken);
    clearTimeout(tokenExpiryTimer);
    if (!tokenExpired.value) {
      tokenExpiryTimer = setTimeout(
        () => {
          if (requestVersion !== tokenRequestVersion || !token.value) return;
          token.value = clearOneTimeToken(token.value);
          tokenExpired.value = true;
        },
        Math.max(0, issuedToken.expiresAt - Date.now())
      );
    }
  } catch (cause) {
    if (requestVersion === tokenRequestVersion) showError(cause);
  } finally {
    if (requestVersion === tokenRequestVersion) tokenBusy.value = false;
  }
}
function clearToken() {
  tokenRequestVersion += 1;
  tokenBusy.value = false;
  token.value = null;
  tokenExpired.value = false;
  clearTimeout(tokenExpiryTimer);
  tokenExpiryTimer = undefined;
}
function sessionForkRefs(sessionId: string) {
  return graph.value?.refs.filter((item) => item.name.startsWith(`session/${sessionId}/`)) ?? [];
}
function sessionStatus(session: NonNullable<typeof graph.value>["sessions"][number]): string {
  return t(agentSessionDisplayStatus(session, now.value));
}
function sessionPermission(session: NonNullable<typeof graph.value>["sessions"][number]): string {
  return t(session.permission === "read" ? "readOnly" : "writeAccess");
}
function sessionMarkerLabel(marker: GraphSessionMarker): string {
  return `${marker.session.agentName} / ${marker.session.workspaceName} · ${t(marker.kind === "base" ? "sessionBase" : "sessionForkTip")}`;
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
      if (previousRepositoryId !== props.repository.id) clearToken();
    }
    previousRepositoryId = props.repository.id;
    previousSection = props.section;
    previousRef = refName.value;
    void load();
  },
  { immediate: true }
);
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onUnmounted(() => {
  clearInterval(clockTimer);
  clearTimeout(tokenExpiryTimer);
  tokenRequestVersion += 1;
});
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
        class="btn ghost"
        :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
        >{{ t("commitGraph") }}</RouterLink
      >
      <RouterLink class="btn ghost" :to="`/${repository.owner}/${repository.name}/compare`">{{
        t("compare")
      }}</RouterLink>
      <div class="clone-control">
        <span>{{ t("cloneUrl") }}</span
        ><code>{{ cloneUrl }}</code
        ><button class="text-button" @click="copyCloneUrl">{{ t("copy") }}</button>
      </div>
      <template v-if="canCreateCloneToken">
        <input
          v-model="tokenName"
          class="token-name-input"
          maxlength="80"
          required
          :placeholder="t('cloneTokenName')"
        />
        <select v-model="tokenScope">
          <option value="read">{{ t("readToken") }}</option>
          <option value="write">{{ t("writeToken") }}</option>
        </select>
        <button class="btn" :disabled="tokenBusy || !tokenName.trim()" @click="issueToken">
          {{ t("createCloneToken") }}
        </button>
      </template>
    </div>
    <div v-if="token" class="token-once box box-form">
      <div>
        <strong>{{ t(tokenExpired ? "tokenExpired" : "tokenShownOnce") }}</strong>
        <p>{{ t("tokenExpiry", { date: new Date(token.expiresAt).toLocaleString() }) }}</p>
      </div>
      <code v-if="!tokenExpired">{{ token.token }}</code>
      <code>{{ cloneUrl }}</code>
      <code v-if="!tokenExpired">{{ cloneCommand }}</code>
      <button v-if="!tokenExpired" class="btn" @click="copyCloneCommand">
        {{ t("copyCloneCommand") }}
      </button>
      <button class="btn" @click="clearToken">{{ t("close") }}</button>
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
          <span v-if="graph?.truncated" class="muted">{{
            t("graphTruncated", { count: graph.commits.length })
          }}</span>
        </div>
        <p v-if="!graph?.commits.length && !loading" class="empty-inline">{{ t("noCommits") }}</p>
        <div v-else class="graph-history">
          <div class="graph-scroll">
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
                :y1="20 + edge.fromRow * graphLayout.rowHeight"
                :x2="12 + edge.toLane * 22"
                :y2="20 + edge.toRow * graphLayout.rowHeight"
                :stroke="edge.fromLane === edge.toLane ? '#8b83f7' : '#d5a36a'"
                stroke-width="2"
              />
              <circle
                v-for="point in graphLayout.points"
                :key="point.commit.oid"
                :cx="12 + point.lane * 22"
                :cy="20 + point.row * graphLayout.rowHeight"
                r="5"
                tabindex="0"
                role="link"
                :aria-label="`${t('openCommit')} ${point.commit.oid}`"
                :fill="
                  (sessionMarkers.get(point.commit.oid)?.length ?? 0) > 0 ? '#e6c99a' : '#8b83f7'
                "
                @click="selectCommit(point.commit.oid)"
                @keydown="handleCommitKeydown($event, point.commit.oid)"
              />
            </svg>
          </div>
          <div
            v-for="point in graphLayout.points"
            :key="point.commit.oid"
            class="commit-row"
            :style="{
              paddingLeft: `${graphLayout.width + 10}px`,
              height: `${graphLayout.rowHeight}px`,
            }"
          >
            <div class="commit-title">
              <RouterLink
                :to="{
                  path: `/${repository.owner}/${repository.name}/commits`,
                  query: { ref: refName, oid: point.commit.oid },
                }"
                class="commit-subject"
                >{{ point.commit.message.split("\n")[0] }}</RouterLink
              ><code>{{ point.commit.oid.slice(0, 8) }}</code>
              <small
                >{{ point.commit.author.name }} ·
                {{ new Date(point.commit.author.timestamp * 1000).toLocaleString() }}</small
              >
            </div>
            <div class="commit-labels">
              <span v-for="name in commitRefs.get(point.commit.oid)" :key="name" class="pill">{{
                name
              }}</span
              ><span
                v-for="marker in sessionMarkers.get(point.commit.oid)"
                :key="`${marker.session.id}-${marker.kind}-${marker.branchName}`"
                class="pill agent-badge"
                >{{ sessionMarkerLabel(marker) }} · {{ sessionPermission(marker.session) }}</span
              >
            </div>
          </div>
        </div>
        <div v-if="graph?.sessions.length" class="session-overlay">
          <strong>{{ t("agentSessions") }}</strong>
          <p>
            {{
              t("forkRefSummary", {
                refs: graphView?.sessionForkRefCount ?? 0,
                sessions: graphView?.sessionsWithForkRefs ?? 0,
                total: graphView?.visibleSessionCount ?? 0,
              })
            }}
          </p>
          <p v-if="(graphView?.sessionsWithoutForkRefs ?? 0) > 0" class="muted">
            {{ t("forkRefsMissing", { count: graphView?.sessionsWithoutForkRefs ?? 0 }) }}
          </p>
          <div v-for="session in graph.sessions" :key="session.id" class="session-overlay-row">
            <RouterLink
              v-if="session.baseOid"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: refName, oid: session.baseOid },
              }"
              >{{ session.agentName }} / {{ session.workspaceName }} ·
              {{ t("sessionBase") }}</RouterLink
            >
            <span v-else>{{ session.agentName }} / {{ session.workspaceName }}</span>
            <small
              >{{ sessionPermission(session) }} · {{ sessionStatus(session) }} ·
              {{ new Date(session.expiresAt).toLocaleString() }}</small
            >
            <RouterLink
              v-for="forkRef in sessionForkRefs(session.id)"
              :key="forkRef.name"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: refName, oid: forkRef.oid },
              }"
              >{{ forkRef.name.slice(`session/${session.id}/`.length) }} ·
              {{ forkRef.oid.slice(0, 8) }}</RouterLink
            >
          </div>
        </div>
        <button v-if="hasMoreCommits" class="btn" @click="loadMore">
          {{ t("loadMore") }}
        </button>
      </section>
      <section v-if="route.query.oid" class="content-card commit-detail">
        <p class="eyebrow">{{ t("commitDetails") }}</p>
        <code>{{ route.query.oid }}</code>
        <p v-if="selectedCommit">{{ selectedCommit.message }}</p>
        <p v-else class="muted">{{ t("commitNotInGraph") }}</p>
        <strong>{{ t("parents") }}</strong>
        <div v-for="parent in selectedCommit?.parents" :key="parent">
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
        ><button class="btn primary" @click="load">{{ t("compare") }}</button>
      </div>
      <p v-if="comparison" class="muted">
        {{ comparison.commits.length }} {{ t("commits") }} · {{ comparison.files.length }}
        {{ t("changedFiles") }}
      </p>
      <div v-for="change in comparison?.files" :key="change.path" class="item-row">
        <strong>{{ change.path }}</strong
        ><span class="pill">{{ change.type }}</span>
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
.code-toolbar input,
.compare-form select {
  color: inherit;
  background: var(--subtle);
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
  background: var(--subtle);
  padding: 7px;
  color: var(--link);
}
.browser-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
  gap: 18px;
}
.content-card {
  border-radius: 6px;
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
  border-bottom: 1px solid var(--line-soft);
  padding: 8px 4px;
}
.file-entry:hover {
  background: var(--subtle);
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
  color: var(--text);
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
.graph-history {
  position: relative;
}
.graph-scroll {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
.commit-row {
  padding-block: 8px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--muted);
  font-size: 12px;
}
.commit-title {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 24px;
  min-width: 0;
}
.commit-title small {
  white-space: nowrap;
}
.commit-labels {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  min-width: 0;
}
.commit-labels .pill {
  flex-shrink: 0;
}
.commit-subject {
  color: var(--strong);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-row code,
.commit-detail code {
  color: var(--link);
  font: 11px monospace;
}
.pill.agent-badge {
  color: var(--link);
  border-color: var(--line);
}
.session-overlay-row {
  display: grid;
  gap: 4px;
  border-top: 1px solid var(--line);
  padding: 8px 0;
}
.graph-scroll svg circle {
  pointer-events: all;
  cursor: pointer;
}
.session-overlay-row small {
  color: var(--muted);
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
  background: var(--subtle);
  color: var(--link);
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
  .commit-title small {
    display: none;
  }
}
</style>
