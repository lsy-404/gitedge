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
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import { oneOf } from "../ui/formEvents";
import { clearOneTimeToken, isCredentialExpired } from "../lib/credentialSecurity";
import { authenticatedCloneCommand, gatewayCloneUrl } from "../lib/gitClone";
import { sessionState } from "../lib/session";
import {
  agentSessionDisplayStatus,
  findGraphCommit,
  layoutGitGraph,
  projectGitGraph,
  repositoryCodeLocation,
  type GraphSessionMarker,
} from "../lib/gitGraphView";
import TextField from "./TextField.vue";
import { highlightedCode } from "../lib/markdown";
import MarkdownContent from "./MarkdownContent.vue";

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
const tokenScopes = ["read", "write"] as const;
const tokenScope = ref<(typeof tokenScopes)[number]>("read");
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
const graphLayout = computed(() => layoutGitGraph(graph.value?.commits ?? []));
const commitRefs = computed(() => graphView.value?.refsByOid ?? new Map<string, string[]>());
const sessionMarkers = computed(
  () => graphView.value?.sessionsByOid ?? new Map<string, GraphSessionMarker[]>()
);
const title = computed(() => filePath.value.split("/").at(-1) || props.repository.name);
const queryText = ref("");
const showFileSearch = ref(false);
const showCloneMenu = ref(false);
const filteredEntries = computed(() =>
  (tree.value?.entries ?? []).filter((entry) =>
    entry.name.toLocaleLowerCase().includes(queryText.value.trim().toLocaleLowerCase())
  )
);
const latestCommit = computed(() => graph.value?.commits[0] ?? commits.value[0] ?? null);
const readmeEntry = computed(
  () => tree.value?.entries.find((entry) => entry.name.toLocaleLowerCase() === "readme.md") ?? null
);
const breadcrumbs = computed(() => filePath.value.split("/").filter(Boolean));
const highlightedLines = computed(() =>
  (file.value?.content ?? "").split("\n").map((line) => highlightedCode(line, file.value?.path))
);
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
    if (props.section === "code" && !filePath.value) {
      commits.value = await api.commits(props.repository.id, refName.value, 0, 1);
      if (version !== requestVersion) return;
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
function rawFile() {
  if (!file.value?.content) return;
  const url = URL.createObjectURL(new Blob([file.value.content], { type: "text/plain" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function fileHref(path: string, view: "tree" | "blob" = "blob") {
  return repositoryCodeLocation(
    props.repository.owner,
    props.repository.name,
    view,
    path,
    refName.value
  );
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
      <div class="toolbar-row code-controls">
        <SelectField
          class="ref-picker"
          :model-value="refName"
          :label="t('branchOrTag')"
          @update:model-value="changeRef"
        >
          <fluent-option
            v-for="item in shortRefs(branchRefs)"
            :key="item.name"
            :value="item.shortName"
          >
            {{ item.shortName }}
          </fluent-option>
          <fluent-option
            v-for="item in shortRefs(tagRefs)"
            :key="item.name"
            :value="item.shortName"
          >
            {{ item.shortName }} · {{ t("tags") }}
          </fluent-option>
        </SelectField>
        <span class="repo-count"
          >{{ branchRefs.length }} {{ t("branches") }} · {{ tagRefs.length }} {{ t("tags") }}</span
        >
        <label v-if="showFileSearch" class="file-search">
          <AppIcon name="search" />
          <input
            v-model="queryText"
            autofocus
            :placeholder="t('codeSearchPlaceholder')"
            @keydown.esc="showFileSearch = false"
          />
        </label>
        <fluent-button
          v-else
          class="search-trigger"
          appearance="outline"
          @click="showFileSearch = true"
          ><AppIcon slot="start" name="search" />{{ t("goToFile") }}</fluent-button
        >
        <div class="clone-menu-wrap">
          <fluent-button appearance="primary" @click="showCloneMenu = !showCloneMenu"
            ><AppIcon slot="start" name="code" />{{ t("codeMenu") }}
            <AppIcon slot="end" name="chevron"
          /></fluent-button>
          <div v-if="showCloneMenu" class="clone-menu box">
            <strong>{{ t("cloneWithHttps") }}</strong>
            <div class="clone-url">
              <code>{{ cloneUrl }}</code
              ><fluent-button
                appearance="subtle"
                icon-only
                :aria-label="t('copy')"
                @click="copyCloneUrl"
                ><AppIcon name="copy"
              /></fluent-button>
            </div>
            <p class="muted">{{ t("cloneHelp") }}</p>
            <template v-if="canCreateCloneToken">
              <TextField v-model="tokenName" maxlength="80" required>{{
                t("cloneTokenName")
              }}</TextField>
              <SelectField
                :model-value="tokenScope"
                :label="t('permission')"
                @update:model-value="tokenScope = oneOf(tokenScopes, $event, 'read')"
              >
                <fluent-option value="read">{{ t("readToken") }}</fluent-option
                ><fluent-option value="write">{{ t("writeToken") }}</fluent-option>
              </SelectField>
              <fluent-button
                type="button"
                :disabled="tokenBusy || !tokenName.trim()"
                @click="issueToken"
                >{{ t("createCloneToken") }}</fluent-button
              >
            </template>
          </div>
        </div>
      </div>
    </div>
    <div v-if="token" class="token-once box box-form">
      <div>
        <strong>{{ t(tokenExpired ? "tokenExpired" : "tokenShownOnce") }}</strong>
        <p>{{ t("tokenExpiry", { date: new Date(token.expiresAt).toLocaleString() }) }}</p>
      </div>
      <code v-if="!tokenExpired">{{ token.token }}</code>
      <code>{{ cloneUrl }}</code>
      <code v-if="!tokenExpired">{{ cloneCommand }}</code>
      <div class="form-actions">
        <fluent-button v-if="!tokenExpired" type="button" @click="copyCloneCommand">
          {{ t("copyCloneCommand") }}
        </fluent-button>
        <fluent-button type="button" @click="clearToken">{{ t("close") }}</fluent-button>
      </div>
    </div>
    <div v-if="loading || error" class="box">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <template v-else-if="section === 'code'">
      <div v-if="latestCommit && !isBlob" class="latest-commit box">
        <AppIcon name="commit" />
        <RouterLink
          :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
          ><strong>{{ latestCommit.author.name }}</strong></RouterLink
        >
        <span class="commit-message">{{ latestCommit.message.split("\n")[0] }}</span
        ><code>{{ latestCommit.oid.slice(0, 7) }}</code
        ><time>{{ new Date(latestCommit.author.timestamp * 1000).toLocaleDateString() }}</time>
      </div>
      <div v-if="!isBlob" class="box file-panel">
        <div class="file-table-head">
          <strong>{{ filePath || refName }}</strong
          ><span>{{ filteredEntries.length }} {{ t("items") }}</span>
        </div>
        <fluent-button
          v-if="filePath"
          type="button"
          appearance="transparent"
          class="file-entry"
          @click="
            router.push(
              `/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`
            )
          "
        >
          ↑ {{ t("repositoryRoot") }}
        </fluent-button>
        <RouterLink
          v-for="entry in filteredEntries"
          :key="entry.path"
          class="file-entry"
          :to="
            repositoryCodeLocation(
              repository.owner,
              repository.name,
              entry.type === 'tree' ? 'tree' : 'blob',
              entry.path,
              refName
            )
          "
        >
          <AppIcon :name="entry.type === 'tree' ? 'folder' : 'file'" /><span>{{ entry.name }}</span
          ><small>{{ entry.type === "tree" ? t("directory") : entry.oid.slice(0, 8) }}</small>
        </RouterLink>
        <div v-if="emptyReason === 'tree'" class="state">{{ t("emptyTree") }}</div>
      </div>
      <div v-if="tree?.entries.length === 0 && !loading" class="empty-repository box">
        <h2>{{ t("emptyRepositoryTitle") }}</h2>
        <p>{{ t("emptyRepositoryText") }}</p>
        <code>echo "# {{ repository.name }}" &gt; README.md</code
        ><code>git add README.md &amp;&amp; git commit -m "first commit"</code
        ><code>git branch -M {{ repository.defaultBranch }}</code
        ><code>git remote add origin {{ cloneUrl }}</code
        ><code>git push -u origin {{ repository.defaultBranch }}</code>
      </div>
      <div v-if="isBlob && file" class="file-view box">
        <div class="file-breadcrumb">
          <RouterLink
            :to="`/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`"
            >{{ repository.name }}</RouterLink
          ><template v-for="(part, index) in breadcrumbs" :key="part"
            ><AppIcon name="chevronRight" /><RouterLink
              v-if="index < breadcrumbs.length - 1"
              :to="fileHref(breadcrumbs.slice(0, index + 1).join('/'), 'tree')"
              >{{ part }}</RouterLink
            ><strong v-else>{{ part }}</strong></template
          >
        </div>
        <div class="file-actions">
          <span>{{ file.size }} {{ t("bytes") }} · {{ file.oid.slice(0, 7) }}</span>
          <div>
            <fluent-button appearance="outline" @click="rawFile">{{ t("raw") }}</fluent-button
            ><fluent-button appearance="outline" @click="downloadText"
              ><AppIcon slot="start" name="download" />{{ t("download") }}</fluent-button
            >
          </div>
        </div>
        <p v-if="file.binary || file.content === null" class="muted box-form">
          {{ t("binaryPreviewUnavailable") }}
        </p>
        <pre
          v-else
          class="code-source"
        ><span v-for="(line,index) in highlightedLines" :key="index" class="code-line"><span class="line-number">{{ index+1 }}</span><code v-html="line"></code></span></pre>
      </div>
      <aside class="about-panel box">
        <div class="box-header">
          <strong>{{ t("about") }}</strong
          ><RouterLink
            v-if="repository.canWrite"
            :to="`/${repository.owner}/${repository.name}/settings`"
            :aria-label="t('editAbout')"
            ><AppIcon name="gear"
          /></RouterLink>
        </div>
        <p>{{ repository.description || t("noDescription") }}</p>
        <dl>
          <dt>{{ t("defaultBranch") }}</dt>
          <dd><AppIcon name="branch" />{{ repository.defaultBranch }}</dd>
          <dt>{{ t("branches") }}</dt>
          <dd>{{ branchRefs.length }}</dd>
          <dt>{{ t("tags") }}</dt>
          <dd>{{ tagRefs.length }}</dd>
        </dl>
        <RouterLink
          :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
          >{{ t("commitHistory") }}</RouterLink
        >
      </aside>
      <section v-if="readmeEntry && !filePath && !loading" class="readme-panel box">
        <div class="box-header"><AppIcon name="markdown" />{{ t("readme") }}</div>
        <MarkdownContent
          :source="file?.content ?? ''"
          :base-url="`/${repository.owner}/${repository.name}/blob/README.md?ref=${encodeURIComponent(refName)}`"
        />
      </section>
    </template>
    <template v-else-if="section === 'commits'">
      <section class="box box-form graph-panel">
        <div class="panel-heading">
          <div>
            <p class="eyebrow">{{ t("commitGraph") }}</p>
            <strong>{{ refName }}</strong>
          </div>
          <span v-if="graph?.truncated" class="muted">{{
            t("graphTruncated", { count: graph.commits.length })
          }}</span>
        </div>
        <p v-if="!graph?.commits.length && !loading" class="state">{{ t("noCommits") }}</p>
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
                :stroke="
                  edge.fromLane === edge.toLane
                    ? 'var(--colorCompoundBrandStroke)'
                    : 'var(--colorNeutralForeground3)'
                "
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
                  (sessionMarkers.get(point.commit.oid)?.length ?? 0) > 0
                    ? 'var(--colorPaletteMarigoldForeground2)'
                    : 'var(--colorCompoundBrandForeground1)'
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
              <StatusBadge v-for="name in commitRefs.get(point.commit.oid)" :key="name">{{
                name
              }}</StatusBadge
              ><StatusBadge
                v-for="marker in sessionMarkers.get(point.commit.oid)"
                :key="`${marker.session.id}-${marker.kind}-${marker.branchName}`"
                tone="brand"
                >{{ sessionMarkerLabel(marker) }} ·
                {{ sessionPermission(marker.session) }}</StatusBadge
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
            <AppLink
              v-if="session.baseOid"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: refName, oid: session.baseOid },
              }"
              >{{ session.agentName }} / {{ session.workspaceName }} ·
              {{ t("sessionBase") }}</AppLink
            >
            <span v-else>{{ session.agentName }} / {{ session.workspaceName }}</span>
            <small
              >{{ sessionPermission(session) }} · {{ sessionStatus(session) }} ·
              {{ new Date(session.expiresAt).toLocaleString() }}</small
            >
            <AppLink
              v-for="forkRef in sessionForkRefs(session.id)"
              :key="forkRef.name"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: refName, oid: forkRef.oid },
              }"
              >{{ forkRef.name.slice(`session/${session.id}/`.length) }} ·
              {{ forkRef.oid.slice(0, 8) }}</AppLink
            >
          </div>
        </div>
        <fluent-button v-if="hasMoreCommits" type="button" @click="loadMore">
          {{ t("loadMore") }}
        </fluent-button>
      </section>
      <section v-if="route.query.oid" class="box box-form commit-detail">
        <p class="eyebrow">{{ t("commitDetails") }}</p>
        <code>{{ route.query.oid }}</code>
        <p v-if="selectedCommit">{{ selectedCommit.message }}</p>
        <p v-else class="muted">{{ t("commitNotInGraph") }}</p>
        <strong>{{ t("parents") }}</strong>
        <div v-for="parent in selectedCommit?.parents" :key="parent">
          <AppLink
            :to="{
              path: `/${repository.owner}/${repository.name}/commits`,
              query: { ref: refName, oid: parent },
            }"
            >{{ parent }}</AppLink
          >
        </div>
      </section>
    </template>
    <section v-else class="box box-form compare-panel">
      <p class="eyebrow">{{ t("compare") }}</p>
      <div class="compare-form">
        <SelectField v-model="compareBase" :label="t('baseBranch')">
          <fluent-option
            v-for="item in shortRefs(branchRefs)"
            :key="item.name"
            :value="item.shortName"
          >
            {{ item.shortName }}
          </fluent-option>
        </SelectField>
        <SelectField v-model="compareHead" :label="t('headBranch')">
          <fluent-option
            v-for="item in shortRefs(branchRefs)"
            :key="item.name"
            :value="item.shortName"
          >
            {{ item.shortName }}
          </fluent-option>
        </SelectField>
        <fluent-button type="button" appearance="primary" @click="load">{{
          t("compare")
        }}</fluent-button>
      </div>
      <p v-if="comparison" class="muted">
        {{ comparison.commits.length }} {{ t("commits") }} · {{ comparison.files.length }}
        {{ t("changedFiles") }}
      </p>
      <div v-for="change in comparison?.files" :key="change.path" class="item-row">
        <strong>{{ change.path }}</strong
        ><StatusBadge>{{ change.type }}</StatusBadge>
        <pre v-if="change.patch" class="diff-preview">{{ change.patch }}</pre>
      </div>
    </section>
  </section>
</template>

<style src="../styles/code.css"></style>
<style scoped>
.code-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--spacingVerticalM);
}
.toolbar-row {
  display: flex;
  align-items: flex-end;
  gap: var(--spacingHorizontalM);
  flex-wrap: wrap;
}
.toolbar-row > fluent-field,
.toolbar-row > fluent-text-input {
  width: auto;
  min-width: 0;
  flex: 1 1 200px;
  max-width: 320px;
}
.clone-control {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalS);
  flex: 1 1 320px;
  min-width: 0;
  color: var(--colorNeutralForeground2);
  font-size: var(--fontSizeBase200);
}
.clone-control code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: var(--spacingVerticalXS) var(--spacingHorizontalS);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground3);
  color: var(--colorBrandForegroundLink);
}
.browser-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
  gap: var(--spacingHorizontalL);
  align-items: start;
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacingHorizontalM);
}
.file-entry {
  display: flex;
  width: 100%;
  justify-content: flex-start;
  border-radius: 0;
  border-bottom: 1px solid var(--colorNeutralStroke2);
}
.file-entry::part(content) {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalM);
  width: 100%;
}
.file-entry small {
  margin-left: auto;
  color: var(--colorNeutralForeground3);
  font-family: var(--fontFamilyMonospace);
}
.file-type {
  color: var(--colorCompoundBrandForeground1);
}
.text-preview,
.diff-preview {
  overflow: auto;
  max-height: 70vh;
  margin: 0;
  padding: var(--spacingVerticalM) var(--spacingHorizontalL);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--fontSizeBase200) / 1.65 var(--fontFamilyMonospace);
}
.readme-title {
  margin: 0;
  padding: var(--spacingVerticalM) var(--spacingHorizontalL) 0;
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
  padding-block: var(--spacingVerticalS);
  border-bottom: 1px solid var(--colorNeutralStroke2);
  color: var(--colorNeutralForeground3);
  font-size: var(--fontSizeBase200);
}
.commit-title {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalM);
  height: 24px;
  min-width: 0;
}
.commit-title small {
  white-space: nowrap;
}
.commit-labels {
  display: flex;
  gap: var(--spacingHorizontalS);
  overflow-x: auto;
  min-width: 0;
}
.commit-labels > * {
  flex-shrink: 0;
}
.commit-subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--colorNeutralForeground1);
}
.commit-row code,
.commit-detail code {
  color: var(--colorBrandForegroundLink);
  font: var(--fontSizeBase200) var(--fontFamilyMonospace);
}
.session-overlay-row {
  display: grid;
  gap: var(--spacingVerticalXXS);
  border-top: 1px solid var(--colorNeutralStroke2);
  padding: var(--spacingVerticalS) 0;
}
.graph-scroll svg circle {
  pointer-events: all;
  cursor: pointer;
}
.session-overlay-row small {
  color: var(--colorNeutralForeground3);
}
.session-overlay {
  display: grid;
  gap: var(--spacingVerticalXS);
  padding-top: var(--spacingVerticalM);
  color: var(--colorNeutralForeground2);
  font-size: var(--fontSizeBase200);
}
.token-once {
  display: grid;
  gap: var(--spacingVerticalM);
  overflow-wrap: anywhere;
}
.token-once p {
  margin: var(--spacingVerticalXS) 0 0;
  color: var(--colorNeutralForeground2);
}
.token-once code {
  padding: var(--spacingVerticalS) var(--spacingHorizontalM);
  border-radius: var(--borderRadiusMedium);
  background: var(--colorNeutralBackground3);
  color: var(--colorBrandForegroundLink);
}
.compare-form {
  display: flex;
  align-items: flex-end;
  gap: var(--spacingHorizontalM);
  flex-wrap: wrap;
}
.diff-preview {
  flex-basis: 100%;
  width: 100%;
  max-height: 320px;
  padding: 0;
}
.item-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalS);
  padding: var(--spacingVerticalM) 0;
  border-bottom: 1px solid var(--colorNeutralStroke2);
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
