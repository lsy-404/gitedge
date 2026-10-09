<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { createTwoFilesPatch } from "diff";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type {
  Actor,
  CheckRun,
  GitComparison,
  AgentSession,
  RepositoryBranch,
  Comment,
  Discussion,
  Issue,
  IssueReferences,
  PullRequest,
  Repository,
  Review,
  WikiPage,
  WikiPageSummary,
} from "../lib/api";
import { ApiError, api, errorMessage } from "../lib/api";
import { sessionState } from "../lib/session";
import { oneOf } from "../ui/formEvents";
import AppIcon, { type IconName } from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import AssignmentPanel from "./AssignmentPanel.vue";
import FormActions from "./FormActions.vue";
import NoticeBar from "./NoticeBar.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import TextField from "./TextField.vue";
import TextAreaField from "./TextAreaField.vue";
import MarkdownContent from "./MarkdownContent.vue";
import DiffViewer from "./DiffViewer.vue";
import ReviewThread from "./ReviewThread.vue";
import { useReviewThreads } from "../lib/reviewThreads";
import { reviewActorKey } from "../../../../packages/contracts/src/review-comments";
import CommunityTemplatePicker from "./CommunityTemplatePicker.vue";

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
const { t, d } = useI18n();
const route = useRoute();
const router = useRouter();
const issues = ref<Issue[]>([]);
const pulls = ref<PullRequest[]>([]);
const discussions = ref<Discussion[]>([]);
const pages = ref<WikiPageSummary[]>([]);
const item = ref<Issue | PullRequest | Discussion | WikiPage | null>(null);
const comments = ref<Comment[]>([]);
const listTruncated = ref(false);
const reviews = ref<Review[]>([]);
const checks = ref<CheckRun[]>([]);
const issueLinks = ref<IssueReferences | null>(null);
const markdownRepository = computed(() => ({
  owner: props.repository.owner,
  slug: props.repository.name,
}));
const mergeMethod = ref<"merge" | "squash" | "rebase">("merge");
const availableMergeMethods = computed(() => [
  ...(props.repository.allowMergeCommit ? (["merge"] as const) : []),
  ...(props.repository.allowSquashMerge ? (["squash"] as const) : []),
  ...(props.repository.allowRebaseMerge ? (["rebase"] as const) : []),
]);
watch(
  availableMergeMethods,
  (methods) => {
    if (!methods.includes(mergeMethod.value)) mergeMethod.value = methods[0] ?? "merge";
  },
  { immediate: true }
);
const branches = ref<RepositoryBranch[]>([]);
const wikiHistory = ref<WikiPageSummary[]>([]);
const viewedRevision = ref<WikiPage | null>(null);
const wikiEditing = ref(false);
const wikiDraft = ref({ title: "", content: "" });
const diff = ref<GitComparison | null>(null);
const mergeError = ref("");
const loading = ref(false);
const loadError = ref("");
const actionError = ref("");
const actionConflict = ref(false);
const actionNotice = ref<HTMLElement | null>(null);
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
  draft: boolean;
}>({
  title: "",
  body: "",
  headRef: "",
  baseRef: props.repository.defaultBranch,
  labels: "",
  category: "general",
  slug: "",
  headSessionId: "",
  draft: false,
});
function applyCommunityTemplate(value: { title: string; body: string }) {
  if (!form.value.title.trim()) form.value.title = value.title;
  if (!form.value.body.trim()) form.value.body = value.body;
}
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
const reviewThreads = useReviewThreads(
  () => props.repository.id,
  () => detailNumber.value,
  () => diff.value?.headOid ?? ""
);
const queryText = ref("");
const stateFilter = ref<"open" | "closed" | "all">("open");
const categoryFilter = ref<"all" | Discussion["category"]>("all");
const issueView = ref<"all" | "assigned" | "created" | "recent">("all");
type DetailTab = "conversation" | "files" | "checks";
const detailTab = ref<DetailTab>("conversation");
const pullTablist = ref<HTMLElement | null>(null);
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
const reviewContext = computed(() => {
  const subject = item.value;
  const pull = subject && "headRef" in subject ? subject : null;
  return {
    canComment: canCreate.value && pullIsOpen.value && Boolean(diff.value?.headOid),
    canModerate: showEditActions.value,
    isPullAuthor: pull !== null && ownedByViewer(pull.actor),
    viewerKey: sessionState.user
      ? reviewActorKey({ kind: "user", id: sessionState.user.id })
      : null,
    hasPendingReview: reviewThreads.pendingCount.value > 0,
    busy: reviewThreads.busy.value,
  };
});
const issueEvents = computed(() => issueLinks.value?.events ?? []);
/** Closing events that happened after the previous comment and before the one at this index. */
function issueEventsBefore(index: number) {
  const upper = comments.value[index]?.createdAt ?? Infinity;
  const lower = index > 0 ? (comments.value[index - 1]?.createdAt ?? -Infinity) : -Infinity;
  return issueEvents.value.filter((event) => event.createdAt > lower && event.createdAt <= upper);
}
const trailingIssueEvents = computed(() => {
  const last = comments.value.at(-1)?.createdAt ?? -Infinity;
  return issueEvents.value.filter((event) => event.createdAt > last);
});
function fileReviewContext(path: string) {
  return {
    ...reviewContext.value,
    threads: reviewThreads.threads.value.filter((thread) => thread.root.path === path),
  };
}
function ownedByViewer(actor: Actor): boolean {
  return actor.kind === "user" && actor.id === sessionState.user?.id;
}
const canEditItem = computed(() => {
  if (props.repository.archived) return false;
  if (props.repository.canWrite) return true;
  const current = item.value;
  return (
    props.section === "issues" &&
    props.repository.visibility === "public" &&
    current !== null &&
    "actor" in current &&
    ownedByViewer(current.actor)
  );
});
function canModifyComment(comment: Comment): boolean {
  return !props.repository.archived && (props.repository.canWrite || ownedByViewer(comment.actor));
}
const viewedRevisionUnchanged = computed(() => {
  const current = item.value;
  const viewed = viewedRevision.value;
  return Boolean(viewed && current && "content" in current && viewed.content === current.content);
});
const viewedRevisionPatch = computed(() => {
  const current = item.value;
  const viewed = viewedRevision.value;
  if (!viewed || !current || !("content" in current)) return "";
  return createTwoFilesPatch(
    `r${viewed.revision}`,
    `r${current.revision}`,
    viewed.content,
    current.content
  );
});
const headBranchFromSession = computed(() => form.value.headSessionId !== "");
const resource = computed<"issues" | "pull-requests" | "discussions">(() =>
  props.section === "issues"
    ? "issues"
    : props.section === "pulls"
      ? "pull-requests"
      : "discussions"
);
const hasSidebar = computed(
  () => props.section === "wiki" || props.section !== "pulls" || detailTab.value === "conversation"
);
const pullTabs = computed(() => [
  {
    key: "conversation" as const,
    icon: "discussion" as const,
    label: t("conversation"),
    count: comments.value.length + 1,
  },
  {
    key: "files" as const,
    icon: "diff" as const,
    label: t("filesChanged"),
    count: diff.value?.files.length ?? 0,
  },
  {
    key: "checks" as const,
    icon: "checkCircle" as const,
    label: t("checks"),
    count: checks.value.length,
  },
]);
interface MergeStatusRow {
  key: string;
  icon: IconName;
  tone: MarkTone | "muted" | "warning";
  text: string;
}
/** Reviews and checks bound to the current head, summarized next to the merge controls. */
const mergeStatusRows = computed<MergeStatusRow[]>(() => {
  const head = diff.value?.headOid ?? "";
  const latest = new Map<string, Review>();
  for (const review of [...reviews.value].sort((a, b) => a.createdAt - b.createdAt))
    if (review.commitOid === head) latest.set(`${review.actor.kind}:${review.actor.id}`, review);
  const verdicts = [...latest.values()];
  const subject = item.value;
  const author = subject && "headRef" in subject ? subject.actor : null;
  const approvals = verdicts.filter(
    (review) =>
      review.state === "approved" &&
      review.actor.kind === "user" &&
      !(author?.kind === "user" && review.actor.id === author.id)
  ).length;
  const rows: MergeStatusRow[] = [];
  if (verdicts.some((review) => review.state === "changes_requested"))
    rows.push({ key: "reviews", icon: "alert", tone: "danger", text: t("mergeReviewsChanges") });
  else if (approvals)
    rows.push({
      key: "reviews",
      icon: "checkCircle",
      tone: "success",
      text: t("mergeReviewsApproved", { count: approvals }),
    });
  else rows.push({ key: "reviews", icon: "circle", tone: "muted", text: t("mergeReviewsNone") });
  const current = checks.value.filter((check) => check.commitOid === head);
  const pending = current.filter((check) => check.status !== "completed").length;
  const failing = current.filter(
    (check) =>
      check.status === "completed" &&
      (check.conclusion === "failure" || check.conclusion === "cancelled")
  ).length;
  if (!current.length)
    rows.push({ key: "checks", icon: "circle", tone: "muted", text: t("mergeChecksNone") });
  else if (failing)
    rows.push({
      key: "checks",
      icon: "alert",
      tone: "danger",
      text: t("mergeChecksFailing", { count: failing }),
    });
  else if (pending)
    rows.push({
      key: "checks",
      icon: "clock",
      tone: "warning",
      text: t("mergeChecksPending", { count: pending }),
    });
  else
    rows.push({
      key: "checks",
      icon: "checkCircle",
      tone: "success",
      text: t("mergeChecksPassed", { count: current.length }),
    });
  const open = reviewThreads.unresolved.value.length;
  rows.push(
    open
      ? {
          key: "threads",
          icon: "alert",
          tone: "warning",
          text: t("mergeThreadsUnresolved", { count: open }),
        }
      : { key: "threads", icon: "checkCircle", tone: "success", text: t("mergeThreadsResolved") }
  );
  return rows;
});
let loadVersion = 0;

type MarkTone = "success" | "done" | "danger";
interface Mark {
  icon: IconName;
  tone: MarkTone;
}
function stateMark(value: Issue | PullRequest | Discussion): Mark {
  if ("headRef" in value) {
    if (value.state === "merged") return { icon: "gitMerge", tone: "done" };
    return { icon: "pr", tone: value.state === "open" ? "success" : "danger" };
  }
  if ("category" in value)
    return { icon: "discussion", tone: value.state === "open" ? "success" : "done" };
  return value.state === "open"
    ? { icon: "issue", tone: "success" }
    : { icon: "checkCircle", tone: "done" };
}
function reviewMark(state: Review["state"]): { icon: IconName; tone: MarkTone | "muted" } {
  if (state === "approved") return { icon: "checkCircle", tone: "success" };
  if (state === "changes_requested") return { icon: "alert", tone: "danger" };
  return { icon: "discussion", tone: "muted" };
}
function checkMark(check: CheckRun): { icon: IconName; tone: MarkTone | "muted" | "warning" } {
  if (check.status !== "completed") return { icon: "clock", tone: "warning" };
  if (check.conclusion === "success") return { icon: "checkCircle", tone: "success" };
  if (check.conclusion === "neutral") return { icon: "circle", tone: "muted" };
  return { icon: "alert", tone: "danger" };
}
function initial(name: string): string {
  return name.slice(0, 1).toUpperCase();
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
    ? `${value.actor.name}${value.actor.kind === "agent" ? ` · ${t("agent")}` : value.actor.kind === "ci" ? ` · ${t("ciActor")}` : ""}`
    : value.author || value.updatedBy || "";
}
function itemStatus(value: Issue | PullRequest | Discussion | WikiPageSummary): string {
  return "state" in value ? t(value.state) : `r${value.revision}`;
}
function itemCreatedAt(value: Issue | PullRequest | Discussion | WikiPageSummary): number {
  return "createdAt" in value ? value.createdAt : value.updatedAt;
}
const mergePolicyCodes = [
  "changes_requested",
  "approvals_required",
  "checks_incomplete",
  "checks_required",
  "required_checks_missing",
  "threads_unresolved",
  "protected_branch",
  "repository_readonly",
  "merge_method_disabled",
] as const;
function userMessage(cause: unknown): string {
  return errorMessage(cause, t);
}
function mergeFailureMessage(cause: unknown, reloaded: boolean): string {
  if (cause instanceof ApiError) {
    if (reloaded && (cause.code === "merge_changed" || cause.code === "conflict"))
      return t("mergeStateChanged");
    const policyCode = mergePolicyCodes.find((code) => code === cause.code);
    if (policyCode) return t(`mergeError_${policyCode}`);
  }
  return errorMessage(cause, t);
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
  loadError.value = "";
  actionError.value = "";
  actionConflict.value = false;
  viewedRevision.value = null;
  notFound.value = false;
  item.value = null;
  listTruncated.value = false;
  try {
    if (props.section === "issues") {
      if (detailNumber.value) {
        const [detail, rows, links] = await Promise.all([
          api.issue(props.repository.id, detailNumber.value),
          api.comments(props.repository.id, "issues", detailNumber.value),
          api.issueReferences(props.repository.id, detailNumber.value),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        issueLinks.value = links;
        editDraft.value = {
          title: detail.title,
          body: detail.body,
          labels: detail.labels.join(", "),
          draft: false,
        };
        comments.value = rows.items;
        listTruncated.value = rows.truncated;
      } else {
        const page = await api.issues(props.repository.id);
        if (version !== loadVersion) return;
        issues.value = page.items;
        listTruncated.value = page.truncated;
      }
    } else if (props.section === "pulls") {
      if (detailNumber.value) {
        const [detail, rows, reviewRows, checkRows, comparison] = await Promise.all([
          api.pull(props.repository.id, detailNumber.value),
          api.comments(props.repository.id, "pull-requests", detailNumber.value),
          api.reviews(props.repository.id, detailNumber.value),
          api.checks(props.repository.id, detailNumber.value),
          api.pullDiff(props.repository.id, detailNumber.value),
          reviewThreads.load(),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        editDraft.value = {
          title: detail.title,
          body: detail.body,
          labels: "",
          draft: detail.draft,
        };
        comments.value = rows.items;
        listTruncated.value = rows.truncated;
        reviews.value = reviewRows;
        checks.value = checkRows;
        diff.value = comparison;
      } else {
        const [pullRows, sessionRows] = await Promise.all([
          api.pulls(props.repository.id),
          props.repository.canWrite && props.repository.agentsEnabled
            ? api.repositorySessions(props.repository.id)
            : Promise.resolve([]),
        ]);
        if (version !== loadVersion) return;
        pulls.value = pullRows.items;
        listTruncated.value = pullRows.truncated;
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
        comments.value = rows.items;
        listTruncated.value = rows.truncated;
      } else {
        const page = await api.discussions(props.repository.id);
        if (version !== loadVersion) return;
        discussions.value = page.items;
        listTruncated.value = page.truncated;
      }
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
        wikiHistory.value = history.items;
        pages.value = pageRows.items;
        listTruncated.value = history.truncated || pageRows.truncated;
      } else {
        const page = await api.wiki(props.repository.id);
        if (version !== loadVersion) return;
        pages.value = page.items;
        listTruncated.value = page.truncated;
      }
    } else {
      loadError.value = t("unknownSection");
    }
  } catch (cause) {
    if (version !== loadVersion) return;
    if (cause instanceof ApiError && cause.status === 404 && isDetail.value) {
      if (props.section === "issues" && (await pullExists(detailNumber.value))) {
        await router.replace(
          `/${props.repository.owner}/${props.repository.name}/pulls/${detailNumber.value}`
        );
        return;
      }
      notFound.value = true;
    } else loadError.value = userMessage(cause);
  } finally {
    if (version === loadVersion) loading.value = false;
  }
}
/** Issue and pull request numbers share one sequence, so #n links may point at a pull request. */
async function pullExists(number: number): Promise<boolean> {
  try {
    await api.pull(props.repository.id, number);
    return true;
  } catch {
    return false;
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
    draft: false,
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
        draft: form.value.draft,
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
async function runAction(action: () => Promise<void>) {
  saving.value = true;
  actionError.value = "";
  actionConflict.value = false;
  try {
    await action();
  } catch (cause) {
    actionError.value = userMessage(cause);
    actionConflict.value = cause instanceof ApiError && cause.code === "conflict";
    await nextTick();
    actionNotice.value?.scrollIntoView({ block: "nearest" });
  } finally {
    saving.value = false;
  }
}
function labelList(value: string): string[] {
  return value
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}
function saveItem() {
  if (!detailNumber.value) return Promise.resolve();
  const number = detailNumber.value;
  return runAction(async () => {
    if (props.section === "issues")
      item.value = await api.updateIssue(props.repository.id, number, {
        title: editDraft.value.title,
        body: editDraft.value.body,
        ...(props.repository.canWrite ? { labels: labelList(editDraft.value.labels) } : {}),
      });
    else if (props.section === "pulls")
      item.value = await api.updatePullRequest(props.repository.id, number, {
        title: editDraft.value.title,
        body: editDraft.value.body,
        draft: editDraft.value.draft,
      });
    else if (props.section === "discussions")
      item.value = await api.updateDiscussion(props.repository.id, number, {
        title: editDraft.value.title,
        body: editDraft.value.body,
      });
    editMode.value = false;
  });
}
function updateState(state: "open" | "closed") {
  if (!detailNumber.value) return Promise.resolve();
  const number = detailNumber.value;
  return runAction(async () => {
    if (props.section === "issues")
      item.value = await api.updateIssue(props.repository.id, number, { state });
    else if (props.section === "pulls")
      item.value = await api.updatePullRequest(props.repository.id, number, { state });
    else item.value = await api.updateDiscussion(props.repository.id, number, { state });
  });
}
function postComment() {
  if (!detailNumber.value || !commentBody.value.trim()) return Promise.resolve();
  const number = detailNumber.value;
  return runAction(async () => {
    if (editCommentId.value)
      await api.updateComment(
        props.repository.id,
        resource.value,
        number,
        editCommentId.value,
        commentBody.value
      );
    else await api.createComment(props.repository.id, resource.value, number, commentBody.value);
    commentBody.value = "";
    editCommentId.value = "";
    const page = await api.comments(props.repository.id, resource.value, number);
    comments.value = page.items;
    listTruncated.value = page.truncated;
  });
}
function startEditComment(comment: Comment) {
  editCommentId.value = comment.id;
  commentBody.value = comment.body;
}
function removeComment(comment: Comment) {
  return runAction(async () => {
    await api.deleteComment(props.repository.id, resource.value, detailNumber.value, comment.id);
    comments.value = comments.value.filter((row) => row.id !== comment.id);
    if (discussionItem.value?.answerCommentId === comment.id)
      item.value = await api.discussion(props.repository.id, detailNumber.value);
  });
}
function saveWiki() {
  const current = item.value;
  if (!current || !("revision" in current)) return Promise.resolve();
  return runAction(async () => {
    item.value = await api.updateWikiPage(props.repository.id, wikiSlug.value, {
      ...wikiDraft.value,
      expectedRevision: current.revision,
    });
    wikiEditing.value = false;
    await load();
  });
}
function restoreWiki(summary: WikiPageSummary) {
  const current = item.value;
  if (!current || !("revision" in current)) return Promise.resolve();
  return runAction(async () => {
    item.value = await api.restoreWikiRevision(
      props.repository.id,
      wikiSlug.value,
      summary.revision,
      current.revision
    );
    await load();
  });
}
function viewRevision(summary: WikiPageSummary) {
  if (viewedRevision.value?.revision === summary.revision) {
    viewedRevision.value = null;
    return Promise.resolve();
  }
  return runAction(async () => {
    viewedRevision.value = await api.wikiRevision(
      props.repository.id,
      wikiSlug.value,
      summary.revision
    );
  });
}
function addReview() {
  if (!detailNumber.value || !diff.value) return Promise.resolve();
  const number = detailNumber.value;
  const headOid = diff.value.headOid;
  return runAction(async () => {
    await api.createReview(props.repository.id, number, {
      commitOid: headOid,
      state: reviewForm.value.state,
      body: reviewForm.value.body,
    });
    reviews.value = await api.reviews(props.repository.id, number);
    await reviewThreads.load();
    reviewForm.value.body = "";
  });
}
async function finishReview() {
  detailTab.value = "conversation";
  await nextTick();
  document.getElementById("review-panel")?.scrollIntoView({ block: "center" });
  document.querySelector<HTMLElement>("#review-panel select, #review-panel textarea")?.focus();
}
async function showThread(rootId: string) {
  await nextTick();
  const target = document.getElementById(`review-thread-${rootId}`);
  if (target) target.scrollIntoView({ block: "center" });
  else {
    detailTab.value = "conversation";
    await nextTick();
    document.getElementById(`review-thread-${rootId}`)?.scrollIntoView({ block: "center" });
  }
}
function addCheck() {
  if (!detailNumber.value) return Promise.resolve();
  const number = detailNumber.value;
  return runAction(async () => {
    await api.createCheck(props.repository.id, number, {
      ...checkForm.value,
      conclusion: checkForm.value.status === "completed" ? checkForm.value.conclusion : null,
    });
    checks.value = await api.checks(props.repository.id, number);
  });
}
async function mergePull() {
  if (!detailNumber.value || !diff.value) return;
  saving.value = true;
  mergeError.value = "";
  try {
    item.value = await api.mergePull(props.repository.id, detailNumber.value, {
      expectedBaseOid: diff.value.baseOid,
      expectedHeadOid: diff.value.headOid,
      method: mergeMethod.value,
    });
    await load();
  } catch (cause) {
    const reloaded = cause instanceof ApiError && cause.status === 409;
    if (reloaded) await load();
    mergeError.value = mergeFailureMessage(cause, reloaded);
  } finally {
    saving.value = false;
  }
}
function markAnswer(comment: Comment | null) {
  if (!detailNumber.value) return Promise.resolve();
  const number = detailNumber.value;
  return runAction(async () => {
    item.value = await api.updateDiscussion(props.repository.id, number, {
      answerCommentId: comment?.id ?? null,
    });
  });
}
async function loadBranches() {
  try {
    branches.value = await api.repositoryBranches(props.repository.id);
  } catch (cause) {
    formError.value = userMessage(cause);
  }
}
function toggleAnswer(comment: Comment) {
  void markAnswer(discussionItem.value?.answerCommentId === comment.id ? null : comment);
}
function checkStatusLabel(status: CheckRun["status"]): string {
  return t(`actionsStatus_${status === "in_progress" ? "running" : status}`);
}
function checkConclusionLabel(conclusion: CheckRun["conclusion"]): string {
  return conclusion === "neutral"
    ? t("checkNeutral")
    : conclusion
      ? t(`actionsConclusion_${conclusion}`)
      : t("pending");
}
async function focusPullTab(index: number) {
  const tab = pullTabs.value[index];
  if (!tab) return;
  detailTab.value = tab.key;
  await nextTick();
  pullTablist.value?.querySelector<HTMLButtonElement>(`#pull-tab-${tab.key}`)?.focus();
}
function movePullTab(offset: number) {
  const count = pullTabs.value.length;
  const current = pullTabs.value.findIndex((tab) => tab.key === detailTab.value);
  return focusPullTab((current + offset + count) % count);
}
let checkTimer: number | undefined;
let checkPollEpoch = 0;
watch(
  () => [props.repository.id, props.section, detailNumber.value, pullIsOpen.value],
  () => {
    const epoch = ++checkPollEpoch;
    window.clearTimeout(checkTimer);
    if (props.section !== "pulls" || !detailNumber.value || !pullIsOpen.value) return;
    const id = props.repository.id,
      number = detailNumber.value;
    const refreshChecks = async () => {
      try {
        if (!document.hidden) {
          const result = await api.checks(id, number);
          if (epoch === checkPollEpoch) checks.value = result;
        }
      } catch {
        // Preserve the last result while the connection recovers.
      } finally {
        if (epoch === checkPollEpoch) checkTimer = window.setTimeout(refreshChecks, 5000);
      }
    };
    checkTimer = window.setTimeout(refreshChecks, 5000);
  },
  { immediate: true }
);
onUnmounted(() => {
  checkPollEpoch++;
  window.clearTimeout(checkTimer);
});
watch(
  () => [showForm.value, props.section, props.repository.id],
  () => {
    if (showForm.value && props.section === "pulls") void loadBranches();
  }
);
function routeQuery(name: string): string {
  const value = route.query[name];
  return typeof value === "string" ? value : "";
}
watch(
  () => [
    props.section,
    route.query.new,
    route.query.base,
    route.query.head,
    route.query.headSessionId,
  ],
  () => {
    if (props.section !== "pulls" || routeQuery("new") !== "1" || !canCreate.value) return;
    resetForm();
    form.value.baseRef = routeQuery("base") || props.repository.defaultBranch;
    form.value.headRef = routeQuery("head");
    form.value.headSessionId = routeQuery("headSessionId");
    showForm.value = true;
  },
  { immediate: true }
);
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
    <NoticeBar v-if="!loading && !loadError && listTruncated" intent="warning">{{
      t("listTruncated")
    }}</NoticeBar>
    <div v-if="actionError && !loading && !loadError" ref="actionNotice">
      <NoticeBar intent="error"
        >{{ actionError
        }}<template v-if="actionConflict" #actions
          ><FluentButton type="button" size="small" @click="load">{{
            t("reloadLatest")
          }}</FluentButton></template
        ></NoticeBar
      >
    </div>
    <div v-if="loading || loadError || notFound" class="box">
      <StatusState :loading="loading" :error="loadError" :empty="notFound" @retry="load"
        ><template #empty>{{ t("resourceNotFound") }}</template></StatusState
      >
    </div>
    <div v-else-if="!isDetail" class="collab-layout" :class="{ 'has-rail': section === 'issues' }">
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
      <div class="collab-main">
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
          <template v-if="section === 'issues' || section === 'pulls'">
            <CommunityTemplatePicker
              :repository-id="repository.id"
              :ref-name="repository.defaultBranch"
              :kind="section === 'issues' ? 'issue' : 'pull-request'"
              @select="applyCommunityTemplate"
            />
            <p class="muted">{{ t("communityTemplatePreservesDraft") }}</p>
          </template>
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
            <TextField v-if="headBranchFromSession" v-model="form.headRef" required>{{
              t("headBranch")
            }}</TextField>
            <SelectField v-else v-model="form.headRef" :label="t('headBranch')" required>
              <option value="" disabled>{{ t("chooseBranch") }}</option>
              <option v-for="branch in branches" :key="branch.name" :value="branch.name">
                {{ branch.name }}
              </option>
            </SelectField>
            <SelectField v-model="form.baseRef" :label="t('baseBranch')" required>
              <option v-for="branch in branches" :key="branch.name" :value="branch.name">
                {{ branch.name }}
              </option>
            </SelectField>
            <FluentCheckbox id="create-draft" v-model="form.draft">{{
              t("draftPull")
            }}</FluentCheckbox>
            <SelectField
              v-if="repository.agentsEnabled"
              v-model="form.headSessionId"
              :label="t('sessionFork')"
            >
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
        <div class="box list-box">
          <div v-if="section !== 'wiki'" class="box-header list-toolbar">
            <div class="list-filters" role="group" :aria-label="t('filterItems')">
              <button
                v-for="state in ['open', 'closed', 'all'] as const"
                :key="state"
                type="button"
                class="filter-button"
                :aria-pressed="stateFilter === state"
                @click="stateFilter = state"
              >
                <AppIcon
                  :name="state === 'open' ? 'issue' : state === 'closed' ? 'check' : 'filter'"
                />
                {{ t(state === "all" ? "allItems" : state) }}
                <span class="tab-count">{{
                  state === "open" ? openCount : state === "closed" ? closedCount : totalCount
                }}</span>
              </button>
            </div>
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
          <template v-if="section === 'issues'">
            <RouterLink
              v-for="row in filteredIssues"
              :key="row.number"
              class="box-row item-link"
              :to="`/${repository.owner}/${repository.name}/issues/${row.number}`"
              ><AppIcon
                class="state-icon"
                :class="`state-${stateMark(row).tone}`"
                :name="stateMark(row).icon"
              />
              <span class="collab-row-content"
                ><span class="collab-row-title"
                  ><strong>{{ row.title }}</strong
                  ><StatusBadge
                    v-for="label in row.labels"
                    :key="label"
                    :tone="
                      label === 'bug' ? 'danger' : label === 'enhancement' ? 'brand' : 'neutral'
                    "
                    >{{ label }}</StatusBadge
                  ></span
                ><span class="collab-row-meta"
                  >#{{ row.number }} · {{ t("openedBy", { author: actorName(row) }) }} ·
                  {{ d(row.createdAt, "short") }}</span
                ></span
              ></RouterLink
            >
            <div v-if="!issues.length" class="empty-onboarding">
              <AppIcon name="issue" />
              <h3>{{ t("noIssuesTitle") }}</h3>
              <p>{{ t("noIssuesBody") }}</p>
              <button
                v-if="canCreate"
                class="btn btn-primary"
                type="button"
                @click="showForm = true"
              >
                {{ t("createIssue") }}
              </button>
            </div>
            <p v-else-if="!filteredIssues.length" class="state">{{ t("noMatchingItems") }}</p>
          </template>
          <template v-else-if="section === 'pulls'">
            <RouterLink
              v-for="row in filteredPulls"
              :key="row.number"
              class="box-row item-link"
              :to="`/${repository.owner}/${repository.name}/pulls/${row.number}`"
              ><AppIcon
                class="state-icon"
                :class="`state-${stateMark(row).tone}`"
                :name="stateMark(row).icon"
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
              <button
                v-if="canCreate"
                class="btn btn-primary"
                type="button"
                @click="showForm = true"
              >
                {{ t("createPull") }}
              </button>
            </div>
            <p v-else-if="!filteredPulls.length" class="state">{{ t("noMatchingItems") }}</p>
          </template>
          <template v-else-if="section === 'discussions'">
            <RouterLink
              v-for="row in filteredDiscussions"
              :key="row.number"
              class="box-row item-link"
              :to="`/${repository.owner}/${repository.name}/discussions/${row.number}`"
              ><AppIcon
                class="state-icon"
                :class="`state-${stateMark(row).tone}`"
                :name="stateMark(row).icon"
              /><span class="collab-row-content"
                ><span class="collab-row-title"
                  ><strong>{{ row.title }}</strong
                  ><StatusBadge v-if="row.answerCommentId" tone="success">{{
                    t("answered")
                  }}</StatusBadge></span
                ><span class="collab-row-meta"
                  >#{{ row.number }} · {{ actorName(row) }} · {{ t(`category${row.category}`) }} ·
                  {{ d(row.createdAt, "short") }}</span
                ></span
              ></RouterLink
            >
            <div v-if="!discussions.length" class="empty-onboarding">
              <AppIcon name="discussion" />
              <h3>{{ t("noDiscussionsTitle") }}</h3>
              <p>{{ t("noDiscussionsBody") }}</p>
              <button
                v-if="canCreate"
                class="btn btn-primary"
                type="button"
                @click="showForm = true"
              >
                {{ t("createDiscussion") }}
              </button>
            </div>
            <p v-else-if="!filteredDiscussions.length" class="state">
              {{ t("noMatchingItems") }}
            </p>
          </template>
          <template v-else-if="section === 'wiki'">
            <RouterLink
              v-for="page in pages"
              :key="page.slug"
              class="box-row item-link wiki-row"
              :to="`/${repository.owner}/${repository.name}/wiki/${encodeURIComponent(page.slug)}`"
              ><strong>{{ page.title }}</strong
              ><code class="oid">{{ page.slug }}</code
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
          </template>
        </div>
      </div>
    </div>
    <div v-else-if="item" class="collab-detail">
      <AppLink class="back-link" :to="`/${repository.owner}/${repository.name}/${section}`"
        >← {{ t(section === "wiki" ? "wiki" : section) }}</AppLink
      >
      <header class="detail-titlebar">
        <div class="detail-title">
          <h2>
            {{ item.title }}
            <span v-if="detailNumber" class="detail-number">#{{ detailNumber }}</span>
          </h2>
          <div class="detail-state-row">
            <StatusBadge v-if="'state' in item" :tone="stateMark(item).tone"
              ><AppIcon :name="stateMark(item).icon" />{{ itemStatus(item) }}</StatusBadge
            ><StatusBadge v-else>{{ itemStatus(item) }}</StatusBadge>
            <code v-if="'mergedOid' in item && item.mergedOid" class="oid"
              >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</code
            ><span class="muted"
              >{{ t("openedBy", { author: actorName(item) }) }} ·
              {{ d(itemCreatedAt(item), "short") }}</span
            >
          </div>
        </div>
        <div
          v-if="canEditItem && 'state' in item && item.state !== 'merged'"
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
      <div
        v-if="section === 'pulls'"
        ref="pullTablist"
        class="pull-tabs tab-list"
        role="tablist"
        :aria-label="t('pullRequestSections')"
      >
        <button
          v-for="tab in pullTabs"
          :id="`pull-tab-${tab.key}`"
          :key="tab.key"
          class="tab"
          type="button"
          role="tab"
          aria-controls="pull-panel"
          :aria-selected="detailTab === tab.key"
          :tabindex="detailTab === tab.key ? 0 : -1"
          @click="detailTab = tab.key"
          @keydown.left.prevent="movePullTab(-1)"
          @keydown.right.prevent="movePullTab(1)"
          @keydown.home.prevent="focusPullTab(0)"
          @keydown.end.prevent="focusPullTab(pullTabs.length - 1)"
        >
          <AppIcon :name="tab.icon" />{{ tab.label }}
          <span class="tab-count">{{ tab.count }}</span>
        </button>
      </div>
      <div
        id="pull-panel"
        class="detail-layout"
        :class="{ 'has-sidebar': hasSidebar }"
        :role="section === 'pulls' ? 'tabpanel' : undefined"
        :aria-labelledby="section === 'pulls' ? `pull-tab-${detailTab}` : undefined"
      >
        <div class="detail-main">
          <article
            v-if="section !== 'pulls' || detailTab === 'conversation'"
            class="detail-card timeline-entry"
            :class="{ 'is-bare': !('actor' in item) }"
          >
            <span v-if="'actor' in item" class="avatar" aria-hidden="true">{{
              initial(item.actor.name)
            }}</span>
            <div class="box comment-card">
              <header v-if="'actor' in item" class="box-header comment-header">
                <strong>{{ actorName(item) }}</strong>
                <span class="comment-time">{{ d(itemCreatedAt(item), "long") }}</span>
                <StatusBadge v-if="item.actor.kind === 'agent'" tone="brand">{{
                  t("agentAuthored")
                }}</StatusBadge>
              </header>
              <header v-else-if="'author' in item" class="box-header comment-header">
                <strong>{{ item.author }}</strong>
                <span class="comment-time">{{ d(itemCreatedAt(item), "long") }}</span>
              </header>
              <div class="comment-body">
                <form v-if="editMode" class="form-stack item-edit" @submit.prevent="saveItem">
                  <TextField v-model="editDraft.title" required>{{ t("issueTitle") }}</TextField>
                  <TextAreaField v-model="editDraft.body" rows="6" :label="t('issueBody')" />
                  <template v-if="section === 'issues' && repository.canWrite">
                    <TextField v-model="editDraft.labels" :placeholder="t('commaSeparated')">{{
                      t("labels")
                    }}</TextField>
                  </template>
                  <FluentCheckbox
                    v-if="section === 'pulls'"
                    id="edit-draft"
                    v-model="editDraft.draft"
                  >
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
                  :repository="markdownRepository"
                />
                <div
                  v-if="'headRef' in item && (item.headSessionId || item.mergedOid)"
                  class="pull-meta"
                >
                  <StatusBadge v-if="item.headSessionId" tone="brand"
                    >{{ t("sessionFork") }} · {{ item.headSessionId }}</StatusBadge
                  ><StatusBadge v-if="item.mergedOid" tone="done"
                    >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</StatusBadge
                  >
                </div>

                <div v-if="section === 'wiki' && showEditActions" class="wiki-edit-actions">
                  <FluentButton type="button" @click="wikiEditing = !wikiEditing">
                    {{ wikiEditing ? t("cancel") : t("edit") }}
                  </FluentButton>
                  <form v-if="wikiEditing" class="form-stack" @submit.prevent="saveWiki">
                    <TextField v-model="wikiDraft.title" required>{{ t("issueTitle") }}</TextField>
                    <div class="composer-tabs tab-list">
                      <button
                        class="tab"
                        type="button"
                        :aria-pressed="!wikiPreview"
                        @click="wikiPreview = false"
                      >
                        {{ t("write") }}</button
                      ><button
                        class="tab"
                        type="button"
                        :aria-pressed="wikiPreview"
                        @click="wikiPreview = true"
                      >
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
                    ><small>{{ revision.updatedBy }} · {{ d(revision.updatedAt, "long") }}</small
                    ><FluentButton
                      v-if="!isCurrentRevision(revision.revision)"
                      type="button"
                      size="small"
                      :disabled="saving"
                      :aria-pressed="viewedRevision?.revision === revision.revision"
                      @click="viewRevision(revision)"
                    >
                      {{
                        viewedRevision?.revision === revision.revision
                          ? t("hideRevision")
                          : t("viewRevision")
                      }}
                    </FluentButton>
                    <FluentButton
                      v-if="showEditActions"
                      type="button"
                      size="small"
                      :disabled="saving || isCurrentRevision(revision.revision)"
                      @click="restoreWiki(revision)"
                    >
                      {{ t("restoreRevision") }}
                    </FluentButton>
                  </div>
                  <section
                    v-if="viewedRevision"
                    class="wiki-revision-view"
                    :aria-label="t('revisionContent')"
                  >
                    <p class="eyebrow">
                      r{{ viewedRevision.revision }} · {{ viewedRevision.title }}
                    </p>
                    <MarkdownContent class="body-content" :source="viewedRevision.content" />
                    <p class="eyebrow">{{ t("revisionChanges") }}</p>
                    <p v-if="viewedRevisionUnchanged" class="muted">
                      {{ t("revisionNoChanges") }}
                    </p>
                    <DiffViewer
                      v-else
                      :patch="viewedRevisionPatch"
                      :path="`${wikiSlug} r${viewedRevision.revision}`"
                    />
                  </section>
                </div>
              </div>
            </div>
          </article>

          <section v-if="section === 'pulls' && detailTab === 'files' && diff" class="pull-review">
            <div class="box">
              <header class="box-header">
                <h3>{{ t("diff") }}</h3>
                <span class="muted diff-range"
                  >{{ diff.baseOid.slice(0, 8) }}…{{ diff.headOid.slice(0, 8) }} ·
                  {{ diff.commits.length }} {{ t("commits") }}</span
                >
              </header>
              <NoticeBar v-if="diff.truncated" intent="warning">{{
                t("comparisonTruncated")
              }}</NoticeBar>
            </div>
            <NoticeBar v-if="reviewThreads.error.value" intent="error">{{
              reviewThreads.error.value
            }}</NoticeBar>
            <div v-if="reviewThreads.pendingCount.value" class="box pending-review">
              <div class="box-row">
                <AppIcon class="state-icon state-warning" name="alert" />
                <span class="grow">{{
                  t("pendingReviewCount", { count: reviewThreads.pendingCount.value })
                }}</span>
                <FluentButton type="button" size="small" tone="primary" @click="finishReview">
                  {{ t("finishReview") }}
                </FluentButton>
              </div>
            </div>
            <div v-if="reviewThreads.threads.value.length" class="box thread-summary">
              <header class="box-header">
                <h3>
                  {{
                    reviewThreads.unresolved.value.length
                      ? t("unresolvedThreads", { count: reviewThreads.unresolved.value.length })
                      : t("allThreadsResolved")
                  }}
                </h3>
              </header>
              <ul v-if="reviewThreads.unresolved.value.length" class="thread-summary-list">
                <li
                  v-for="thread in reviewThreads.unresolved.value"
                  :key="thread.root.id"
                  class="box-row"
                >
                  <FluentButton
                    type="button"
                    tone="subtle"
                    size="small"
                    @click="showThread(thread.root.id)"
                  >
                    <code>{{ thread.root.path }}:{{ thread.root.line }}</code>
                  </FluentButton>
                  <StatusBadge v-if="thread.root.outdated" tone="warning">{{
                    t("threadOutdated")
                  }}</StatusBadge>
                  <span class="muted thread-excerpt">{{ thread.root.body.slice(0, 120) }}</span>
                </li>
              </ul>
            </div>
            <div v-for="change in diff.files" :key="change.path" class="box changed-file">
              <header class="box-header file-header">
                <code>{{ change.type }} · {{ change.path }}</code>
              </header>
              <DiffViewer
                v-if="change.patch"
                :patch="change.patch"
                :path="change.path"
                :review="fileReviewContext(change.path)"
                @create="reviewThreads.createThread"
                @reply="(root, body) => reviewThreads.reply(root, body, false)"
                @edit="reviewThreads.edit"
                @remove="reviewThreads.remove"
                @resolve="reviewThreads.setResolved"
              />
              <p v-else class="muted file-note">
                {{ change.binary ? t("binaryPreviewUnavailable") : t("diffTooLarge") }}
              </p>
            </div>
            <div v-if="showEditActions && pullIsOpen" class="box merge-box">
              <header class="box-header">
                <h3>{{ t("mergeBoxTitle") }}</h3>
              </header>
              <ul class="merge-status">
                <li v-for="row in mergeStatusRows" :key="row.key" class="box-row">
                  <AppIcon class="state-icon" :class="`state-${row.tone}`" :name="row.icon" />
                  <span>{{ row.text }}</span>
                </li>
              </ul>
              <div class="merge-actions">
                <SelectField v-model="mergeMethod" :label="t('repoMergeMethod')">
                  <option v-if="repository.allowMergeCommit" value="merge">
                    {{ t("repoMergeMethodMerge") }}
                  </option>
                  <option v-if="repository.allowSquashMerge" value="squash">
                    {{ t("repoMergeMethodSquash") }}
                  </option>
                  <option v-if="repository.allowRebaseMerge" value="rebase">
                    {{ t("repoMergeMethodRebase") }}
                  </option>
                </SelectField>
                <FluentButton
                  type="button"
                  tone="primary"
                  :disabled="
                    saving ||
                    !diff.headOid ||
                    (!repository.allowMergeCommit &&
                      !repository.allowSquashMerge &&
                      !repository.allowRebaseMerge)
                  "
                  @click="mergePull"
                >
                  {{ t("mergePull") }}</FluentButton
                >
                <div class="merge-hints muted">
                  <p>{{ t("mergeUsesCurrentHeads") }}</p>
                  <p>{{ t("repoMergePolicyHint") }}</p>
                </div>
                <NoticeBar v-if="mergeError" intent="error">{{ mergeError }}</NoticeBar>
              </div>
            </div>
          </section>

          <section
            v-if="section === 'pulls' && detailTab === 'conversation'"
            class="box review-threads-panel"
          >
            <header class="box-header">
              <h3>{{ t("reviewThreads") }}</h3>
            </header>
            <NoticeBar v-if="reviewThreads.truncated.value" intent="warning">{{
              t("reviewThreadsTruncated")
            }}</NoticeBar>
            <div
              v-for="thread in reviewThreads.threads.value"
              :key="thread.root.id"
              class="box-row"
            >
              <ReviewThread
                class="grow"
                :thread="thread"
                :viewer-key="reviewContext.viewerKey"
                :can-comment="reviewContext.canComment"
                :can-moderate="reviewContext.canModerate"
                :is-pull-author="reviewContext.isPullAuthor"
                :busy="reviewThreads.busy.value"
                show-context
                @reply="(root, body) => reviewThreads.reply(root, body, false)"
                @edit="reviewThreads.edit"
                @remove="reviewThreads.remove"
                @resolve="reviewThreads.setResolved"
              />
            </div>
            <p v-if="!reviewThreads.threads.value.length" class="box-row muted">
              {{ t("reviewThreadsEmpty") }}
            </p>
          </section>

          <section
            v-if="section === 'pulls' && detailTab === 'conversation'"
            id="review-panel"
            class="box review-panel"
          >
            <header class="box-header">
              <h3>{{ t("reviews") }}</h3>
            </header>
            <div v-for="review in reviews" :key="review.id" class="box-row review-row">
              <AppIcon
                class="state-icon"
                :class="`state-${reviewMark(review.state).tone}`"
                :name="reviewMark(review.state).icon"
              />
              <div class="grow">
                <div class="row-line">
                  <strong>{{ t(`review${review.state}`) }}</strong
                  ><StatusBadge :tone="review.actor.kind === 'agent' ? 'brand' : 'neutral'"
                    ><AppIcon
                      v-if="String(review.actor.kind) === 'ci'"
                      name="checkCircle"
                      :size="12"
                    />{{ actorName(review) }}</StatusBadge
                  ><code class="oid">{{ review.commitOid.slice(0, 8) }}</code
                  ><StatusBadge v-if="review.commitOid !== diff?.headOid" tone="warning">{{
                    t("outdatedReview")
                  }}</StatusBadge>
                </div>
                <p v-if="review.body" class="row-note">{{ review.body }}</p>
              </div>
            </div>
            <p v-if="!reviews.length" class="box-row muted">{{ t("reviewsEmpty") }}</p>
            <form
              v-if="canCreate && pullIsOpen"
              class="box-form form-stack review-form"
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
                :hint="
                  reviewThreads.pendingCount.value
                    ? t('pendingIncluded', { count: reviewThreads.pendingCount.value })
                    : undefined
                "
              />
              <div class="form-actions">
                <FluentButton type="submit" :disabled="saving">{{
                  t("submitReview")
                }}</FluentButton>
              </div>
            </form>
          </section>
          <section v-if="section === 'pulls' && detailTab === 'checks'" class="box checks-panel">
            <header class="box-header">
              <h3>{{ t("checks") }}</h3>
            </header>
            <div v-for="check in checks" :key="check.id" class="box-row check-row">
              <AppIcon
                class="state-icon"
                :class="`state-${checkMark(check).tone}`"
                :name="checkMark(check).icon"
              />
              <div class="grow">
                <div class="row-line">
                  <strong>{{ check.name }}</strong
                  ><StatusBadge :tone="check.conclusion === 'success' ? 'success' : 'neutral'"
                    >{{ checkStatusLabel(check.status) }} ·
                    {{ checkConclusionLabel(check.conclusion) }}</StatusBadge
                  ><StatusBadge :tone="check.actor.kind === 'agent' ? 'brand' : 'neutral'"
                    ><AppIcon
                      v-if="String(check.actor.kind) === 'ci'"
                      name="checkCircle"
                      :size="12"
                    />{{ actorName(check) }}</StatusBadge
                  ><code class="oid">{{ check.commitOid.slice(0, 8) }}</code
                  ><StatusBadge v-if="check.commitOid !== diff?.headOid" tone="warning">{{
                    t("outdatedCheck")
                  }}</StatusBadge>
                </div>
                <p v-if="check.summary" class="row-note">{{ check.summary }}</p>
                <a
                  v-if="check.detailsUrl"
                  class="row-note"
                  :href="check.detailsUrl"
                  target="_blank"
                  rel="noreferrer"
                  >{{ t("details") }}</a
                >
              </div>
            </div>
            <p v-if="!checks.length" class="box-row muted">{{ t("checksEmpty") }}</p>
            <form
              v-if="repository.canWrite && pullIsOpen"
              class="box-form form-stack check-form"
              @submit.prevent="addCheck"
            >
              <TextField v-model="checkForm.name" required>{{ t("checkName") }}</TextField>
              <TextField v-model="checkForm.commitOid" required>{{ t("commitOid") }}</TextField>
              <SelectField
                :model-value="checkForm.status"
                :label="t('checkStatus')"
                @update:model-value="checkForm.status = oneOf(checkStatuses, $event, 'completed')"
              >
                <option v-for="status in checkStatuses" :key="status" :value="status">
                  {{ checkStatusLabel(status) }}
                </option>
              </SelectField>
              <SelectField
                v-if="checkForm.status === 'completed'"
                :model-value="checkForm.conclusion"
                :label="t('checkConclusion')"
                @update:model-value="
                  checkForm.conclusion = oneOf(checkConclusions, $event, 'success')
                "
              >
                <option
                  v-for="conclusion in checkConclusions"
                  :key="conclusion"
                  :value="conclusion"
                >
                  {{ checkConclusionLabel(conclusion) }}
                </option>
              </SelectField>
              <TextAreaField
                v-model="checkForm.summary"
                :placeholder="t('summary')"
                rows="2"
                :label="t('summary')"
              />
              <div class="form-actions">
                <FluentButton type="submit" :disabled="saving">{{ t("addCheck") }}</FluentButton>
              </div>
            </form>
          </section>
          <section
            v-if="section === 'discussions' && discussionItem?.answerCommentId"
            class="box answer-panel"
          >
            <header class="box-header">
              <AppIcon class="state-success" name="checkCircle" />
              <h3>{{ t("acceptedAnswer") }}</h3>
              <FluentButton
                v-if="showEditActions"
                class="header-action"
                type="button"
                size="small"
                :disabled="saving"
                @click="markAnswer(null)"
              >
                {{ t("clearAnswer") }}
              </FluentButton>
            </header>
            <p class="comment-body">
              {{
                comments.find((comment) => comment.id === discussionItem?.answerCommentId)?.body ||
                t("answerMarked")
              }}
            </p>
          </section>
          <section
            v-if="section !== 'wiki' && (section !== 'pulls' || detailTab === 'conversation')"
            class="comments-panel"
          >
            <h3 class="visually-hidden">{{ t("comments") }}</h3>
            <div class="timeline">
              <template v-for="(comment, commentIndex) in comments" :key="comment.id">
                <p
                  v-for="event in issueEventsBefore(commentIndex)"
                  :key="event.id"
                  class="timeline-event muted"
                >
                  <AppIcon name="gitMerge" :size="14" />
                  {{
                    t("closedByPullRequest", {
                      name: event.actor.name,
                      number: event.pullRequestNumber,
                    })
                  }}
                  · {{ d(event.createdAt, "long") }}
                </p>
                <article class="comment-row timeline-entry">
                  <span class="avatar" aria-hidden="true">{{ initial(comment.actor.name) }}</span>
                  <div class="box comment-card">
                    <header class="box-header comment-header">
                      <strong>{{ actorName(comment) }}</strong
                      ><StatusBadge v-if="comment.actor.kind === 'agent'" tone="brand">{{
                        t("agentAuthored")
                      }}</StatusBadge
                      ><span class="comment-time">{{ d(comment.createdAt, "long") }}</span>
                      <span class="comment-actions"
                        ><FluentButton
                          v-if="canModifyComment(comment)"
                          type="button"
                          tone="subtle"
                          size="small"
                          @click="startEditComment(comment)"
                        >
                          {{ t("edit") }}</FluentButton
                        ><FluentButton
                          v-if="canModifyComment(comment)"
                          type="button"
                          tone="subtle"
                          size="small"
                          :disabled="saving"
                          @click="removeComment(comment)"
                        >
                          {{ t("delete") }}</FluentButton
                        ><FluentButton
                          v-if="section === 'discussions' && showEditActions"
                          type="button"
                          tone="subtle"
                          size="small"
                          :disabled="saving"
                          @click="toggleAnswer(comment)"
                        >
                          {{
                            discussionItem?.answerCommentId === comment.id
                              ? t("clearAnswer")
                              : t("markAnswer")
                          }}
                        </FluentButton></span
                      >
                    </header>
                    <div class="comment-body">
                      <MarkdownContent
                        class="body-content"
                        :source="comment.body"
                        :repository="markdownRepository"
                      />
                    </div>
                  </div>
                </article>
              </template>
              <p v-for="event in trailingIssueEvents" :key="event.id" class="timeline-event muted">
                <AppIcon name="gitMerge" :size="14" />
                {{
                  t("closedByPullRequest", {
                    name: event.actor.name,
                    number: event.pullRequestNumber,
                  })
                }}
                · {{ d(event.createdAt, "long") }}
              </p>
              <form v-if="canCreate" class="timeline-entry composer" @submit.prevent="postComment">
                <span class="avatar" aria-hidden="true">{{
                  initial(sessionState.user?.identifier ?? "")
                }}</span>
                <div class="box comment-card">
                  <div class="composer-tabs tab-list">
                    <button
                      class="tab"
                      type="button"
                      :aria-pressed="!commentPreview"
                      @click="commentPreview = false"
                    >
                      {{ t("write") }}</button
                    ><button
                      class="tab"
                      type="button"
                      :aria-pressed="commentPreview"
                      @click="commentPreview = true"
                    >
                      {{ t("preview") }}
                    </button>
                  </div>
                  <div class="comment-body form-stack">
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
                  </div>
                </div>
              </form>
              <p v-else class="muted">{{ t("signInToComment") }}</p>
            </div>
          </section>
        </div>
        <aside
          v-if="hasSidebar && section !== 'wiki'"
          class="detail-sidebar"
          :aria-label="t('details')"
        >
          <section v-if="'labels' in item" class="sidebar-section">
            <h3>{{ t("labels") }}</h3>
            <div v-if="item.labels.length" class="sidebar-tags">
              <StatusBadge v-for="label in item.labels" :key="label">{{ label }}</StatusBadge>
            </div>
            <p v-else class="muted">{{ t("noLabels") }}</p>
          </section>
          <section v-if="section === 'issues' && issueLinks" class="sidebar-section">
            <h3>{{ t("linkedPullRequests") }}</h3>
            <ul v-if="issueLinks.pullRequests.length" class="linked-pulls">
              <li v-for="pull in issueLinks.pullRequests" :key="pull.number">
                <RouterLink :to="`/${repository.owner}/${repository.name}/pulls/${pull.number}`"
                  >#{{ pull.number }} {{ pull.title }}</RouterLink
                >
                <small class="muted"
                  >{{ t(pull.state) }} ·
                  {{ pull.closes ? t("linkCloses") : t("linkMentions") }}</small
                >
              </li>
            </ul>
            <p v-else class="muted">{{ t("linkedPullRequestsEmpty") }}</p>
            <p v-if="issueLinks.truncated" class="muted">{{ t("linkedPullRequestsTruncated") }}</p>
          </section>
          <AssignmentPanel
            v-if="(section === 'issues' || section === 'pulls') && 'assignees' in item"
            class="sidebar-section"
            :repository="repository"
            :kind="section === 'issues' ? 'issue' : 'pull_request'"
            :item="item"
            @updated="item = $event"
          />
          <section class="sidebar-section">
            <h3>{{ t("author") }}</h3>
            <p class="sidebar-person">
              <span class="avatar avatar-sm" aria-hidden="true">{{ initial(actorName(item)) }}</span
              >{{ actorName(item) }}
            </p>
          </section>
          <section v-if="'headRef' in item" class="sidebar-section">
            <h3>{{ t("branches") }}</h3>
            <p class="sidebar-branches">
              <code class="oid">{{ item.headRef }}</code
              ><span class="muted">→</span><code class="oid">{{ item.baseRef }}</code>
            </p>
          </section>
        </aside>
        <aside v-else-if="section === 'wiki'" class="detail-sidebar wiki-sidebar">
          <section class="sidebar-section">
            <h3>{{ t("pages") }}</h3>
            <nav :aria-label="t('pages')">
              <RouterLink
                v-for="page in pages"
                :key="page.slug"
                :to="`/${repository.owner}/${repository.name}/wiki/${encodeURIComponent(page.slug)}`"
                :aria-current="page.slug === wikiSlug ? 'page' : undefined"
                >{{ page.title }}</RouterLink
              >
            </nav>
            <button
              v-if="repository.canWrite"
              class="btn btn-sm"
              type="button"
              @click="startWikiPage"
            >
              {{ t("createWiki") }}
            </button>
          </section>
        </aside>
      </div>
    </div>
  </section>
</template>

<style>
@import "../styles/collaboration.css";
</style>
