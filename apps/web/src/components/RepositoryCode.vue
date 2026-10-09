<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { NavigationFailureType, isNavigationFailure, useRoute, useRouter } from "vue-router";
import type {
  GitCommit,
  GitComparison,
  GitFile,
  GitGraph,
  GitRef,
  GitTree,
  Release,
  Repository,
  RepositoryBranch,
} from "../lib/api";
import { api, archiveUrl, errorMessage, rawFileUrl } from "../lib/api";
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import SelectField from "./SelectField.vue";
import NoticeBar from "./NoticeBar.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import {
  cloneCommand as gitCloneCommand,
  credentialHelperHints,
  existingRepositoryCommands,
  gatewayCloneUrl,
  newRepositoryCommands,
} from "../lib/gitClone";
import { sessionState } from "../lib/session";
import {
  agentSessionDisplayStatus,
  findGraphCommit,
  layoutGitGraph,
  projectGitGraph,
  repositoryCodeLocation,
  type GraphSessionMarker,
} from "../lib/gitGraphView";
import { highlightedCode } from "../lib/markdown";
import {
  permalinkLocation,
  resolveCommitOid,
  splitHighlightedLines,
  parseLineAnchor,
} from "../lib/codeAnchor";
import { useLineSelection } from "../lib/lineSelection";
import CodeLines from "./CodeLines.vue";
import FileFinderDialog from "./FileFinderDialog.vue";
import MarkdownContent from "./MarkdownContent.vue";
import DiffViewer from "./DiffViewer.vue";
import GitSignatureStatus from "./GitSignatureStatus.vue";
import { preferencesState } from "../lib/preferences";
import RepositoryBranches from "./RepositoryBranches.vue";
import RepositoryTags from "./RepositoryTags.vue";
import RepositoryFileEditor from "./RepositoryFileEditor.vue";
import RepositoryChangeForm, { type CommittedChanges } from "./RepositoryChangeForm.vue";
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
const changeMode = ref<"upload" | "move" | "delete" | null>(null);
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
const token = ref<{ token: string; expiresAt: number } | null>(null);
const cloneUrl = computed(() =>
  gatewayCloneUrl(window.location.origin, props.repository.owner, props.repository.name)
);
const cloneCommand = computed(() => gitCloneCommand(cloneUrl.value));
const newRepositoryScript = computed(() =>
  newRepositoryCommands(cloneUrl.value, props.repository.name, props.repository.defaultBranch)
);
const existingRepositoryScript = computed(() => existingRepositoryCommands(cloneUrl.value));
const canCreateCloneToken = computed(
  () => sessionState.user !== null && props.repository.viewerRole !== null
);
const tokenBusy = ref(false);
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
const currentDirectory = computed(() =>
  isBlob.value ? filePath.value.split("/").slice(0, -1).join("/") : filePath.value
);
const canEditCurrentRef = computed(
  () => Boolean(selectedBranchHeadOid.value) || emptyRepository.value
);
const tagRefs = computed(() => refs.value.filter((item) => item.name.startsWith("refs/tags/")));
const canManageTags = computed(
  () => props.section === "code" && props.repository.canWrite && !props.repository.archived
);
const latestRelease = ref<Release | null>(null);
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const rawUrl = computed(() =>
  rawFileUrl(props.repository.owner, props.repository.name, refName.value, filePath.value)
);
const downloadUrl = computed(() =>
  rawFileUrl(props.repository.owner, props.repository.name, refName.value, filePath.value, true)
);
const imageFile = computed(() => IMAGE_EXTENSIONS.test(filePath.value));
function sourceArchiveUrl(format: "zip" | "tar.gz"): string {
  return archiveUrl(props.repository.owner, props.repository.name, refName.value, format);
}
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
const showFinder = ref(false);
const showCloneMenu = ref(false);
const cloneToggle = ref<HTMLElement | null>(null);
const codeLines = ref<InstanceType<typeof CodeLines> | null>(null);
const { selection: lineSelection, select: selectLine } = useLineSelection(codeLines);
const copied = ref(false);
const copyFailed = ref(false);
let copiedTimer: number | undefined;
const hasMoreGraph = computed(
  () => Boolean(graph.value?.truncated) && graphLimit.value < graphMaxLimit
);
const treeEntries = computed(() => tree.value?.entries ?? []);
const commitOid = computed(() => resolveCommitOid(refs.value, refName.value));
const permalink = computed(() =>
  commitOid.value && isBlob.value
    ? permalinkLocation({
        owner: props.repository.owner,
        repository: props.repository.name,
        path: filePath.value,
        commitOid: commitOid.value,
        range: lineSelection.value,
      })
    : null
);
const latestCommit = computed(() => graph.value?.commits[0] ?? commits.value[0] ?? null);
const breadcrumbs = computed(() => filePath.value.split("/").filter(Boolean));
const highlightedLines = computed(() =>
  splitHighlightedLines(highlightedCode(file.value?.content ?? "", file.value?.path))
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
const compareRefsAreBranches = computed(() => {
  const names = new Set(shortRefs(branchRefs.value).map((item) => item.shortName));
  const headIsFreeText = Boolean(route.query.headSessionId);
  return names.has(compareBase.value) && (headIsFreeText || names.has(compareHead.value));
});
const canOpenPull = computed(
  () =>
    props.repository.pullsEnabled &&
    !props.repository.archived &&
    sessionState.user !== null &&
    (comparison.value?.commits.length ?? 0) > 0 &&
    compareBase.value !== compareHead.value &&
    compareRefsAreBranches.value
);
const openPullLocation = computed(() => {
  const headSessionId = route.query.headSessionId?.toString();
  return {
    path: `/${props.repository.owner}/${props.repository.name}/pulls`,
    query: {
      new: "1",
      base: compareBase.value,
      head: compareHead.value,
      ...(headSessionId ? { headSessionId } : {}),
    },
  };
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
      void loadLatestRelease(props.repository.id);
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
      if (markdownFile.value && parseLineAnchor(route.hash)) fileMode.value = "code";
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
async function loadLatestRelease(repositoryId: string) {
  try {
    const release = await api.latestRelease(repositoryId);
    if (repositoryId === props.repository.id) latestRelease.value = release;
  } catch {
    // The sidebar entry is optional, so a missing or unreadable release only hides it.
    if (repositoryId === props.repository.id) latestRelease.value = null;
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
    loadingMore.value = false;
  }
}
function openChangeForm(mode: "upload" | "move" | "delete") {
  showFileEditor.value = false;
  changeMode.value = mode;
}
function openNewFile() {
  changeMode.value = null;
  editorCreatesNew.value = true;
  const directory = isBlob.value
    ? filePath.value.split("/").slice(0, -1).join("/")
    : filePath.value;
  initialEditorPath.value = directory ? directory + "/" : "";
  savedFile.value = null;
  showFileEditor.value = true;
}
function openExistingFileEditor() {
  changeMode.value = null;
  editorCreatesNew.value = false;
  initialEditorPath.value = "";
  savedFile.value = null;
  showFileEditor.value = true;
}
function recordCommit(result: { oid: string; branch: string }) {
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
function onFileSaved(result: { oid: string; branch: string; path: string; deleted?: boolean }) {
  savedFile.value = result;
  recordCommit(result);
}
async function onChangesCommitted(result: CommittedChanges) {
  changeMode.value = null;
  recordCommit(result);
  emit("changed");
  const { owner, name } = props.repository;
  const failure = await router.push(
    result.pull
      ? {
          path: `/${owner}/${name}/pulls`,
          query: {
            new: "1",
            base: result.pull.base,
            head: result.pull.head,
            title: result.pull.title,
          },
        }
      : result.directory
        ? repositoryCodeLocation(owner, name, "tree", result.directory, result.branch)
        : { path: `/${owner}/${name}`, query: { ref: result.branch } }
  );
  if (isNavigationFailure(failure, NavigationFailureType.duplicated)) await load();
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
  copyFailed.value = false;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    copiedTimer = window.setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
    copyFailed.value = true;
  }
}
function copyCloneUrl() {
  return copyText(cloneUrl.value);
}
function copyToken() {
  return token.value ? copyText(token.value.token) : Promise.resolve();
}
function openFile(path: string) {
  void router.push(
    repositoryCodeLocation(
      props.repository.owner,
      props.repository.name,
      "blob",
      path,
      refName.value
    )
  );
}
function copyPermalink() {
  if (!permalink.value) return;
  const target = router.resolve(permalink.value);
  return copyText(window.location.origin + target.fullPath);
}
function typingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
function codeShortcuts(event: KeyboardEvent) {
  if (
    props.section !== "code" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.defaultPrevented ||
    typingTarget(event.target) ||
    document.querySelector("dialog[open]")
  )
    return;
  if (event.key === "t" && refs.value.length) {
    event.preventDefault();
    showFinder.value = true;
  } else if (event.key === "y" && permalink.value) {
    event.preventDefault();
    void router.replace(permalink.value);
  }
}
async function issueToken() {
  tokenBusy.value = true;
  error.value = "";
  const repositoryId = props.repository.id;
  const requestVersion = ++tokenRequestVersion;
  const writable = props.repository.canWrite && !props.repository.archived;
  try {
    const created = await api.createAccessToken({
      name: `${props.repository.owner}/${props.repository.name}`.slice(0, 80),
      scopes: [writable ? "repo:write" : "repo:read"],
      repositoryIds: [repositoryId],
      expiresInDays: 30,
    });
    if (requestVersion !== tokenRequestVersion || repositoryId !== props.repository.id) return;
    token.value = { token: created.token, expiresAt: created.expiresAt };
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
  () => route.fullPath.replace(/#.*$/, ""),
  () => {
    showCloneMenu.value = false;
    showFinder.value = false;
    fileMode.value = "preview";
    showFileEditor.value = false;
    changeMode.value = null;
    savedFile.value = null;
  }
);
function fileHref(path: string, view: "tree" | "blob" | "history" | "blame" = "blob") {
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
  [
    () => props.repository.id,
    () => props.section,
    refName,
    filePath,
    isBlob,
    () => route.query.base,
    () => route.query.head,
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
      if (previousRepositoryId !== props.repository.id) {
        clearToken();
        latestRelease.value = null;
      }
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
  document.addEventListener("keydown", codeShortcuts);
  document.addEventListener("pointerdown", dismissCodeMenu);
  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onUnmounted(() => {
  document.removeEventListener("keydown", dismissCodeMenu);
  document.removeEventListener("keydown", codeShortcuts);
  document.removeEventListener("pointerdown", dismissCodeMenu);
  clearInterval(clockTimer);
  clearTimeout(copiedTimer);
  tokenRequestVersion += 1;
});
</script>

<template>
  <section class="code-section">
    <div v-if="section === 'code'" class="code-toolbar">
      <div class="code-controls">
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
        <RepositoryTags
          v-if="canManageTags && branchRefs.length"
          :repository="repository"
          :branches="shortRefs(branchRefs).map((item) => item.shortName)"
          :selected-branch="
            branchRefs.some((item) => item.name === 'refs/heads/' + refName)
              ? refName
              : repository.defaultBranch
          "
          @select="changeRef"
          @changed="refreshRefs"
        />
        <span class="repo-count"
          >{{ branchRefs.length }} {{ t("branches") }} · {{ tagRefs.length }} {{ t("tags") }}</span
        >
        <FluentButton
          class="search-trigger"
          tone="secondary"
          :disabled="!refs.length"
          :title="t('goToFileShortcut')"
          @click="showFinder = true"
          ><AppIcon name="search" />{{ t("goToFile") }}</FluentButton
        >
        <FluentButton
          v-if="canManageCode && canEditCurrentRef"
          type="button"
          tone="secondary"
          @click="openNewFile"
          ><AppIcon name="plus" />{{ t("codeNewFile") }}</FluentButton
        >
        <FluentButton
          v-if="canManageCode && canEditCurrentRef"
          type="button"
          tone="secondary"
          @click="openChangeForm('upload')"
          ><AppIcon name="upload" />{{ t("codeUploadFiles") }}</FluentButton
        >
        <template v-if="canManageCode && canEditCurrentRef && !isBlob && filePath">
          <FluentButton type="button" tone="secondary" @click="openChangeForm('move')">{{
            t("codeMoveFolder")
          }}</FluentButton>
          <FluentButton type="button" tone="secondary" @click="openChangeForm('delete')">{{
            t("codeDeleteFolder")
          }}</FluentButton>
        </template>

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
            <code>{{ cloneCommand }}</code>
            <p class="muted">{{ t("cloneHelp") }}</p>
            <details class="credential-helpers">
              <summary>{{ t("patHelperTitle") }}</summary>
              <dl>
                <template v-for="hint in credentialHelperHints" :key="hint.id">
                  <dt>{{ t(`patOs_${hint.id}`) }}</dt>
                  <dd>
                    <code>{{ hint.command }}</code>
                    <span v-if="hint.plaintext" class="muted">{{
                      t("patHelperStoreWarning")
                    }}</span>
                  </dd>
                </template>
              </dl>
            </details>
            <div class="clone-downloads">
              <a class="btn btn-sm" :href="sourceArchiveUrl('zip')"
                ><AppIcon name="download" />{{ t("downloadSourceZip") }}</a
              >
              <a class="btn btn-sm" :href="sourceArchiveUrl('tar.gz')"
                ><AppIcon name="download" />{{ t("downloadSourceTar") }}</a
              >
            </div>
            <template v-if="canCreateCloneToken">
              <FluentButton type="button" :disabled="tokenBusy" @click="issueToken">{{
                t("patGenerate")
              }}</FluentButton>
              <RouterLink class="muted" to="/settings/account?section=tokens">{{
                t("patManage")
              }}</RouterLink>
            </template>
          </div>
        </div>
      </div>
    </div>
    <span class="visually-hidden" role="status" aria-live="polite">{{
      copied ? t("copied") : ""
    }}</span>
    <p v-if="copyFailed" class="muted" role="alert">{{ t("copyFailed") }}</p>
    <div v-if="token" class="token-once box box-form" role="status">
      <div>
        <strong>{{ t("tokenShownOnce") }}</strong>
        <p>{{ t("tokenExpiry", { date: d(token.expiresAt, "long") }) }}</p>
      </div>
      <code>{{ token.token }}</code>
      <p>{{ t("patPasteHint") }}</p>
      <div class="form-actions">
        <FluentButton type="button" @click="copyToken">
          {{ copied ? t("copied") : t("patCopyToken") }}
        </FluentButton>
        <FluentButton type="button" @click="clearToken">{{ t("close") }}</FluentButton>
      </div>
    </div>
    <div v-if="(loading || error) && section !== 'compare'" class="box">
      <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
    </div>
    <div v-else-if="emptyRepository" class="empty-repository box">
      <h2>{{ t("emptyRepositoryTitle") }}</h2>
      <p>{{ t("emptyRepositoryText") }}</p>
      <div class="quickstart-actions">
        <FluentButton
          v-if="canCreateCloneToken && repository.canWrite && !repository.archived"
          type="button"
          tone="primary"
          :disabled="tokenBusy"
          @click="issueToken"
          >{{ t("patGenerate") }}</FluentButton
        >
        <span class="muted">{{ t("patQuickstartHint") }}</span>
      </div>
      <pre class="command-block" tabindex="0"><code>{{ newRepositoryScript }}</code></pre>
      <FluentButton type="button" tone="subtle" @click="copyText(newRepositoryScript)"
        ><AppIcon name="copy" />{{ t("copy") }}</FluentButton
      >
      <h3>{{ t("pushExistingRepository") }}</h3>
      <pre class="command-block" tabindex="0"><code>{{ existingRepositoryScript }}</code></pre>
      <FluentButton type="button" tone="subtle" @click="copyText(existingRepositoryScript)"
        ><AppIcon name="copy" />{{ t("copy") }}</FluentButton
      >
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
      <RepositoryChangeForm
        v-if="changeMode && canManageCode"
        :repository="repository"
        :mode="changeMode"
        :branch="repository.defaultBranch"
        :expected-oid="null"
        :branch-info="null"
        :branches="managedBranches"
        :directory="currentDirectory"
        @close="changeMode = null"
        @committed="onChangesCommitted"
      />
    </div>
    <template v-else-if="section === 'code'">
      <div v-if="!isBlob" class="box file-panel">
        <div v-if="latestCommit" class="latest-commit">
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
        <div v-if="filePath" class="tree-toolbar">
          <RouterLink class="btn btn-sm" :to="fileHref(filePath, 'history')"
            ><AppIcon name="clock" />{{ t("fileHistory") }}</RouterLink
          >
        </div>
        <RouterLink
          v-if="filePath"
          class="file-entry file-entry-root"
          :to="`/${repository.owner}/${repository.name}?ref=${encodeURIComponent(refName)}`"
          >↑ {{ t("repositoryRoot") }}</RouterLink
        >
        <RouterLink
          v-for="entry in treeEntries"
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
          v-for="entry in treeEntries"
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
              type="button"
              class="btn btn-sm"
              :aria-pressed="fileMode === 'preview'"
              @click="fileMode = 'preview'"
            >
              {{ t("preview") }}</button
            ><button
              type="button"
              class="btn btn-sm"
              :aria-pressed="fileMode === 'code'"
              @click="fileMode = 'code'"
            >
              {{ t("code") }}
            </button></span
          ><span class="file-meta"
            >{{ file.size }} {{ t("bytes") }} · {{ file.oid.slice(0, 7) }}</span
          >
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
            <a class="btn" :href="rawUrl" target="_blank" rel="noopener">{{ t("raw") }}</a
            ><a class="btn" :href="downloadUrl" download
              ><AppIcon name="download" />{{ t("download") }}</a
            >
            <RouterLink class="btn" :to="fileHref(filePath, 'blame')">{{ t("blame") }}</RouterLink>
            <RouterLink class="btn" :to="fileHref(filePath, 'history')"
              ><AppIcon name="clock" />{{ t("fileHistory") }}</RouterLink
            >
            <FluentButton tone="secondary" :disabled="!permalink" @click="copyPermalink"
              ><AppIcon :name="copied ? 'check' : 'link'" />{{
                copied ? t("copied") : t("copyPermalink")
              }}</FluentButton
            >
          </div>
        </div>
        <div v-if="imageFile" class="file-image box-form">
          <img :src="rawUrl" :alt="t('rawImageAlt', { name: title })" />
        </div>
        <p v-else-if="file.binary || file.content === null" class="muted box-form">
          {{ t("binaryPreviewUnavailable") }} {{ t("binaryDownloadHint") }}
        </p>
        <MarkdownContent
          allow-images
          v-else-if="markdownFile && fileMode === 'preview'"
          class="file-markdown"
          :source="file.content"
          :base-url="markdownBase"
        />
        <CodeLines
          v-else
          ref="codeLines"
          :lines="highlightedLines"
          :label="title"
          :selection="lineSelection"
          :wrap="preferencesState.lineWrap"
          :tab-size="preferencesState.tabSize"
          @select="selectLine"
        />
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
      <RepositoryChangeForm
        v-if="changeMode && canManageCode && canEditCurrentRef && !emptyRepository"
        :repository="repository"
        :mode="changeMode"
        :branch="selectedBranchHeadOid ? refName : repository.defaultBranch"
        :expected-oid="fileHeadOid"
        :branch-info="selectedBranchInfo"
        :branches="managedBranches"
        :directory="currentDirectory"
        @close="changeMode = null"
        @committed="onChangesCommitted"
      />
      <aside v-if="!isBlob" class="about-panel" :aria-label="t('about')">
        <div class="about-heading">
          <h2>{{ t("about") }}</h2>
          <RouterLink
            v-if="repository.canWrite"
            class="btn btn-subtle btn-sm icon-button"
            :to="`/${repository.owner}/${repository.name}/settings`"
            :aria-label="t('editAbout')"
            ><AppIcon name="gear"
          /></RouterLink>
        </div>
        <p :class="{ muted: !repository.description }">
          {{ repository.description || t("noDescription") }}
        </p>
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
          ><AppIcon name="clock" />{{ t("commitHistory") }}</RouterLink
        >
        <div class="about-release">
          <h3>{{ t("releases") }}</h3>
          <RouterLink v-if="latestRelease" :to="`/${repository.owner}/${repository.name}/releases`"
            ><AppIcon name="tag" />{{ latestRelease.title }}</RouterLink
          >
          <p v-if="latestRelease" class="muted">
            {{ latestRelease.tagName }} · {{ t("latestRelease") }}
          </p>
          <p v-else class="muted">{{ t("noReleases") }}</p>
          <RouterLink :to="`/${repository.owner}/${repository.name}/releases`">{{
            t("viewReleases")
          }}</RouterLink>
        </div>
      </aside>
      <RepositoryCommunity
        v-if="!filePath && !loading"
        :repository-id="repository.id"
        :ref-name="refName"
        show-readme
      />
    </template>
    <template v-else-if="section === 'commits'">
      <section v-if="!emptyRepository" class="box graph-panel">
        <div class="box-header">
          <AppIcon name="commit" />
          <h2>{{ t("commitGraph") }}</h2>
          <StatusBadge class="graph-ref" :title="refName"
            ><AppIcon name="branch" :size="12" /><span class="graph-ref-name">{{
              refName
            }}</span></StatusBadge
          >
          <span v-if="graph?.truncated" class="graph-note muted">{{
            t("graphTruncated", { count: graph.commits.length })
          }}</span>
        </div>
        <p v-if="!graph?.commits.length && !loading" class="state">{{ t("noCommits") }}</p>
        <div v-else class="graph-history">
          <div class="graph-scroll">
            <svg
              :width="graphLayout.width"
              :height="graphLayout.height"
              role="group"
              :aria-label="t('commitGraph')"
            >
              <line
                v-for="(edge, i) in graphLayout.edges"
                :key="`edge-${i}`"
                :x1="12 + edge.fromLane * 22"
                :y1="20 + edge.fromRow * graphLayout.rowHeight"
                :x2="12 + edge.toLane * 22"
                :y2="20 + edge.toRow * graphLayout.rowHeight"
                :stroke="edge.fromLane === edge.toLane ? 'var(--accent-strong)' : 'var(--fg-muted)'"
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
                :aria-label="`${t('openCommit')} ${point.commit.message.split('\n')[0]} (${point.commit.oid.slice(0, 8)})`"
                :fill="
                  (sessionMarkers.get(point.commit.oid)?.length ?? 0) > 0
                    ? 'var(--warning-fg)'
                    : 'var(--accent-fg)'
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
              '--graph-width': `${graphLayout.width}px`,
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
        <div v-if="moreError || hasMoreGraph" class="graph-more">
          <p v-if="moreError" class="graph-error" role="alert">{{ moreError }}</p>
          <FluentButton v-if="hasMoreGraph" type="button" :disabled="loadingMore" @click="loadMore">
            {{ moreError ? t("retry") : t("loadMore") }}
          </FluentButton>
        </div>
      </section>
      <section v-if="route.query.oid && !emptyRepository" class="box commit-detail">
        <div class="box-header">
          <AppIcon name="commit" />
          <h2>{{ t("commitDetails") }}</h2>
        </div>
        <div class="commit-detail-body">
          <code class="commit-oid">{{ route.query.oid }}</code>
          <GitSignatureStatus
            v-if="selectedCommit"
            :repository-id="repository.id"
            :ref-name="refName"
            :oid="selectedCommit.oid"
          />
          <p v-if="selectedCommit" class="commit-full-message">{{ selectedCommit.message }}</p>
          <p v-else class="muted">{{ t("commitNotInGraph") }}</p>
          <RouterLink
            v-if="selectedCommit"
            class="btn btn-sm"
            :to="{
              path: `/${repository.owner}/${repository.name}/commit/${selectedCommit.oid}`,
              query: { ref: refName },
            }"
            >{{ t("viewCommit") }}</RouterLink
          >
          <div class="commit-parents">
            <strong>{{ t("parents") }}</strong>
            <AppLink
              v-for="parent in selectedCommit?.parents"
              :key="parent"
              :to="{
                path: `/${repository.owner}/${repository.name}/commits`,
                query: { ref: refName, oid: parent },
              }"
              >{{ parent }}</AppLink
            >
          </div>
        </div>
      </section>
    </template>
    <section v-else class="box compare-panel">
      <div class="box-header">
        <AppIcon name="diff" />
        <h2>{{ t("compare") }}</h2>
      </div>
      <div class="compare-body">
        <div class="compare-form">
          <SelectField v-model="compareBase" :label="t('baseBranch')">
            <option
              v-if="
                !refs.some((item) => item.name.replace(/^refs\/(heads|tags)\//, '') === refName)
              "
              :value="refName"
            >
              {{ refName.slice(0, 12) }}
            </option>
            <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </SelectField>
          <AppIcon class="compare-arrow" name="arrowLeft" />
          <SelectField v-model="compareHead" :label="t('headBranch')">
            <option
              v-if="
                !refs.some((item) => item.name.replace(/^refs\/(heads|tags)\//, '') === refName)
              "
              :value="refName"
            >
              {{ refName.slice(0, 12) }}
            </option>
            <option v-for="item in shortRefs(branchRefs)" :key="item.name" :value="item.shortName">
              {{ item.shortName }}
            </option>
          </SelectField>
          <FluentButton type="button" :disabled="loading" @click="load">{{
            t("compare")
          }}</FluentButton>
        </div>
        <StatusState :loading="loading" :error="error" :empty="false" @retry="load" />
        <template v-if="comparison && !loading && !error">
          <div class="compare-summary">
            <p>
              {{ comparison.commits.length }} {{ t("commits") }} · {{ comparison.files.length }}
              {{ t("changedFiles") }}
            </p>
            <RouterLink v-if="canOpenPull" class="btn btn-primary" :to="openPullLocation"
              ><AppIcon name="pr" />{{ t("compareOpenPull") }}</RouterLink
            >
          </div>
          <NoticeBar v-if="comparison.truncated" intent="warning">{{
            t("comparisonTruncated")
          }}</NoticeBar>
          <p v-if="!comparison.commits.length && !comparison.files.length" class="state">
            {{ t("compareNoDifferences") }}
          </p>
          <article v-for="change in comparison.files" :key="change.path" class="compare-file">
            <header class="compare-file-header">
              <AppIcon name="file" />
              <strong>{{ change.path }}</strong>
              <StatusBadge>{{ change.type }}</StatusBadge>
            </header>
            <DiffViewer v-if="change.patch" :patch="change.patch" :path="change.path" />
            <p v-else class="muted">
              {{ change.binary ? t("binaryPreviewUnavailable") : t("diffTooLarge") }}
            </p>
          </article>
        </template>
      </div>
    </section>
    <FileFinderDialog
      v-if="section === 'code' && refs.length"
      v-model:open="showFinder"
      :repository-id="repository.id"
      :ref-name="commitOid ?? refName"
      @select="openFile"
    />
  </section>
</template>

<style src="../styles/code.css"></style>
<style scoped>
.graph-panel .box-header {
  flex-wrap: wrap;
}
.graph-panel .box-header h2 {
  white-space: nowrap;
}
.graph-ref {
  min-width: 0;
  max-width: 100%;
}
.graph-ref-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.graph-note {
  margin-left: auto;
  font-size: var(--font-size-meta);
  font-weight: var(--font-weight-regular);
}
.graph-history {
  position: relative;
}
.graph-scroll {
  position: absolute;
  top: 0;
  left: var(--space-4);
  pointer-events: none;
}
.graph-scroll svg circle {
  pointer-events: all;
  cursor: pointer;
  stroke: var(--bg-raised);
  stroke-width: 2;
}
.commit-row {
  padding: var(--space-2) var(--space-4) var(--space-2)
    calc(var(--space-4) + var(--graph-width) + var(--space-2));
  border-bottom: 1px solid var(--border-muted);
  color: var(--fg-muted);
  font-size: var(--font-size-meta);
}
.commit-row:hover {
  background: var(--bg-subtle);
}
.commit-title {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 24px;
  min-width: 0;
}
.commit-title small {
  white-space: nowrap;
}
.commit-labels {
  display: flex;
  gap: var(--space-2);
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
  color: var(--fg-default);
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-medium);
}
.commit-row code {
  color: var(--fg-muted);
  font: var(--font-size-meta) var(--font-mono);
}
.session-overlay {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-default);
  color: var(--fg-secondary);
  font-size: var(--font-size-meta);
}
.session-overlay > strong {
  color: var(--fg-default);
  font-size: var(--font-size-body);
}
.session-overlay-row {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border-muted);
}
.session-overlay-row small {
  color: var(--fg-muted);
}
.graph-more {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-default);
}
.graph-error {
  color: var(--danger-fg);
}
.commit-detail-body {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
}
.commit-oid,
.commit-parents a {
  overflow-wrap: anywhere;
  font: var(--font-size-meta) / 20px var(--font-mono);
}
.commit-oid {
  color: var(--fg-muted);
}
.commit-full-message {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.commit-parents {
  display: grid;
  gap: var(--space-1);
}
.token-once {
  display: grid;
  gap: var(--space-3);
  overflow-wrap: anywhere;
}
.token-once p {
  margin: var(--space-1) 0 0;
  color: var(--fg-secondary);
}
.token-once code {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
.compare-body {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
}
.compare-form {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--space-3);
}
.compare-form > .select-field {
  flex: 1 1 200px;
  max-width: 280px;
}
.compare-arrow {
  align-self: flex-end;
  height: var(--control-height);
  color: var(--fg-muted);
}
.compare-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
  color: var(--fg-secondary);
}
@media (max-width: 720px) {
  .commit-title small {
    display: none;
  }
  .graph-note {
    flex-basis: 100%;
    margin-left: 0;
  }
  .compare-arrow {
    display: none;
  }
  .compare-form > .select-field {
    max-width: none;
  }
}
</style>
