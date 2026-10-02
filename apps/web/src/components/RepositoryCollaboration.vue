<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type {
  CheckRun,
  GitComparison,
  AgentSession,
  Comment,
  Discussion,
  Issue,
  PullRequest,
  Repository,
  Review,
  WikiPage,
} from "../lib/api";
import { ApiError, api } from "../lib/api";
import { sessionState } from "../lib/session";
import { oneOf } from "../ui/formEvents";
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import AssignmentPanel from "./AssignmentPanel.vue";
import FormActions from "./FormActions.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import TextField from "./TextField.vue";
import TextAreaField from "./TextAreaField.vue";
import MarkdownContent from "./MarkdownContent.vue";
import DiffViewer from "./DiffViewer.vue";

const discussionCategories = [
  "general",
  "ideas",
  "q-and-a",
  "announcements",
] as const satisfies readonly Discussion["category"][];
const reviewStates = [
  "commented",
  "approved",
  "changes_requested",
] as const satisfies readonly Review["state"][];
const checkStatuses = [
  "queued",
  "in_progress",
  "completed",
] as const satisfies readonly CheckRun["status"][];
const checkConclusions = [
  "success",
  "failure",
  "neutral",
  "cancelled",
] as const satisfies readonly NonNullable<CheckRun["conclusion"]>[];

const props = defineProps<{ repository: Repository; section: string }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const issues = ref<Issue[]>([]);
const pulls = ref<PullRequest[]>([]);
const discussions = ref<Discussion[]>([]);
const pages = ref<WikiPage[]>([]);
const item = ref<Issue | PullRequest | Discussion | WikiPage | null>(null);
const comments = ref<Comment[]>([]);
const reviews = ref<Review[]>([]);
const checks = ref<CheckRun[]>([]);
const wikiHistory = ref<WikiPage[]>([]);
const wikiEditing = ref(false);
const wikiDraft = ref({ title: "", content: "" });
const diff = ref<GitComparison | null>(null);
const loading = ref(false);
const error = ref("");
const notFound = ref(false);
const showForm = ref(false);
const editMode = ref(false);
const editDraft = ref({ title: "", body: "", labels: "", draft: false });
const saving = ref(false);
const formError = ref("");
const form = ref<{
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  labels: string;
  category: Discussion["category"];
  slug: string;
  headSessionId: string;
}>({
  title: "",
  body: "",
  headRef: "",
  baseRef: props.repository.defaultBranch,
  labels: "",
  category: "general",
  slug: "",
  headSessionId: "",
});
const commentBody = ref("");
const editCommentId = ref("");
const reviewForm = ref<{ state: Review["state"]; body: string }>({ state: "commented", body: "" });
const agentSessions = ref<AgentSession[]>([]);
const checkForm = ref<{
  name: string;
  commitOid: string;
  status: CheckRun["status"];
  conclusion: NonNullable<CheckRun["conclusion"]>;
  summary: string;
}>({ name: "", commitOid: "", status: "completed", conclusion: "success", summary: "" });
const queryText = ref("");
const stateFilter = ref<"open" | "closed" | "all">("open");
const categoryFilter = ref<"all" | Discussion["category"]>("all");
const issueView = ref<"all" | "assigned" | "created" | "recent">("all");
const detailTab = ref<"conversation" | "files" | "checks">("conversation");
const commentPreview = ref(false);
const wikiPreview = ref(false);
const collectionRows = computed<(Issue | PullRequest | Discussion)[]>(() =>
  props.section === "issues"
    ? issues.value
    : props.section === "pulls"
      ? pulls.value
      : discussions.value
);
function matchesFilters(row: Issue | PullRequest | Discussion): boolean {
  const matchesState =
    stateFilter.value === "all" ||
    row.state === stateFilter.value ||
    (stateFilter.value === "closed" && "mergedOid" in row && row.state === "merged");
  const matchesCategory =
    !("category" in row) || categoryFilter.value === "all" || row.category === categoryFilter.value;
  const author = row.actor.name;
  const labels = "labels" in row ? row.labels.join(" ") : "";
  const matchesText = `${row.title} ${row.number} ${author} ${labels}`
    .toLocaleLowerCase()
    .includes(queryText.value.trim().toLocaleLowerCase());
  return matchesState && matchesCategory && matchesText;
}
function isAssignedToMe(issue: Issue): boolean {
  return issue.assignees.some(
    (assignee) => assignee.kind === "user" && assignee.id === sessionState.user?.id
  );
}
const baseIssues = computed(() => issues.value.filter(matchesFilters));
const assignedIssueCount = computed(() => baseIssues.value.filter(isAssignedToMe).length);
const createdIssueCount = computed(
  () =>
    baseIssues.value.filter(
      (issue) => issue.actor.kind === "user" && issue.actor.id === sessionState.user?.id
    ).length
);
const filteredIssues = computed(() => {
  const rows = baseIssues.value.filter((issue) => {
    if (issueView.value === "assigned") return isAssignedToMe(issue);
    if (issueView.value === "created")
      return issue.actor.kind === "user" && issue.actor.id === sessionState.user?.id;
    return true;
  });
  return issueView.value === "recent"
    ? [...rows].sort((left, right) => right.updatedAt - left.updatedAt)
    : rows;
});
const filteredPulls = computed(() => pulls.value.filter(matchesFilters));
const filteredDiscussions = computed(() => discussions.value.filter(matchesFilters));
const openCount = computed(() => collectionRows.value.filter((row) => row.state === "open").length);
const closedCount = computed(
  () => collectionRows.value.filter((row) => row.state !== "open").length
);
const totalCount = computed(() => collectionRows.value.length);
const detailNumber = computed(() => Number(route.params.number) || 0);
const wikiSlug = computed(() => String(route.params.slug || ""));
const isDetail = computed(() => detailNumber.value > 0 || Boolean(wikiSlug.value));
const discussionItem = computed(() => {
  const current = item.value;
  return current && "answerCommentId" in current ? current : null;
});
const pullIsOpen = computed(() => {
  const current = item.value;
  return current !== null && "headRef" in current && current.state === "open";
});
const canCreate = computed(() => Boolean(sessionState.user) && !props.repository.archived);
const showEditActions = computed(() => props.repository.canWrite && !props.repository.archived);
const resource = computed<"issues" | "pull-requests" | "discussions">(() =>
  props.section === "issues"
    ? "issues"
    : props.section === "pulls"
      ? "pull-requests"
      : "discussions"
);
let loadVersion = 0;

function stateTone(state: Issue["state"] | PullRequest["state"]): "success" | "danger" | "brand" {
  if (state === "open") return "success";
  return state === "merged" ? "brand" : "danger";
}
function isCurrentRevision(revision: number): boolean {
  const current = item.value;
  return current !== null && "revision" in current && current.revision === revision;
}
function actorName(value: {
  actor?: { kind: string; name: string };
  author?: string;
  updatedBy?: string;
}): string {
  return value.actor
    ? `${value.actor.name}${value.actor.kind === "agent" ? ` · ${t("agent")}` : ""}`
    : value.author || value.updatedBy || "";
}
function itemStatus(value: Issue | PullRequest | Discussion | WikiPage): string {
  return "state" in value ? t(value.state) : `r${value.revision}`;
}
function itemCreatedAt(value: Issue | PullRequest | Discussion | WikiPage): number {
  return "createdAt" in value ? value.createdAt : value.updatedAt;
}
function userMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) return t("resourceNotFound");
  if (cause instanceof ApiError && cause.status === 403) return t("permissionDenied");
  return t("apiError");
}
function goTo(number: number) {
  return router.push(
    `/${props.repository.owner}/${props.repository.name}/${props.section}/${number}`
  );
}
function goToWiki(slug: string) {
  return router.push(
    `/${props.repository.owner}/${props.repository.name}/wiki/${encodeURIComponent(slug)}`
  );
}
function startWikiPage() {
  showForm.value = true;
  void router.push(`/${props.repository.owner}/${props.repository.name}/wiki`);
}
async function load() {
  const version = ++loadVersion;
  loading.value = true;
  error.value = "";
  notFound.value = false;
  item.value = null;
  try {
    if (props.section === "issues") {
      if (detailNumber.value) {
        const [detail, rows] = await Promise.all([
          api.issue(props.repository.id, detailNumber.value),
          api.comments(props.repository.id, "issues", detailNumber.value),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        editDraft.value = {
          title: detail.title,
          body: detail.body,
          labels: detail.labels.join(", "),
          draft: false,
        };
        comments.value = rows;
      } else issues.value = await api.issues(props.repository.id);
    } else if (props.section === "pulls") {
      if (detailNumber.value) {
        const [detail, rows, reviewRows, checkRows, comparison] = await Promise.all([
          api.pull(props.repository.id, detailNumber.value),
          api.comments(props.repository.id, "pull-requests", detailNumber.value),
          api.reviews(props.repository.id, detailNumber.value),
          api.checks(props.repository.id, detailNumber.value),
          api.pullDiff(props.repository.id, detailNumber.value),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        editDraft.value = {
          title: detail.title,
          body: detail.body,
          labels: "",
          draft: detail.draft,
        };
        comments.value = rows;
        reviews.value = reviewRows;
        checks.value = checkRows;
        diff.value = comparison;
      } else {
        const [pullRows, sessionRows] = await Promise.all([
          api.pulls(props.repository.id),
          props.repository.canWrite
            ? api.repositorySessions(props.repository.id)
            : Promise.resolve([]),
        ]);
        if (version !== loadVersion) return;
        pulls.value = pullRows;
        agentSessions.value = sessionRows;
      }
    } else if (props.section === "discussions") {
      if (detailNumber.value) {
        const [detail, rows] = await Promise.all([
          api.discussion(props.repository.id, detailNumber.value),
          api.comments(props.repository.id, "discussions", detailNumber.value),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        editDraft.value = {
          title: detail.title,
          body: detail.body,
          labels: "",
          draft: false,
        };
        comments.value = rows;
      } else discussions.value = await api.discussions(props.repository.id);
    } else if (props.section === "wiki") {
      if (wikiSlug.value) {
        const [detail, history, pageRows] = await Promise.all([
          api.wikiPage(props.repository.id, wikiSlug.value),
          api.wikiHistory(props.repository.id, wikiSlug.value),
          api.wiki(props.repository.id),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        wikiDraft.value = { title: detail.title, content: detail.content };
        wikiEditing.value = false;
        wikiHistory.value = history;
        pages.value = pageRows;
      } else pages.value = await api.wiki(props.repository.id);
    } else {
      error.value = t("unknownSection");
    }
  } catch (cause) {
    if (version !== loadVersion) return;
    if (cause instanceof ApiError && cause.status === 404 && isDetail.value) notFound.value = true;
    else error.value = userMessage(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
function resetForm() {
  form.value = {
    title: "",
    body: "",
    headRef: "",
    baseRef: props.repository.defaultBranch,
    labels: "",
    category: "general",
    slug: "",
    headSessionId: "",
  };
}
async function submitCreate() {
  saving.value = true;
  formError.value = "";
  try {
    if (props.section === "issues") {
      const created = await api.createIssue(props.repository.id, {
        title: form.value.title,
        body: form.value.body,
        labels: form.value.labels
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      });
      await goTo(created.number);
    } else if (props.section === "pulls") {
      const created = await api.createPullRequest(props.repository.id, {
        title: form.value.title,
        body: form.value.body,
        headRef: form.value.headRef,
        baseRef: form.value.baseRef,
        headSessionId: form.value.headSessionId || null,
      });
      await goTo(created.number);
    } else if (props.section === "discussions") {
      const created = await api.createDiscussion(props.repository.id, {
        title: form.value.title,
        body: form.value.body,
        category: form.value.category,
      });
      await goTo(created.number);
    } else {
      const created = await api.updateWikiPage(props.repository.id, form.value.slug, {
        title: form.value.title,
        content: form.value.body,
      });
      await goToWiki(created.slug);
    }
    resetForm();
    showForm.value = false;
    await load();
  } catch (cause) {
    formError.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function saveItem() {
  if (!detailNumber.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (props.section === "issues")
      item.value = await api.updateIssue(props.repository.id, detailNumber.value, {
        title: editDraft.value.title,
        body: editDraft.value.body,
        labels: editDraft.value.labels
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      });
    else if (props.section === "pulls")
      item.value = await api.updatePullRequest(props.repository.id, detailNumber.value, {
        title: editDraft.value.title,
        body: editDraft.value.body,
        draft: editDraft.value.draft,
      });
    else if (props.section === "discussions")
      item.value = await api.updateDiscussion(props.repository.id, detailNumber.value, {
        title: editDraft.value.title,
        body: editDraft.value.body,
      });
    editMode.value = false;
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function updateState(state: "open" | "closed") {
  if (!detailNumber.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (props.section === "issues")
      item.value = await api.updateIssue(props.repository.id, detailNumber.value, { state });
    else if (props.section === "pulls")
      item.value = await api.updatePullRequest(props.repository.id, detailNumber.value, { state });
    else
      item.value = await api.updateDiscussion(props.repository.id, detailNumber.value, { state });
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function postComment() {
  if (!detailNumber.value || !commentBody.value.trim()) return;
  saving.value = true;
  error.value = "";
  try {
    if (editCommentId.value)
      await api.updateComment(
        props.repository.id,
        resource.value,
        detailNumber.value,
        editCommentId.value,
        commentBody.value
      );
    else
      await api.createComment(
        props.repository.id,
        resource.value,
        detailNumber.value,
        commentBody.value
      );
    commentBody.value = "";
    editCommentId.value = "";
    comments.value = await api.comments(props.repository.id, resource.value, detailNumber.value);
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
function startEditComment(comment: Comment) {
  editCommentId.value = comment.id;
  commentBody.value = comment.body;
}
async function removeComment(comment: Comment) {
  try {
    await api.deleteComment(props.repository.id, resource.value, detailNumber.value, comment.id);
    comments.value = comments.value.filter((row) => row.id !== comment.id);
  } catch (cause) {
    error.value = userMessage(cause);
  }
}
async function saveWiki() {
  const current = item.value;
  if (!current || !("revision" in current)) return;
  saving.value = true;
  try {
    item.value = await api.updateWikiPage(props.repository.id, wikiSlug.value, {
      ...wikiDraft.value,
      expectedRevision: current.revision,
    });
    wikiEditing.value = false;
    await load();
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function restoreWiki(page: WikiPage) {
  const current = item.value;
  if (!current || !("revision" in current)) return;
  saving.value = true;
  try {
    item.value = await api.updateWikiPage(props.repository.id, wikiSlug.value, {
      title: page.title,
      content: page.content,
      expectedRevision: current.revision,
    });
    await load();
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function addReview() {
  if (!detailNumber.value || !diff.value) return;
  try {
    await api.createReview(props.repository.id, detailNumber.value, {
      commitOid: diff.value.headOid,
      state: reviewForm.value.state,
      body: reviewForm.value.body,
    });
    reviews.value = await api.reviews(props.repository.id, detailNumber.value);
  } catch (cause) {
    error.value = userMessage(cause);
  }
}
async function addCheck() {
  if (!detailNumber.value) return;
  try {
    await api.createCheck(props.repository.id, detailNumber.value, {
      ...checkForm.value,
      conclusion: checkForm.value.status === "completed" ? checkForm.value.conclusion : null,
    });
    checks.value = await api.checks(props.repository.id, detailNumber.value);
  } catch (cause) {
    error.value = userMessage(cause);
  }
}
async function mergePull() {
  if (!detailNumber.value || !diff.value) return;
  saving.value = true;
  try {
    item.value = await api.mergePull(props.repository.id, detailNumber.value, {
      expectedBaseOid: diff.value.baseOid,
      expectedHeadOid: diff.value.headOid,
    });
    await load();
  } catch (cause) {
    error.value = userMessage(cause);
  } finally {
    saving.value = false;
  }
}
async function markAnswer(comment: Comment | null) {
  if (!detailNumber.value) return;
  try {
    item.value = await api.updateDiscussion(props.repository.id, detailNumber.value, {
      answerCommentId: comment?.id ?? null,
    });
  } catch (cause) {
    error.value = userMessage(cause);
  }
}
function toggleAnswer(comment: Comment) {
  void markAnswer(discussionItem.value?.answerCommentId === comment.id ? null : comment);
}
watch(
  () => [props.repository.id, props.section, route.fullPath],
  () => {
    void load();
  },
  { immediate: true }
);
</script>

<template>
  <section class="collab-section">
    <div v-if="loading || error || notFound" class="box">
      <StatusState :loading="loading" :error="error" :empty="notFound" @retry="load"
        ><template #empty>{{ t("resourceNotFound") }}</template></StatusState
      >
    </div>
    <template v-else-if="!isDetail">
      <aside v-if="section === 'issues'" class="issue-rail" :aria-label="t('issues')">
        <button type="button" :aria-pressed="issueView === 'all'" @click="issueView = 'all'">
          <AppIcon name="issue" />{{ t("issues") }}<span>{{ baseIssues.length }}</span>
        </button>
        <button
          v-if="sessionState.user"
          type="button"
          :aria-pressed="issueView === 'assigned'"
          @click="issueView = 'assigned'"
        >
          <AppIcon name="person" />{{ t("assignedToMe") }}<span>{{ assignedIssueCount }}</span>
        </button>
        <button
          v-if="sessionState.user"
          type="button"
          :aria-pressed="issueView === 'created'"
          @click="issueView = 'created'"
        >
          <AppIcon name="issue" />{{ t("createdByMe") }}<span>{{ createdIssueCount }}</span>
        </button>
        <button type="button" :aria-pressed="issueView === 'recent'" @click="issueView = 'recent'">
          <AppIcon name="clock" />{{ t("recentActivity") }}<span>{{ baseIssues.length }}</span>
        </button>
      </aside>
      <div class="section-actions">
        <h1>
          {{
            section === "issues"
              ? t("issues")
              : section === "pulls"
                ? t("pulls")
                : section === "discussions"
                  ? t("discussions")
                  : t("wiki")
          }}
        </h1>
        <FluentButton
          v-if="canCreate && (section !== 'wiki' || repository.canWrite)"
          type="button"
          tone="primary"
          @click="showForm = !showForm"
        >
          <AppIcon name="plus" />
          {{
            section === "issues"
              ? t("createIssue")
              : section === "pulls"
                ? t("createPull")
                : section === "discussions"
                  ? t("createDiscussion")
                  : t("createWiki")
          }}
        </FluentButton>
      </div>
      <form
        v-if="showForm"
        class="box box-form form-stack create-form"
        @submit.prevent="submitCreate"
      >
        <TextField v-model="form.title" required>{{ t("issueTitle") }}</TextField>
        <TextField v-if="section === 'wiki'" v-model="form.slug" required>{{
          t("slug")
        }}</TextField>
        <TextAreaField v-model="form.body" rows="5" :label="t('issueBody')" />
        <template v-if="section === 'issues'">
          <TextField v-model="form.labels" :placeholder="t('commaSeparated')">{{
            t("labels")
          }}</TextField>
        </template>
        <template v-if="section === 'pulls'">
          <TextField v-model="form.headRef" required>{{ t("headBranch") }}</TextField>
          <TextField v-model="form.baseRef" required>{{ t("baseBranch") }}</TextField>
          <SelectField v-model="form.headSessionId" :label="t('sessionFork')">
            <option value="">{{ t("noSessionFork") }}</option>
            <option
              v-for="session in agentSessions.filter((value) => value.status === 'active')"
              :key="session.id"
              :value="session.id"
            >
              {{ session.agentName }} / {{ session.workspaceName }}
            </option>
          </SelectField>
        </template>
        <SelectField
          v-if="section === 'discussions'"
          :model-value="form.category"
          :label="t('category')"
          @update:model-value="form.category = oneOf(discussionCategories, $event, 'general')"
        >
          <option value="general">{{ t("categoryGeneral") }}</option>
          <option value="ideas">{{ t("categoryIdeas") }}</option>
          <option value="q-and-a">{{ t("categoryQa") }}</option>
          <option value="announcements">{{ t("categoryAnnouncements") }}</option>
        </SelectField>
        <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
      </form>
      <label v-if="section !== 'wiki'" class="search-field list-search"
        ><AppIcon name="search" /><input
          v-model="queryText"
          type="search"
          :placeholder="t('searchItems')"
          :aria-label="t('searchItems')"
      /></label>
      <div v-if="section !== 'wiki'" class="list-toolbar box">
        <div class="list-filters" role="group" :aria-label="t('filterItems')">
          <button
            v-for="state in ['open', 'closed', 'all'] as const"
            :key="state"
            type="button"
            class="filter-button"
            :aria-pressed="stateFilter === state"
            @click="stateFilter = state"
          >
            <AppIcon :name="state === 'open' ? 'issue' : state === 'closed' ? 'check' : 'filter'" />
            {{ t(state === "all" ? "allItems" : state) }}
            <span class="filter-count">{{
              state === "open" ? openCount : state === "closed" ? closedCount : totalCount
            }}</span>
          </button>
          <SelectField
            v-if="section === 'discussions'"
            v-model="categoryFilter"
            :label="t('category')"
          >
            <option value="all">{{ t("allCategories") }}</option>
            <option value="general">{{ t("categoryGeneral") }}</option>
            <option value="ideas">{{ t("categoryIdeas") }}</option>
            <option value="q-and-a">{{ t("categoryQa") }}</option>
            <option value="announcements">{{ t("categoryAnnouncements") }}</option>
          </SelectField>
        </div>
      </div>
      <div v-if="section === 'issues'" class="box">
        <RouterLink
          v-for="row in filteredIssues"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/issues/${row.number}`"
          ><AppIcon
            :name="row.state === 'open' ? 'issue' : 'checkCircle'"
            :class="row.state === 'open' ? 'state-open' : 'state-closed'"
          />
          <span class="collab-row-content"
            ><span class="collab-row-title"
              ><strong>{{ row.title }}</strong
              ><StatusBadge
                v-for="label in row.labels"
                :key="label"
                :tone="label === 'bug' ? 'danger' : label === 'enhancement' ? 'brand' : 'neutral'"
                >{{ label }}</StatusBadge
              ></span
            ><span class="collab-row-meta"
              >#{{ row.number }} · {{ t("openedBy", { author: actorName(row) }) }} ·
              {{ new Date(row.createdAt).toLocaleDateString() }}</span
            ></span
          ></RouterLink
        >
        <div v-if="!issues.length" class="empty-onboarding">
          <AppIcon name="issue" />
          <h3>{{ t("noIssuesTitle") }}</h3>
          <p>{{ t("noIssuesBody") }}</p>
          <button v-if="canCreate" class="btn btn-primary" type="button" @click="showForm = true">
            {{ t("createIssue") }}
          </button>
        </div>
        <p v-else-if="!filteredIssues.length" class="state">{{ t("noMatchingItems") }}</p>
      </div>
      <div v-else-if="section === 'pulls'" class="box">
        <RouterLink
          v-for="row in filteredPulls"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/pulls/${row.number}`"
          ><AppIcon
            :name="row.state === 'merged' ? 'gitMerge' : 'pr'"
            :class="row.state === 'open' ? 'state-open' : 'state-closed'"
          />
          <span class="collab-row-content"
            ><span class="collab-row-title"
              ><strong>{{ row.title }}</strong
              ><StatusBadge v-if="row.draft">{{ t("draftPull") }}</StatusBadge
              ><StatusBadge v-if="row.headSessionId" tone="brand">{{
                t("agentSession")
              }}</StatusBadge></span
            ><span class="collab-row-meta"
              >#{{ row.number }} · {{ t("openedBy", { author: actorName(row) }) }} ·
              {{ row.headRef }} → {{ row.baseRef }}</span
            ></span
          ></RouterLink
        >
        <div v-if="!pulls.length" class="empty-onboarding">
          <AppIcon name="pr" />
          <h3>{{ t("noPullsTitle") }}</h3>
          <p>{{ t("noPullsBody") }}</p>
          <button v-if="canCreate" class="btn btn-primary" type="button" @click="showForm = true">
            {{ t("createPull") }}
          </button>
        </div>
        <p v-else-if="!filteredPulls.length" class="state">{{ t("noMatchingItems") }}</p>
      </div>
      <div v-else-if="section === 'discussions'" class="box">
        <RouterLink
          v-for="row in filteredDiscussions"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/discussions/${row.number}`"
          ><AppIcon name="discussion" /><span class="collab-row-content"
            ><span class="collab-row-title"
              ><strong>{{ row.title }}</strong
              ><StatusBadge v-if="row.answerCommentId" tone="success">{{
                t("answered")
              }}</StatusBadge></span
            ><span class="collab-row-meta"
              >#{{ row.number }} · {{ actorName(row) }} · {{ t(`category${row.category}`) }} ·
              {{ new Date(row.createdAt).toLocaleDateString() }}</span
            ></span
          ></RouterLink
        >
        <div v-if="!discussions.length" class="empty-onboarding">
          <AppIcon name="discussion" />
          <h3>{{ t("noDiscussionsTitle") }}</h3>
          <p>{{ t("noDiscussionsBody") }}</p>
          <button v-if="canCreate" class="btn btn-primary" type="button" @click="showForm = true">
            {{ t("createDiscussion") }}
          </button>
        </div>
        <p v-else-if="!filteredDiscussions.length" class="state">{{ t("noMatchingItems") }}</p>
      </div>
      <div v-else-if="section === 'wiki'" class="box">
        <RouterLink
          v-for="page in pages"
          :key="page.slug"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/wiki/${encodeURIComponent(page.slug)}`"
          ><strong>{{ page.title }}</strong
          ><code>{{ page.slug }}</code
          ><small>r{{ page.revision }} · {{ page.updatedBy }}</small></RouterLink
        >
        <div v-if="!pages.length" class="empty-onboarding">
          <AppIcon name="wiki" />
          <h3>{{ t("noWikiTitle") }}</h3>
          <p>{{ t("noWikiBody") }}</p>
          <button
            v-if="repository.canWrite"
            class="btn btn-primary"
            type="button"
            @click="showForm = true"
          >
            {{ t("createWiki") }}
          </button>
        </div>
      </div>
    </template>
    <template v-else-if="item">
      <AppLink class="back-link" :to="`/${repository.owner}/${repository.name}/${section}`"
        >← {{ t(section === "wiki" ? "wiki" : section) }}</AppLink
      >
      <header class="detail-titlebar detail-heading box">
        <div>
          <h2>
            {{ item.title }}
            <span v-if="detailNumber" class="detail-number">#{{ detailNumber }}</span>
          </h2>
          <div class="detail-state-row">
            <StatusBadge v-if="'state' in item" :tone="stateTone(item.state)"
              ><AppIcon :name="item.state === 'open' ? 'issue' : 'checkCircle'" />{{
                itemStatus(item)
              }}</StatusBadge
            ><StatusBadge v-else>{{ itemStatus(item) }}</StatusBadge>
            <code v-if="'mergedOid' in item && item.mergedOid"
              >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</code
            ><span class="muted"
              >{{ t("openedBy", { author: actorName(item) }) }} ·
              {{ new Date(itemCreatedAt(item)).toLocaleDateString() }}</span
            >
          </div>
        </div>
        <div
          v-if="showEditActions && 'state' in item && item.state !== 'merged'"
          class="detail-actions"
        >
          <FluentButton type="button" @click="editMode = !editMode">
            {{ editMode ? t("cancel") : t("edit") }}</FluentButton
          ><FluentButton
            v-if="item.state === 'closed'"
            type="button"
            :disabled="saving"
            @click="updateState('open')"
          >
            {{ t("reopen") }}</FluentButton
          ><FluentButton
            v-if="item.state === 'open'"
            type="button"
            :disabled="saving"
            @click="updateState('closed')"
          >
            {{ t("closeIssue") }}
          </FluentButton>
        </div>
      </header>
      <article
        v-if="section !== 'pulls' || detailTab === 'conversation'"
        class="box box-form detail-card"
      >
        <div v-if="'actor' in item" class="actor-line">
          <span class="avatar avatar-sm">{{ actorName(item).slice(0, 2).toUpperCase() }}</span
          ><strong>{{ actorName(item) }}</strong> ·
          {{ new Date(itemCreatedAt(item)).toLocaleString()
          }}<StatusBadge v-if="item.actor.kind === 'agent'" tone="brand">{{
            t("agentAuthored")
          }}</StatusBadge>
        </div>
        <p v-else-if="'author' in item" class="actor-line">
          {{ item.author }} · {{ new Date(itemCreatedAt(item)).toLocaleString() }}
        </p>
        <form v-if="editMode" class="form-stack inline-form item-edit" @submit.prevent="saveItem">
          <TextField v-model="editDraft.title" required>{{ t("issueTitle") }}</TextField>
          <TextAreaField v-model="editDraft.body" rows="6" :label="t('issueBody')" />
          <template v-if="section === 'issues'">
            <TextField v-model="editDraft.labels" :placeholder="t('commaSeparated')">{{
              t("labels")
            }}</TextField>
          </template>
          <FluentCheckbox v-if="section === 'pulls'" id="edit-draft" v-model="editDraft.draft">
            {{ t("draftPull") }}
          </FluentCheckbox>
          <div class="form-actions">
            <FluentButton type="submit" tone="primary" :disabled="saving">{{
              t("save")
            }}</FluentButton>
          </div>
        </form>
        <MarkdownContent
          v-else
          class="body-content"
          :source="'content' in item ? item.content : item.body"
        />
        <div v-if="'headRef' in item && (item.headSessionId || item.mergedOid)" class="pull-meta">
          <StatusBadge v-if="item.headSessionId" tone="brand"
            >{{ t("sessionFork") }} · {{ item.headSessionId }}</StatusBadge
          ><StatusBadge v-if="item.mergedOid" tone="success"
            >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</StatusBadge
          >
        </div>

        <div v-if="section === 'wiki' && showEditActions" class="wiki-edit-actions">
          <FluentButton type="button" @click="wikiEditing = !wikiEditing">
            {{ wikiEditing ? t("cancel") : t("edit") }}
          </FluentButton>
          <form v-if="wikiEditing" class="form-stack inline-form" @submit.prevent="saveWiki">
            <TextField v-model="wikiDraft.title" required>{{ t("issueTitle") }}</TextField>
            <div class="composer-tabs">
              <button type="button" :aria-pressed="!wikiPreview" @click="wikiPreview = false">
                {{ t("write") }}</button
              ><button type="button" :aria-pressed="wikiPreview" @click="wikiPreview = true">
                {{ t("preview") }}
              </button>
            </div>
            <TextAreaField
              v-if="!wikiPreview"
              v-model="wikiDraft.content"
              rows="8"
              :label="t('issueBody')"
            />
            <MarkdownContent
              v-else
              class="composer-preview"
              :source="wikiDraft.content || t('nothingToPreview')"
            />
            <div class="form-actions">
              <FluentButton type="submit" tone="primary" :disabled="saving">{{
                t("save")
              }}</FluentButton>
            </div>
          </form>
        </div>
        <div v-if="section === 'wiki'" class="wiki-history">
          <p class="eyebrow">{{ t("revisionHistory") }}</p>
          <div
            v-for="revision in wikiHistory"
            :key="`${revision.slug}-${revision.revision}`"
            class="item-row"
          >
            <strong>r{{ revision.revision }} · {{ revision.title }}</strong
            ><small
              >{{ revision.updatedBy }} · {{ new Date(revision.updatedAt).toLocaleString() }}</small
            ><FluentButton
              v-if="showEditActions"
              type="button"
              size="small"
              :disabled="saving || isCurrentRevision(revision.revision)"
              @click="restoreWiki(revision)"
            >
              {{ t("restoreRevision") }}
            </FluentButton>
          </div>
        </div>
      </article>
      <aside
        v-if="section !== 'wiki' && (section !== 'pulls' || detailTab === 'conversation')"
        class="detail-sidebar box"
      >
        <section v-if="'labels' in item" class="sidebar-section">
          <h3>{{ t("labels") }}</h3>
          <div v-if="item.labels.length" class="sidebar-tags">
            <StatusBadge v-for="label in item.labels" :key="label">{{ label }}</StatusBadge>
          </div>
          <p v-else class="muted">{{ t("noLabels") }}</p>
        </section>
        <AssignmentPanel
          v-if="(section === 'issues' || section === 'pulls') && 'assignees' in item"
          :repository="repository"
          :kind="section === 'issues' ? 'issue' : 'pull_request'"
          :item="item"
          @updated="item = $event"
        />
        <section class="sidebar-section">
          <h3>{{ t("author") }}</h3>
          <p class="sidebar-person">
            <span class="avatar">{{ actorName(item).slice(0, 1).toUpperCase() }}</span
            >{{ actorName(item) }}
          </p>
        </section>
        <section v-if="'headRef' in item" class="sidebar-section">
          <h3>{{ t("branches") }}</h3>
          <code>{{ item.headRef }}</code
          ><span class="muted">→</span><code>{{ item.baseRef }}</code>
        </section>
      </aside>
      <aside v-if="section === 'wiki'" class="detail-sidebar box wiki-sidebar">
        <h3>{{ t("pages") }}</h3>
        <RouterLink
          v-for="page in pages"
          :key="page.slug"
          :to="`/${repository.owner}/${repository.name}/wiki/${encodeURIComponent(page.slug)}`"
          :aria-current="page.slug === wikiSlug ? 'page' : undefined"
          >{{ page.title }}</RouterLink
        ><button v-if="repository.canWrite" class="btn btn-sm" type="button" @click="startWikiPage">
          {{ t("createWiki") }}
        </button>
      </aside>
      <nav v-if="section === 'pulls'" class="pull-tabs" :aria-label="t('pullRequestSections')">
        <button
          type="button"
          :aria-current="detailTab === 'conversation' ? 'page' : undefined"
          @click="detailTab = 'conversation'"
        >
          <AppIcon name="discussion" />{{ t("conversation") }}
          <span>{{ comments.length + 1 }}</span>
        </button>
        <button
          type="button"
          :aria-current="detailTab === 'files' ? 'page' : undefined"
          @click="detailTab = 'files'"
        >
          <AppIcon name="diff" />{{ t("filesChanged") }} <span>{{ diff?.files.length ?? 0 }}</span>
        </button>
        <button
          type="button"
          :aria-current="detailTab === 'checks' ? 'page' : undefined"
          @click="detailTab = 'checks'"
        >
          <AppIcon name="checkCircle" />{{ t("checks") }} <span>{{ checks.length }}</span>
        </button>
      </nav>
      <section
        v-if="section === 'pulls' && detailTab === 'files' && diff"
        class="box box-form pull-review"
      >
        <p class="eyebrow">{{ t("diff") }}</p>
        <p class="muted">
          {{ diff.baseOid.slice(0, 8) }}…{{ diff.headOid.slice(0, 8) }} · {{ diff.commits.length }}
          {{ t("commits") }}
        </p>
        <div v-for="change in diff.files" :key="change.path" class="changed-file">
          <strong>{{ change.type }} · {{ change.path }}</strong>
          <DiffViewer v-if="change.patch" :patch="change.patch" />
          <span v-else class="muted">{{ t("binaryPreviewUnavailable") }}</span>
        </div>
        <div v-if="showEditActions && pullIsOpen" class="merge-actions">
          <FluentButton
            type="button"
            tone="primary"
            :disabled="saving || !diff.headOid"
            @click="mergePull"
          >
            {{ t("mergePull") }}</FluentButton
          ><span class="muted">{{ t("mergeUsesCurrentHeads") }}</span>
        </div>
      </section>
      <section
        v-if="section === 'pulls' && detailTab === 'conversation'"
        class="box box-form review-panel"
      >
        <p class="eyebrow">{{ t("reviews") }}</p>
        <div v-for="review in reviews" :key="review.id" class="item-row">
          <strong>{{ t(`review${review.state}`) }}</strong
          ><StatusBadge :tone="review.actor.kind === 'agent' ? 'brand' : 'neutral'">{{
            actorName(review)
          }}</StatusBadge
          ><code>{{ review.commitOid.slice(0, 8) }}</code
          ><StatusBadge v-if="review.commitOid !== diff?.headOid" tone="warning">{{
            t("outdatedReview")
          }}</StatusBadge>
          <p>{{ review.body }}</p>
        </div>
        <form
          v-if="canCreate && pullIsOpen"
          class="form-stack inline-form"
          @submit.prevent="addReview"
        >
          <SelectField
            :model-value="reviewForm.state"
            :label="t('reviewVerdict')"
            @update:model-value="reviewForm.state = oneOf(reviewStates, $event, 'commented')"
          >
            <option value="commented">{{ t("reviewcommented") }}</option>
            <option value="approved">{{ t("reviewapproved") }}</option>
            <option value="changes_requested">{{ t("reviewchanges_requested") }}</option>
          </SelectField>
          <TextAreaField
            v-model="reviewForm.body"
            :placeholder="t('reviewBody')"
            rows="2"
            :label="t('reviewBody')"
          />
          <div class="form-actions">
            <FluentButton type="submit">{{ t("submitReview") }}</FluentButton>
          </div>
        </form>
      </section>
      <section
        v-if="section === 'pulls' && detailTab === 'checks'"
        class="box box-form checks-panel"
      >
        <p class="eyebrow">{{ t("checks") }}</p>
        <div v-for="check in checks" :key="check.id" class="item-row">
          <strong>{{ check.name }}</strong
          ><StatusBadge :tone="check.conclusion === 'success' ? 'success' : 'neutral'"
            >{{ check.status }} · {{ check.conclusion || t("pending") }}</StatusBadge
          ><StatusBadge :tone="check.actor.kind === 'agent' ? 'brand' : 'neutral'">{{
            actorName(check)
          }}</StatusBadge
          ><code>{{ check.commitOid.slice(0, 8) }}</code
          ><StatusBadge v-if="check.commitOid !== diff?.headOid" tone="warning">{{
            t("outdatedCheck")
          }}</StatusBadge>
          <p>{{ check.summary }}</p>
          <a v-if="check.detailsUrl" :href="check.detailsUrl" target="_blank" rel="noreferrer">{{
            t("details")
          }}</a>
        </div>
        <form
          v-if="repository.canWrite && pullIsOpen"
          class="form-stack inline-form"
          @submit.prevent="addCheck"
        >
          <TextField v-model="checkForm.name" required>{{ t("checkName") }}</TextField>
          <TextField v-model="checkForm.commitOid" required>{{ t("commitOid") }}</TextField>
          <SelectField
            :model-value="checkForm.status"
            :label="t('checkStatus')"
            @update:model-value="checkForm.status = oneOf(checkStatuses, $event, 'completed')"
          >
            <option value="queued">queued</option>
            <option value="in_progress">in_progress</option>
            <option value="completed">completed</option>
          </SelectField>
          <SelectField
            v-if="checkForm.status === 'completed'"
            :model-value="checkForm.conclusion"
            :label="t('checkConclusion')"
            @update:model-value="checkForm.conclusion = oneOf(checkConclusions, $event, 'success')"
          >
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="neutral">neutral</option>
            <option value="cancelled">cancelled</option>
          </SelectField>
          <TextAreaField
            v-model="checkForm.summary"
            :placeholder="t('summary')"
            rows="2"
            :label="t('summary')"
          />
          <div class="form-actions">
            <FluentButton type="submit">{{ t("addCheck") }}</FluentButton>
          </div>
        </form>
      </section>
      <section
        v-if="section === 'discussions' && discussionItem?.answerCommentId"
        class="box box-form answer-panel"
      >
        <div v-if="discussionItem">
          <p class="eyebrow">{{ t("acceptedAnswer") }}</p>
          <p v-if="discussionItem?.answerCommentId">
            {{
              comments.find((comment) => comment.id === discussionItem?.answerCommentId)?.body ||
              t("answerMarked")
            }}
          </p>
          <FluentButton
            v-if="showEditActions && discussionItem.answerCommentId"
            type="button"
            @click="markAnswer(null)"
          >
            {{ t("clearAnswer") }}
          </FluentButton>
        </div>
      </section>
      <section
        v-if="section !== 'wiki' && (section !== 'pulls' || detailTab === 'conversation')"
        class="box box-form comments-panel"
      >
        <p class="eyebrow">{{ t("comments") }}</p>
        <article v-for="comment in comments" :key="comment.id" class="comment-row">
          <div class="actor-line">
            <span class="avatar">{{ comment.actor.name.slice(0, 1).toUpperCase() }}</span>
            <strong>{{ actorName(comment) }}</strong
            ><StatusBadge v-if="comment.actor.kind === 'agent'" tone="brand">{{
              t("agentAuthored")
            }}</StatusBadge
            ><small>{{ new Date(comment.createdAt).toLocaleString() }}</small
            ><FluentButton
              v-if="showEditActions"
              type="button"
              tone="subtle"
              size="small"
              @click="startEditComment(comment)"
            >
              {{ t("edit") }}</FluentButton
            ><FluentButton
              v-if="showEditActions"
              type="button"
              tone="subtle"
              size="small"
              @click="removeComment(comment)"
            >
              {{ t("delete") }}</FluentButton
            ><FluentButton
              v-if="section === 'discussions' && showEditActions"
              type="button"
              tone="subtle"
              size="small"
              @click="toggleAnswer(comment)"
            >
              {{
                discussionItem?.answerCommentId === comment.id ? t("clearAnswer") : t("markAnswer")
              }}
            </FluentButton>
          </div>
          <MarkdownContent class="body-content" :source="comment.body" />
        </article>
        <form v-if="canCreate" class="form-stack inline-form" @submit.prevent="postComment">
          <div class="composer-tabs">
            <button type="button" :aria-pressed="!commentPreview" @click="commentPreview = false">
              {{ t("write") }}</button
            ><button type="button" :aria-pressed="commentPreview" @click="commentPreview = true">
              {{ t("preview") }}
            </button>
          </div>
          <TextAreaField
            v-if="!commentPreview"
            v-model="commentBody"
            :placeholder="t('writeComment')"
            rows="4"
            required
            :label="t('writeComment')"
          />
          <MarkdownContent
            v-else
            class="composer-preview"
            :source="commentBody || t('nothingToPreview')"
          />
          <div class="form-actions">
            <FluentButton type="submit" tone="primary" :disabled="saving">
              {{ editCommentId ? t("save") : t("comment") }}
            </FluentButton>
          </div>
        </form>
        <p v-else class="muted">{{ t("signInToComment") }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.collab-section {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--spacingVerticalL);
}
.section-actions {
  display: flex;
  justify-content: flex-end;
}
.item-link {
  flex-wrap: wrap;
  align-items: center;
  color: inherit;
}
.item-link:hover {
  text-decoration: none;
}
.item-link:hover strong {
  color: var(--colorBrandForegroundLink);
}
.item-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacingHorizontalM);
  min-height: 48px;
  padding: var(--spacingVerticalS) 0;
  border-bottom: 1px solid var(--colorNeutralStroke2);
}
.item-row small,
.item-link small,
.actor-line {
  color: var(--colorNeutralForeground3);
}
.item-row small,
.item-link small {
  margin-left: auto;
}
.number,
code {
  color: var(--colorBrandForegroundLink);
  font-family: var(--fontFamilyMonospace);
  font-size: var(--fontSizeBase200);
}
.list-limit-note {
  padding: var(--spacingVerticalM);
  color: var(--colorNeutralForeground3);
  font-size: var(--fontSizeBase200);
  text-align: center;
}
.detail-card {
  margin-top: var(--spacingVerticalM);
}
.detail-heading {
  display: flex;
  justify-content: space-between;
  gap: var(--spacingHorizontalL);
  align-items: flex-start;
}
.detail-heading h2 {
  margin: 0 0 var(--spacingVerticalL);
  font-size: var(--fontSizeHero700);
  line-height: var(--lineHeightHero700);
}
.detail-actions {
  display: flex;
  gap: var(--spacingHorizontalS);
}
.actor-line {
  display: flex;
  gap: var(--spacingHorizontalM);
  align-items: center;
  flex-wrap: wrap;
  font-size: var(--fontSizeBase200);
}
.body-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: var(--fontSizeBase300) / 1.7 var(--fontFamilyBase);
  margin: var(--spacingVerticalL) 0;
}
.metadata-row,
.pull-meta {
  display: flex;
  gap: var(--spacingHorizontalS);
  flex-wrap: wrap;
  align-items: center;
  padding: var(--spacingVerticalM) 0;
}
.wiki-history,
.wiki-edit-actions,
.pull-review {
  margin-top: var(--spacingVerticalL);
}
.changed-file {
  border-top: 1px solid var(--colorNeutralStroke2);
  padding: var(--spacingVerticalM) 0;
}
.diff-preview {
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--colorNeutralBackground3);
  border-radius: var(--borderRadiusMedium);
  padding: var(--spacingVerticalM);
  font: var(--fontSizeBase200) / 1.6 var(--fontFamilyMonospace);
}
.merge-actions {
  display: flex;
  align-items: center;
  gap: var(--spacingHorizontalM);
  padding-top: var(--spacingVerticalM);
}
.comment-row {
  border-bottom: 1px solid var(--colorNeutralStroke2);
  padding: var(--spacingVerticalM) 0;
}
.comment-row .actor-line small {
  margin-left: auto;
}
.inline-form {
  margin-top: var(--spacingVerticalM);
}
@media (max-width: 640px) {
  .detail-heading {
    display: block;
  }
  .detail-actions {
    margin-bottom: var(--spacingVerticalM);
  }
}
</style>

<style>
@import "../styles/collaboration.css";
</style>
