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
import { eventChecked, oneOf } from "../ui/formEvents";
import AppIcon from "./AppIcon.vue";
import AppLink from "./AppLink.vue";
import FormActions from "./FormActions.vue";
import SelectField from "./SelectField.vue";
import StatusBadge from "./StatusBadge.vue";
import StatusState from "./StatusState.vue";
import TextField from "./TextField.vue";
import TextAreaField from "./TextAreaField.vue";

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
const canCreate = computed(() => Boolean(sessionState.user));
const showEditActions = computed(() => props.repository.canWrite);
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
function actorName(value: { actor?: { kind: string; name: string }; author?: string }): string {
  return value.actor
    ? `${value.actor.name}${value.actor.kind === "agent" ? ` · ${t("agent")}` : ""}`
    : value.author || "";
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
  void router.push(
    `/${props.repository.owner}/${props.repository.name}/${props.section}/${number}`
  );
}
function goToWiki(slug: string) {
  void router.push(
    `/${props.repository.owner}/${props.repository.name}/wiki/${encodeURIComponent(slug)}`
  );
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
        const [detail, history] = await Promise.all([
          api.wikiPage(props.repository.id, wikiSlug.value),
          api.wikiHistory(props.repository.id, wikiSlug.value),
        ]);
        if (version !== loadVersion) return;
        item.value = detail;
        wikiDraft.value = { title: detail.title, content: detail.content };
        wikiEditing.value = false;
        wikiHistory.value = history;
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
      goTo(created.number);
    } else if (props.section === "pulls") {
      const created = await api.createPullRequest(props.repository.id, {
        title: form.value.title,
        body: form.value.body,
        headRef: form.value.headRef,
        baseRef: form.value.baseRef,
        headSessionId: form.value.headSessionId || null,
      });
      goTo(created.number);
    } else if (props.section === "discussions") {
      const created = await api.createDiscussion(props.repository.id, {
        title: form.value.title,
        body: form.value.body,
        category: form.value.category,
      });
      goTo(created.number);
    } else {
      const created = await api.updateWikiPage(props.repository.id, form.value.slug, {
        title: form.value.title,
        content: form.value.body,
      });
      goToWiki(created.slug);
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
      <div class="section-actions">
        <fluent-button
          v-if="canCreate && (section !== 'wiki' || repository.canWrite)"
          type="button"
          appearance="primary"
          @click="showForm = !showForm"
        >
          <AppIcon slot="start" name="plus" />
          {{
            section === "issues"
              ? t("createIssue")
              : section === "pulls"
                ? t("createPull")
                : section === "discussions"
                  ? t("createDiscussion")
                  : t("createWiki")
          }}
        </fluent-button>
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
            <fluent-option value="">{{ t("noSessionFork") }}</fluent-option>
            <fluent-option
              v-for="session in agentSessions.filter((value) => value.status === 'active')"
              :key="session.id"
              :value="session.id"
            >
              {{ session.agentName }} / {{ session.workspaceName }}
            </fluent-option>
          </SelectField>
        </template>
        <SelectField
          v-if="section === 'discussions'"
          :model-value="form.category"
          :label="t('category')"
          @update:model-value="form.category = oneOf(discussionCategories, $event, 'general')"
        >
          <fluent-option value="general">{{ t("categoryGeneral") }}</fluent-option>
          <fluent-option value="ideas">{{ t("categoryIdeas") }}</fluent-option>
          <fluent-option value="q-and-a">{{ t("categoryQa") }}</fluent-option>
          <fluent-option value="announcements">{{ t("categoryAnnouncements") }}</fluent-option>
        </SelectField>
        <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
      </form>
      <div v-if="section === 'issues'" class="box">
        <RouterLink
          v-for="row in issues"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/issues/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><StatusBadge :tone="stateTone(row.state)">{{ t(row.state) }}</StatusBadge
          ><small>{{ actorName(row) }}</small
          ><StatusBadge v-for="label in row.labels" :key="label">{{
            label
          }}</StatusBadge></RouterLink
        >
        <p v-if="!issues.length" class="state">{{ t("empty") }}</p>
        <p v-if="issues.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
      <div v-else-if="section === 'pulls'" class="box">
        <RouterLink
          v-for="row in pulls"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/pulls/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><StatusBadge :tone="stateTone(row.state)">{{ t(row.state) }}</StatusBadge
          ><small>{{ row.headRef }} → {{ row.baseRef }}</small
          ><StatusBadge v-if="row.headSessionId" tone="brand">{{
            t("agentSession")
          }}</StatusBadge></RouterLink
        >
        <p v-if="!pulls.length" class="state">{{ t("empty") }}</p>
        <p v-if="pulls.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
      <div v-else-if="section === 'discussions'" class="box">
        <RouterLink
          v-for="row in discussions"
          :key="row.number"
          class="box-row item-link"
          :to="`/${repository.owner}/${repository.name}/discussions/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><StatusBadge>{{ t(`category${row.category}`) }}</StatusBadge
          ><StatusBadge :tone="stateTone(row.state)">{{ t(row.state) }}</StatusBadge
          ><small>{{ actorName(row) }}</small
          ><StatusBadge v-if="row.answerCommentId" tone="success">{{
            t("answered")
          }}</StatusBadge></RouterLink
        >
        <p v-if="!discussions.length" class="state">{{ t("empty") }}</p>
        <p v-if="discussions.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
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
        <p v-if="!pages.length" class="state">{{ t("empty") }}</p>
        <p v-if="pages.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
    </template>
    <template v-else-if="item">
      <AppLink class="back-link" :to="`/${repository.owner}/${repository.name}/${section}`"
        >← {{ t(section === "wiki" ? "wiki" : section) }}</AppLink
      >
      <article class="box box-form detail-card">
        <div class="detail-heading">
          <div>
            <p class="eyebrow">
              {{ section === "wiki" ? t("wiki") : `#${detailNumber}` }} · {{ itemStatus(item) }}
            </p>
            <h2>{{ "title" in item ? item.title : "" }}</h2>
          </div>
          <div
            v-if="showEditActions && 'state' in item && item.state !== 'merged'"
            class="detail-actions"
          >
            <fluent-button type="button" @click="editMode = !editMode">
              {{ editMode ? t("cancel") : t("edit") }}</fluent-button
            ><fluent-button
              v-if="'state' in item && item.state === 'closed'"
              type="button"
              :disabled="saving"
              @click="updateState('open')"
            >
              {{ t("reopen") }}</fluent-button
            ><fluent-button
              v-if="'state' in item && item.state === 'open'"
              type="button"
              :disabled="saving"
              @click="updateState('closed')"
            >
              {{ t("closeIssue") }}
            </fluent-button>
          </div>
        </div>
        <div v-if="'actor' in item" class="actor-line">
          {{ actorName(item) }} · {{ new Date(itemCreatedAt(item)).toLocaleString()
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
          <fluent-field v-if="section === 'pulls'" label-position="after">
            <label slot="label" for="edit-draft">{{ t("draftPull") }}</label>
            <fluent-checkbox
              id="edit-draft"
              slot="input"
              :checked="editDraft.draft"
              @change="editDraft.draft = eventChecked($event)"
            />
          </fluent-field>
          <div class="form-actions">
            <fluent-button type="submit" appearance="primary" :disabled="saving">{{
              t("save")
            }}</fluent-button>
          </div>
        </form>
        <pre v-else class="body-content">{{ "content" in item ? item.content : item.body }}</pre>
        <div v-if="'labels' in item" class="metadata-row">
          <StatusBadge v-for="label in item.labels" :key="label">{{ label }}</StatusBadge
          ><StatusBadge v-for="assignee in item.assignees" :key="`${assignee.kind}:${assignee.id}`"
            >{{ t("assignee") }}: {{ assignee.name }}</StatusBadge
          >
        </div>
        <div v-if="'headRef' in item" class="pull-meta">
          <span>{{ item.headRef }} → {{ item.baseRef }}</span
          ><StatusBadge v-if="item.headSessionId" tone="brand"
            >{{ t("sessionFork") }} · {{ item.headSessionId }}</StatusBadge
          ><StatusBadge v-if="'mergedOid' in item && item.mergedOid" tone="success"
            >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</StatusBadge
          >
        </div>
        <div v-if="section === 'wiki' && showEditActions" class="wiki-edit-actions">
          <fluent-button type="button" @click="wikiEditing = !wikiEditing">
            {{ wikiEditing ? t("cancel") : t("edit") }}
          </fluent-button>
          <form v-if="wikiEditing" class="form-stack inline-form" @submit.prevent="saveWiki">
            <TextField v-model="wikiDraft.title" required>{{ t("issueTitle") }}</TextField>
            <TextAreaField v-model="wikiDraft.content" rows="8" :label="t('issueBody')" />
            <div class="form-actions">
              <fluent-button type="submit" appearance="primary" :disabled="saving">{{
                t("save")
              }}</fluent-button>
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
            ><fluent-button
              v-if="showEditActions"
              type="button"
              size="small"
              :disabled="saving || isCurrentRevision(revision.revision)"
              @click="restoreWiki(revision)"
            >
              {{ t("restoreRevision") }}
            </fluent-button>
          </div>
        </div>
        <div v-if="section === 'pulls' && diff" class="pull-review">
          <p class="eyebrow">{{ t("diff") }}</p>
          <p class="muted">
            {{ diff.baseOid.slice(0, 8) }}…{{ diff.headOid.slice(0, 8) }} ·
            {{ diff.commits.length }} {{ t("commits") }}
          </p>
          <div v-for="change in diff.files" :key="change.path" class="changed-file">
            <strong>{{ change.type }} · {{ change.path }}</strong>
            <pre v-if="change.patch" class="diff-preview">{{ change.patch }}</pre>
            <span v-else class="muted">{{ t("binaryPreviewUnavailable") }}</span>
          </div>
          <div v-if="showEditActions && pullIsOpen" class="merge-actions">
            <fluent-button
              type="button"
              appearance="primary"
              :disabled="saving || !diff.headOid"
              @click="mergePull"
            >
              {{ t("mergePull") }}</fluent-button
            ><span class="muted">{{ t("mergeUsesCurrentHeads") }}</span>
          </div>
        </div>
      </article>
      <section v-if="section === 'pulls'" class="box box-form review-panel">
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
            <fluent-option value="commented">{{ t("reviewcommented") }}</fluent-option>
            <fluent-option value="approved">{{ t("reviewapproved") }}</fluent-option>
            <fluent-option value="changes_requested">{{
              t("reviewchanges_requested")
            }}</fluent-option>
          </SelectField>
          <TextAreaField
            v-model="reviewForm.body"
            :placeholder="t('reviewBody')"
            rows="2"
            :label="t('reviewBody')"
          />
          <div class="form-actions">
            <fluent-button type="submit">{{ t("submitReview") }}</fluent-button>
          </div>
        </form>
      </section>
      <section v-if="section === 'pulls'" class="box box-form checks-panel">
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
          <fluent-link
            v-if="check.detailsUrl"
            :href="check.detailsUrl"
            target="_blank"
            rel="noreferrer"
            >{{ t("details") }}</fluent-link
          >
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
            <fluent-option value="queued">queued</fluent-option>
            <fluent-option value="in_progress">in_progress</fluent-option>
            <fluent-option value="completed">completed</fluent-option>
          </SelectField>
          <SelectField
            v-if="checkForm.status === 'completed'"
            :model-value="checkForm.conclusion"
            :label="t('checkConclusion')"
            @update:model-value="checkForm.conclusion = oneOf(checkConclusions, $event, 'success')"
          >
            <fluent-option value="success">success</fluent-option>
            <fluent-option value="failure">failure</fluent-option>
            <fluent-option value="neutral">neutral</fluent-option>
            <fluent-option value="cancelled">cancelled</fluent-option>
          </SelectField>
          <TextAreaField
            v-model="checkForm.summary"
            :placeholder="t('summary')"
            rows="2"
            :label="t('summary')"
          />
          <div class="form-actions">
            <fluent-button type="submit">{{ t("addCheck") }}</fluent-button>
          </div>
        </form>
      </section>
      <section v-if="section === 'discussions'" class="box box-form answer-panel">
        <div v-if="discussionItem">
          <p class="eyebrow">{{ t("acceptedAnswer") }}</p>
          <p v-if="discussionItem?.answerCommentId">
            {{
              comments.find((comment) => comment.id === discussionItem?.answerCommentId)?.body ||
              t("answerMarked")
            }}
          </p>
          <fluent-button v-if="showEditActions" type="button" @click="markAnswer(null)">
            {{ t("clearAnswer") }}
          </fluent-button>
        </div>
      </section>
      <section v-if="section !== 'wiki'" class="box box-form comments-panel">
        <p class="eyebrow">{{ t("comments") }}</p>
        <article v-for="comment in comments" :key="comment.id" class="comment-row">
          <div class="actor-line">
            <strong>{{ actorName(comment) }}</strong
            ><StatusBadge v-if="comment.actor.kind === 'agent'" tone="brand">{{
              t("agentAuthored")
            }}</StatusBadge
            ><small>{{ new Date(comment.createdAt).toLocaleString() }}</small
            ><fluent-button
              v-if="showEditActions"
              type="button"
              appearance="transparent"
              size="small"
              @click="startEditComment(comment)"
            >
              {{ t("edit") }}</fluent-button
            ><fluent-button
              v-if="showEditActions"
              type="button"
              appearance="transparent"
              size="small"
              @click="removeComment(comment)"
            >
              {{ t("delete") }}</fluent-button
            ><fluent-button
              v-if="section === 'discussions' && showEditActions"
              type="button"
              appearance="transparent"
              size="small"
              @click="markAnswer(comment)"
            >
              {{ t("markAnswer") }}
            </fluent-button>
          </div>
          <pre class="body-content">{{ comment.body }}</pre>
        </article>
        <form v-if="canCreate" class="form-stack inline-form" @submit.prevent="postComment">
          <TextAreaField
            v-model="commentBody"
            :placeholder="t('writeComment')"
            rows="4"
            required
            :label="t('writeComment')"
          />
          <div class="form-actions">
            <fluent-button type="submit" appearance="primary" :disabled="saving">
              {{ editCommentId ? t("save") : t("comment") }}
            </fluent-button>
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
