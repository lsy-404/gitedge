<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
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
  RepositoryBranch,
} from "../lib/api";
import { api, errorMessage } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import SelectField from "./SelectField.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import { oneOf } from "../ui/formEvents";
import { clearOneTimeToken, isCredentialExpired } from "../lib/credentialSecurity";
import { cloneCommand as gitCloneCommand, gatewayCloneUrl } from "../lib/gitClone";
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
import DiffViewer from "./DiffViewer.vue";
import CommitSignatureStatus from "./CommitSignatureStatus.vue";
import { preferencesState } from "../lib/preferences";
import RepositoryBranches from "./RepositoryBranches.vue";
import RepositoryFileEditor from "./RepositoryFileEditor.vue";
import RepositoryCommunity from "./RepositoryCommunity.vue";

const props = withDefaults(
  defineProps<{ repository: Repository; section: string; graphEnabled?: boolean }>(),
  { graphEnabled: true }
);
const emit = defineEmits<{ changed: [] }>();
const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const refs = ref<GitRef[]>([]);
const tree = ref<GitTree | null>(null);
const file = ref<GitFile | null>(null);
const fileHeadOid = ref<string | null>(null);
const managedBranches = ref<RepositoryBranch[]>([]);
const branchRefreshKey = ref(0);
const showFileEditor = ref(false);
const editorCreatesNew = ref(false);
const initialEditorPath = ref("");
const savedFile = ref<{ oid: string; branch: string; path: string; deleted?: boolean } | null>(
  null
);
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
const emptyRepository = ref(false);
const graphPageSize = 100;
const graphStep = 50;
const graphMaxLimit = 250;
const graphLimit = ref(graphPageSize);
const loadingMore = ref(false);
const moreError = ref("");
const token = ref<{ id: string; token: string; expiresAt: number } | null>(null);
const tokenName = ref("");
const cloneUrl = computed(() =>
  gatewayCloneUrl(window.location.origin, props.repository.owner, props.repository.name)
);
const cloneCommand = computed(() =>
  gitCloneCommand(cloneUrl.value, props.repository.defaultBranch, token.value?.token)
);
const canCreateCloneToken = computed(
  () => sessionState.user !== null && props.repository.viewerRole !== null
);
const tokenScopes = ["read", "write"] as const;
const tokenScope = ref<(typeof tokenScopes)[number]>("read");
const tokenBusy = ref(false);
const tokenExpired = ref(false);
let tokenExpiryTimer: number | undefined;
let tokenRequestVersion = 0;
let clockTimer: number | undefined;
const refName = computed(() => String(route.query.ref || props.repository.defaultBranch));
const filePath = computed(() => {
  const value = route.params.path;
  return Array.isArray(value) ? value.join("/") : String(value || "");
});
const isBlob = computed(
  () => String(route.params.view || "") === "blob" || route.path.includes("/blob/")
);
const branchRefs = computed(() => refs.value.filter((item) => item.name.startsWith("refs/heads/")));
const canManageCode = computed(
  () =>
    props.section === "code" &&
    props.repository.onlineEditingEnabled &&
    props.repository.canWrite &&
    !props.repository.archived
);
const selectedBranchHeadOid = computed(
  () => branchRefs.value.find((item) => item.name === "refs/heads/" + refName.value)?.oid ?? null
);
const selectedBranchInfo = computed(
  () => managedBranches.value.find((branch) => branch.name === refName.value) ?? null
);
const selectedFileEntry = computed(
  () => tree.value?.entries.find((entry) => entry.path === filePath.value) ?? null
);
const selectedFileCanEdit = computed(
  () =>
    Boolean(file.value) &&
    !file.value?.binary &&
    file.value?.content !== null &&
    (selectedFileEntry.value?.mode === "100644" || selectedFileEntry.value?.mode === "100755") &&
    (file.value?.size ?? Infinity) <= 1_000_000
);
const canEditCurrentRef = computed(
  () => Boolean(selectedBranchHeadOid.value) || emptyRepository.value
);
const tagRefs = computed(() => refs.value.filter((item) => item.name.startsWith("refs/tags/")));
const shortRefs = (items: GitRef[]) =>
  items.map((item) => ({ ...item, shortName: item.name.replace(/^refs\/(heads|tags)\//, "") }));
const graphLayout = computed(() => layoutGitGraph(graph.value?.commits ?? []));
const commitRefs = computed(() => graphView.value?.refsByOid ?? new Map<string, string[]>());
const sessionMarkers = computed(
  () => graphView.value?.sessionsByOid ?? new Map<string, GraphSessionMarker[]>()
);
const title = computed(() => filePath.value.split("/").at(-1) || props.repository.name);
const fileMode = ref<"preview" | "code">("preview");
const markdownFile = computed(() => /\.(md|markdown)$/i.test(filePath.value));
const markdownBase = computed(
  () =>
    `/${props.repository.owner}/${props.repository.name}/blob/${filePath.value.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(refName.value)}`
);
const queryText = ref("");
const showFileSearch = ref(false);
const showCloneMenu = ref(false);
const cloneToggle = ref<HTMLElement | null>(null);
const codeRoot = ref<HTMLElement | null>(null);
const fileSearchInput = ref<HTMLInputElement | null>(null);
const copied = ref(false);
let copiedTimer: number | undefined;
const hasMoreGraph = computed(
  () => Boolean(graph.value?.truncated) && graphLimit.value < graphMaxLimit
);
const filteredEntries = computed(() =>
  (tree.value?.entries ?? []).filter((entry) =>
    entry.name.toLocaleLowerCase().includes(queryText.value.trim().toLocaleLowerCase())
  )
);
const latestCommit = computed(() => graph.value?.commits[0] ?? commits.value[0] ?? null);
const breadcrumbs = computed(() => filePath.value.split("/").filter(Boolean));
const highlightedContent = computed(() =>
  highlightedCode(file.value?.content ?? "", file.value?.path)
);
const fileLineNumbers = computed(() =>
  Array.from(
    { length: (file.value?.content?.match(/\n/g)?.length ?? 0) + 1 },
    (_, index) => index + 1
  )
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
let refsRefreshVersion = 0;

function showError(cause: unknown) {
  error.value = errorMessage(cause, t);
}
async function load() {
  const version = ++requestVersion;
  loading.value = true;
  error.value = "";
  emptyReason.value = "";
  emptyRepository.value = false;
  tree.value = null;
  file.value = null;
  fileHeadOid.value = null;
  graph.value = null;
  comparison.value = null;
  try {
    const refData = await api.refs(props.repository.id);
    if (version !== requestVersion) return;
    refs.value = refData;
    const branchHead =
      refData.find((item) => item.name === "refs/heads/" + refName.value)?.oid ?? null;
    fileHeadOid.value = branchHead;
    const pinnedRef = branchHead ?? refName.value;
    if (refData.length === 0 && (props.section === "code" || props.section === "commits")) {
      emptyRepository.value = true;
      return;
    }
    if (props.section === "commits") {
      const [latest, graphData] = await Promise.all([
        api.commits(props.repository.id, refName.value, 0, 1),
        props.graphEnabled ? api.graph(props.repository.id, refName.value, graphLimit.value) : null,
      ]);
      if (version !== requestVersion) return;
      commits.value = latest;
      graph.value = graphData;
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
      const parent = filePath.value.split("/").slice(0, -1).join("/");
      const [fileData, directory] = await Promise.all([
        api.file(props.repository.id, pinnedRef, filePath.value),
        api.tree(props.repository.id, pinnedRef, parent),
      ]);
      if (version !== requestVersion) return;
      file.value = fileData;
      tree.value = directory;
      return;
    }
    const treeData = await api.tree(props.repository.id, pinnedRef, filePath.value);
    if (version !== requestVersion) return;
    tree.value = treeData;
    emptyReason.value = tree.value.entries.length === 0 ? "tree" : "";
  } catch (cause) {
    if (version !== requestVersion) return;
    showError(cause);
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
async function refreshRefs() {
  const version = ++refsRefreshVersion;
  try {
    const updatedRefs = await api.refs(props.repository.id);
    if (version !== refsRefreshVersion) return;
    refs.value = updatedRefs;
    fileHeadOid.value =
      updatedRefs.find((item) => item.name === "refs/heads/" + refName.value)?.oid ?? null;
  } catch {
    // A refresh failure should not discard the editor's successful result.
  }
}
async function loadMore() {
  if (loadingMore.value || !hasMoreGraph.value) return;
  const version = requestVersion;
  const nextLimit = Math.min(graphLimit.value + graphStep, graphMaxLimit);
  loadingMore.value = true;
  moreError.value = "";
  try {
    const next = await api.graph(props.repository.id, refName.value, nextLimit);
    if (version !== requestVersion) return;
    graphLimit.value = nextLimit;
    graph.value = next;
  } catch (cause) {
    if (version === requestVersion) moreError.value = errorMessage(cause, t);
  } finally {
    if (version === requestVersion) loadingMore.value = false;
  }
}
function openNewFile() {
  editorCreatesNew.value = true;
  const directory = isBlob.value
    ? filePath.value.split("/").slice(0, -1).join("/")
    : filePath.value;
  initialEditorPath.value = directory ? directory + "/" : "";
  savedFile.value = null;
  showFileEditor.value = true;
}
function openExistingFileEditor() {
  editorCreatesNew.value = false;
  initialEditorPath.value = "";
  savedFile.value = null;
  showFileEditor.value = true;
}
function onFileSaved(result: { oid: string; branch: string; path: string; deleted?: boolean }) {
  savedFile.value = result;
  branchRefreshKey.value += 1;
  const current = managedBranches.value.find((branch) => branch.name === result.branch);
  if (current) {
    managedBranches.value = managedBranches.value.map((branch) =>
      branch.name === result.branch ? { ...branch, oid: result.oid } : branch
    );
  } else {
    managedBranches.value = [
      ...managedBranches.value,
      { name: result.branch, oid: result.oid, protected: false, rules: [], isDefault: false },
    ];
  }
  void refreshRefs();
}
async function closeFileEditor() {
  showFileEditor.value = false;
  const changed = savedFile.value;
  savedFile.value = null;
  if (!changed) return;
  if (changed.deleted) {
    const directory = changed.path.split("/").slice(0, -1).join("/");
    await router.push(
      repositoryCodeLocation(
        props.repository.owner,
        props.repository.name,
        "tree",
        directory,
        changed.branch
      )
    );
    return;
  }
  if (changed.branch !== refName.value) {
    await router.push({
      path: "/" + props.repository.owner + "/" + props.repository.name,
      query: { ...route.query, ref: changed.branch },
    });
    return;
  }
  await load();
}
async function changeRef(value: string) {
  graphLimit.value = graphPageSize;
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
async function copyText(text: string) {
  clearTimeout(copiedTimer);
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    copiedTimer = window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
    error.value = t("apiError");
  }
}
function copyCloneUrl() {
  return copyText(cloneUrl.value);
}
function copyCloneCommand() {
  return copyText(cloneCommand.value);
}
function openFileSearch() {
  showFileSearch.value = true;
  void nextTick(() => fileSearchInput.value?.focus());
}
function closeFileSearch() {
  showFileSearch.value = false;
  void nextTick(() => codeRoot.value?.querySelector<HTMLElement>(".search-trigger")?.focus());
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
      tokenExpiryTimer = window.setTimeout(
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
  if (!file.value || file.value.content === null) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([file.value.content], { type: "text/plain;charset=utf-8" })
  );
  link.download = title.value;
  link.click();
  URL.revokeObjectURL(link.href);
}
function rawFile() {
  if (!file.value || file.value.content === null) return;
  const url = URL.createObjectURL(new Blob([file.value.content], { type: "text/plain" }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function dismissCodeMenu(event: Event) {
  if (event instanceof KeyboardEvent && event.key === "Escape" && showCloneMenu.value) {
    showCloneMenu.value = false;
    cloneToggle.value?.focus();
  }
  if (
    event instanceof PointerEvent &&
    event.target instanceof Element &&
    !event.target.closest(".clone-menu-wrap")
  )
    showCloneMenu.value = false;
}
watch(
  () => route.fullPath,
  () => {
    showCloneMenu.value = false;
    showFileSearch.value = false;
    queryText.value = "";
    fileMode.value = "preview";
    showFileEditor.value = false;
    savedFile.value = null;
  }
);
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
      graphLimit.value = graphPageSize;
      moreError.value = "";
      commits.value = [];
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
  document.addEventListener("keydown", dismissCodeMenu);
  document.addEventListener("pointerdown", dismissCodeMenu);
  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onUnmounted(() => {
  document.removeEventListener("keydown", dismissCodeMenu);
  document.removeEventListener("pointerdown", dismissCodeMenu);
  clearInterval(clockTimer);
  clearTimeout(tokenExpiryTimer);
  clearTimeout(copiedTimer);
  tokenRequestVersion += 1;
});
</script>

<template>
  <section ref="codeRoot" class="code-section">
    <div v-if="section === 'code'" class="code-toolbar">
      <div class="toolbar-row code-controls">
        <SelectField
          class="ref-picker"
          :model-value="refName"
          :label="t('branchOrTag')"
          :disabled="!refs.length"
          @update:model-value="changeRef"
        >
          <option
            v-if="!refs.some((item) => item.name.replace(/^refs\/(heads|tags)\//, '') === refName)"
            :value="refName"
          >
            {{ refName.slice(0, 12) }}
          </option>
          <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
            {{ item.shortName }}
          </option>
          <option v-for="item in shortRefs(tagRefs)" :key="item.name" :value="item.shortName">
            {{ item.shortName }} · {{ t("tags") }}
          </option>
        </SelectField>
        <RepositoryBranches
          v-if="canManageCode && branchRefs.length"
          :repository="repository"
          :selected-branch="refName"
          :default-branch="repository.defaultBranch"
          :refresh-key="branchRefreshKey"
          @select="changeRef"
          @branches-loaded="managedBranches = $event"
          @changed="refreshRefs"
        />
        <span class="repo-count"
          >{{ branchRefs.length }} {{ t("branches") }} · {{ tagRefs.length }} {{ t("tags") }}</span
        >
        <label v-if="showFileSearch" class="file-search">
          <AppIcon name="search" />
          <input
            ref="fileSearchInput"
            v-model="queryText"
            :aria-label="t('goToFile')"
            :placeholder="t('codeSearchPlaceholder')"
            @keydown.esc.stop="closeFileSearch"
          />
        </label>
        <FluentButton v-else class="search-trigger" tone="secondary" @click="openFileSearch"
          ><AppIcon name="search" />{{ t("goToFile") }}</FluentButton
        >
        <FluentButton
          v-if="canManageCode && canEditCurrentRef"
          type="button"
          tone="secondary"
          @click="openNewFile"
          ><AppIcon name="plus" />{{ t("codeNewFile") }}</FluentButton
        >

        <div class="clone-menu-wrap">
          <button
            ref="cloneToggle"
            type="button"
            class="btn btn-primary"
            aria-controls="clone-menu"
            :aria-expanded="showCloneMenu"
            @click="showCloneMenu = !showCloneMenu"
          >
            <AppIcon name="code" />{{ t("codeMenu") }}
            <AppIcon slot="end" name="chevron" />
          </button>
          <div v-if="showCloneMenu" id="clone-menu" class="clone-menu box">
            <strong>{{ t("cloneWithHttps") }}</strong>
            <div class="clone-url">
              <code>{{ cloneUrl }}</code
              ><FluentButton
                tone="subtle"
                icon-only
                :aria-label="copied ? t('copied') : t('copy')"
                @click="copyCloneUrl"
                ><AppIcon :name="copied ? 'check' : 'copy'"
              /></FluentButton>
            </div>
            <code>{{ gitCloneCommand(cloneUrl, repository.defaultBranch) }}</code>
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
                <option value="read">{{ t("readToken") }}</option>
                <option value="write" :disabled="!repository.canWrite || repository.archived">
                  {{ t("writeToken") }}
                </option>
              </SelectField>
              <FluentButton
                type="button"
                :disabled="tokenBusy || !tokenName.trim()"
                @click="issueToken"
                >{{ t("createCloneToken") }}</FluentButton
              >
            </template>
          </div>
        </div>
      </div>
    </div>
    <span class="visually-hidden" role="status" aria-live="polite">{{
      copied ? t("copied") : ""
    }}</span>
    <div v-if="token" class="token-once box box-form">
      <div>
        <strong>{{ t(tokenExpired ? "tokenExpired" : "tokenShownOnce") }}</strong>
        <p>{{ t("tokenExpiry", { date: d(token.expiresAt, "long") }) }}</p>
      </div>
      <code v-if="!tokenExpired">{{ token.token }}</code>
      <code>{{ cloneUrl }}</code>
      <code v-if="!tokenExpired">{{ cloneCommand }}</code>
      <div class="form-actions">
        <FluentButton v-if="!tokenExpired" type="button" @click="copyCloneCommand">
          {{ t("copyCloneCommand") }}
        </FluentButton>
        <FluentButton type="button" @click="clearToken">{{ t("close") }}</FluentButton>
      </div>
    </div>
    <div v-if="loading || error" class="box">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <div v-else-if="emptyRepository" class="empty-repository box">
      <h2>{{ t("emptyRepositoryTitle") }}</h2>
      <p>{{ t("emptyRepositoryText") }}</p>
      <code>mkdir {{ repository.name }} &amp;&amp; cd {{ repository.name }}</code>
      <code>git init</code>
      <code>echo "# {{ repository.name }}" &gt; README.md</code
      ><code>git add README.md &amp;&amp; git commit -m "first commit"</code
      ><code>git branch -M {{ repository.defaultBranch }}</code
      ><code>git remote add origin {{ cloneUrl }}</code
      ><code>git push -u origin {{ repository.defaultBranch }}</code>
      <h3>{{ t("pushExistingRepository") }}</h3>
      <code>git remote add gitedge {{ cloneUrl }}</code>
      <code>git push gitedge --all</code>
      <code>git push gitedge --tags</code>
      <FluentButton v-if="canManageCode" type="button" tone="primary" @click="openNewFile"
        ><AppIcon name="plus" />{{ t("codeNewFile") }}</FluentButton
      >
      <RepositoryFileEditor
        v-if="showFileEditor && canManageCode"
        :repository="repository"
        :branch="repository.defaultBranch"
        :expected-oid="null"
        :branch-info="null"
        :branches="managedBranches"
        :file="null"
        :entry="null"
        :initial-path="initialEditorPath"
        @close="closeFileEditor"
        @saved="onFileSaved"
        @changed="emit('changed')"
      />
    </div>
    <template v-else-if="section === 'code'">
      <div v-if="latestCommit && !isBlob" class="latest-commit box">
        <AppIcon name="commit" />
        <RouterLink
          v-if="graphEnabled"
          :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
          ><strong>{{ latestCommit.author.name }}</strong></RouterLink
        >
        <strong v-else>{{ latestCommit.author.name }}</strong>
        <span class="commit-message">{{ latestCommit.message.split("\n")[0] }}</span
        ><code>{{ latestCommit.oid.slice(0, 7) }}</code
        ><time :datetime="new Date(latestCommit.author.timestamp * 1000).toISOString()">{{
          d(latestCommit.author.timestamp * 1000, "short")
        }}</time>
      </div>
      <div v-if="!isBlob" class="box file-panel">
        <FluentButton
          v-if="filePath"
          type="button"
          tone="subtle"
          class="file-entry"
          @click="
            router.push(
              `/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`
            )
          "
        >
          ↑ {{ t("repositoryRoot") }}
        </FluentButton>
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
          <AppIcon
            :name="entry.type === 'tree' ? 'folder' : 'file'"
            :class="{ 'folder-icon': entry.type === 'tree' }"
          /><span>{{ entry.name }}</span
          ><small v-if="entry.type === 'tree'">{{ t("directory") }}</small>
        </RouterLink>
        <div v-if="emptyReason === 'tree'" class="state">{{ t("emptyTree") }}</div>
      </div>
      <aside v-if="isBlob && file" class="file-tree-panel">
        <div class="file-tree-heading">
          <AppIcon name="folder" /><strong>{{ t("files") }}</strong>
        </div>
        <RouterLink
          class="file-tree-root"
          :to="`/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`"
          ><AppIcon name="repo" />{{ repository.name }}</RouterLink
        >
        <div class="file-tree-directory muted">
          {{ filePath.split("/").slice(0, -1).join("/") || "/" }}
        </div>
        <RouterLink
          v-for="entry in filteredEntries"
          :key="entry.path"
          class="file-tree-item"
          :class="{ selected: entry.path === filePath }"
          :to="fileHref(entry.path, entry.type === 'tree' ? 'tree' : 'blob')"
          ><AppIcon :name="entry.type === 'tree' ? 'folder' : 'file'" /><span>{{
            entry.name
          }}</span></RouterLink
        >
      </aside>
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
          <span v-if="markdownFile" class="file-mode-tabs"
            ><button
              class="btn btn-sm"
              :aria-pressed="fileMode === 'preview'"
              @click="fileMode = 'preview'"
            >
              {{ t("preview") }}</button
            ><button
              class="btn btn-sm"
              :aria-pressed="fileMode === 'code'"
              @click="fileMode = 'code'"
            >
              {{ t("code") }}
            </button></span
          ><span>{{ file.size }} {{ t("bytes") }} · {{ file.oid.slice(0, 7) }}</span>
          <div>
            <FluentButton
              v-if="canManageCode && selectedBranchHeadOid"
              type="button"
              tone="secondary"
              :disabled="!selectedFileCanEdit"
              :title="selectedFileCanEdit ? undefined : t('codeNotEditable')"
              @click="openExistingFileEditor"
              >{{ t("edit") }}</FluentButton
            >
            <FluentButton
              tone="secondary"
              :disabled="file.binary || file.content === null"
              @click="rawFile"
              >{{ t("raw") }}</FluentButton
            ><FluentButton
              tone="secondary"
              :disabled="file.binary || file.content === null"
              @click="downloadText"
              ><AppIcon name="download" />{{ t("download") }}</FluentButton
            >
          </div>
        </div>
        <p v-if="file.binary || file.content === null" class="muted box-form">
          {{ t("binaryPreviewUnavailable") }}
        </p>
        <MarkdownContent
          allow-images
          v-else-if="markdownFile && fileMode === 'preview'"
          class="file-markdown"
          :source="file.content"
          :base-url="markdownBase"
        />
        <pre
          v-else
          class="code-source"
          :class="{ 'code-wrapped': preferencesState.lineWrap }"
          :style="{ tabSize: preferencesState.tabSize }"
        ><code class="line-gutter" aria-hidden="true">{{
          fileLineNumbers.join("\n")
        }}</code><code class="highlighted-file" v-html="highlightedContent"></code></pre>
      </div>
      <RepositoryFileEditor
        v-if="showFileEditor && canManageCode && canEditCurrentRef && !emptyRepository"
        :repository="repository"
        :branch="selectedBranchHeadOid ? refName : repository.defaultBranch"
        :expected-oid="fileHeadOid"
        :branch-info="selectedBranchInfo"
        :branches="managedBranches"
        :file="!editorCreatesNew && !emptyRepository ? file : null"
        :entry="!editorCreatesNew ? selectedFileEntry : null"
        :initial-path="initialEditorPath"
        @close="closeFileEditor"
        @saved="onFileSaved"
        @changed="emit('changed')"
      />
      <aside v-if="!isBlob" class="about-panel box">
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
          v-if="graphEnabled"
          :to="`/${repository.owner}/${repository.name}/commits?ref=${encodeURIComponent(refName)}`"
          >{{ t("commitHistory") }}</RouterLink
        >
      </aside>
      <RepositoryCommunity
        v-if="!filePath && !loading"
        :repository-id="repository.id"
        :ref-name="refName"
        show-readme
      />
    </template>
    <template v-else-if="section === 'commits'">
      <section v-if="!emptyRepository" class="box box-form graph-panel">
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
                {{ d(point.commit.author.timestamp * 1000, "long") }}</small
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
              {{ d(session.expiresAt, "long") }}</small
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
        <p v-if="moreError" class="state" role="alert">{{ moreError }}</p>
        <FluentButton v-if="hasMoreGraph" type="button" :disabled="loadingMore" @click="loadMore">
          {{ moreError ? t("retry") : t("loadMore") }}
        </FluentButton>
      </section>
      <section v-if="route.query.oid && !emptyRepository" class="box box-form commit-detail">
        <p class="eyebrow">{{ t("commitDetails") }}</p>
        <code>{{ route.query.oid }}</code>
        <CommitSignatureStatus
          v-if="selectedCommit"
          :repository-id="repository.id"
          :ref-name="refName"
          :oid="selectedCommit.oid"
        />
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
          <option
            v-if="!refs.some((item) => item.name.replace(/^refs\/(heads|tags)\//, '') === refName)"
            :value="refName"
          >
            {{ refName.slice(0, 12) }}
          </option>
          <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
            {{ item.shortName }}
          </option>
        </SelectField>
        <SelectField v-model="compareHead" :label="t('headBranch')">
          <option
            v-if="!refs.some((item) => item.name.replace(/^refs\/(heads|tags)\//, '') === refName)"
            :value="refName"
          >
            {{ refName.slice(0, 12) }}
          </option>
          <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
            {{ item.shortName }}
          </option>
        </SelectField>
        <FluentButton type="button" tone="primary" @click="load">{{ t("compare") }}</FluentButton>
      </div>
      <p v-if="comparison" class="muted">
        {{ comparison.commits.length }} {{ t("commits") }} · {{ comparison.files.length }}
        {{ t("changedFiles") }}
      </p>
      <NoticeBar v-if="comparison?.truncated" intent="warning">{{
        t("comparisonTruncated")
      }}</NoticeBar>
      <div v-for="change in comparison?.files" :key="change.path" class="item-row">
        <strong>{{ change.path }}</strong
        ><StatusBadge>{{ change.type }}</StatusBadge>
        <DiffViewer v-if="change.patch" :patch="change.patch" />
        <span v-else class="muted">{{
          change.binary ? t("binaryPreviewUnavailable") : t("diffTooLarge")
        }}</span>
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
.toolbar-row > .text-field {
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
