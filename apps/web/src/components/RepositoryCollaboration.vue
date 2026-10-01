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
import FormActions from "./FormActions.vue";
import StatusState from "./StatusState.vue";

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
const editDraft = ref({ title: "", body: "", labels: "", assignees: "", draft: false });
const saving = ref(false);
const formError = ref("");
const form = ref<{
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  labels: string;
  assignees: string;
  category: Discussion["category"];
  slug: string;
  headSessionId: string;
}>({
  title: "",
  body: "",
  headRef: "",
  baseRef: props.repository.defaultBranch,
  labels: "",
  assignees: "",
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
          assignees: detail.assignees.join(", "),
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
          assignees: "",
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
          assignees: "",
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
    assignees: "",
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
        assignees: form.value.assignees
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
        assignees: editDraft.value.assignees
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
    <div v-if="loading || error || notFound" class="content-card">
      <StatusState :loading="loading" :error="error" :empty="notFound" @retry="load"
        ><template #empty>{{ t("resourceNotFound") }}</template></StatusState
      >
    </div>
    <template v-else-if="!isDetail">
      <div class="section-actions">
        <button
          v-if="canCreate && (section !== 'wiki' || repository.canWrite)"
          class="btn primary"
          @click="showForm = !showForm"
        >
          +
          {{
            section === "issues"
              ? t("createIssue")
              : section === "pulls"
                ? t("createPull")
                : section === "discussions"
                  ? t("createDiscussion")
                  : t("createWiki")
          }}
        </button>
      </div>
      <form v-if="showForm" class="content-card create-form" @submit.prevent="submitCreate">
        <label>{{ t("issueTitle") }}<input v-model="form.title" required /></label>
        <label
          >{{ section === "wiki" ? t("slug") : t("issueBody")
          }}<input v-if="section === 'wiki'" v-model="form.slug" required /><textarea
            v-model="form.body"
            rows="5"
          />
        </label>
        <template v-if="section === 'issues'"
          ><label
            >{{ t("labels")
            }}<input v-model="form.labels" :placeholder="t('commaSeparated')" /></label
          ><label
            >{{ t("assignees")
            }}<input v-model="form.assignees" :placeholder="t('commaSeparated')" /></label
        ></template>
        <template v-if="section === 'pulls'"
          ><label>{{ t("headBranch") }}<input v-model="form.headRef" required /></label
          ><label>{{ t("baseBranch") }}<input v-model="form.baseRef" required /></label
          ><label
            >{{ t("sessionFork")
            }}<select v-model="form.headSessionId">
              <option value="">{{ t("noSessionFork") }}</option>
              <option
                v-for="session in agentSessions.filter((value) => value.status === 'active')"
                :key="session.id"
                :value="session.id"
              >
                {{ session.agentName }} / {{ session.workspaceName }}
              </option>
            </select></label
          ></template
        >
        <label v-if="section === 'discussions'"
          >{{ t("category")
          }}<select v-model="form.category">
            <option value="general">{{ t("categoryGeneral") }}</option>
            <option value="ideas">{{ t("categoryIdeas") }}</option>
            <option value="q-and-a">{{ t("categoryQa") }}</option>
            <option value="announcements">{{ t("categoryAnnouncements") }}</option>
          </select></label
        >
        <FormActions :saving="saving" :error="formError" @cancel="showForm = false" />
      </form>
      <div v-if="section === 'issues'" class="content-card">
        <RouterLink
          v-for="row in issues"
          :key="row.number"
          class="item-row item-link"
          :to="`/${repository.owner}/${repository.name}/issues/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><span class="pill" :class="row.state">{{ t(row.state) }}</span
          ><small>{{ actorName(row) }}</small
          ><span v-for="label in row.labels" :key="label" class="pill">{{
            label
          }}</span></RouterLink
        >
        <p v-if="!issues.length" class="empty-inline">{{ t("empty") }}</p>
        <p v-if="issues.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
      <div v-else-if="section === 'pulls'" class="content-card">
        <RouterLink
          v-for="row in pulls"
          :key="row.number"
          class="item-row item-link"
          :to="`/${repository.owner}/${repository.name}/pulls/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><span class="pill" :class="row.state">{{ t(row.state) }}</span
          ><small>{{ row.headRef }} → {{ row.baseRef }}</small
          ><span v-if="row.headSessionId" class="pill agent-badge">{{
            t("agentSession")
          }}</span></RouterLink
        >
        <p v-if="!pulls.length" class="empty-inline">{{ t("empty") }}</p>
        <p v-if="pulls.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
      <div v-else-if="section === 'discussions'" class="content-card">
        <RouterLink
          v-for="row in discussions"
          :key="row.number"
          class="item-row item-link"
          :to="`/${repository.owner}/${repository.name}/discussions/${row.number}`"
          ><span class="number">#{{ row.number }}</span
          ><strong>{{ row.title }}</strong
          ><span class="pill">{{ t(`category${row.category}`) }}</span
          ><span class="pill" :class="row.state">{{ t(row.state) }}</span
          ><small>{{ actorName(row) }}</small
          ><span v-if="row.answerCommentId" class="pill open">{{ t("answered") }}</span></RouterLink
        >
        <p v-if="!discussions.length" class="empty-inline">{{ t("empty") }}</p>
        <p v-if="discussions.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
      <div v-else-if="section === 'wiki'" class="content-card">
        <RouterLink
          v-for="page in pages"
          :key="page.slug"
          class="item-row item-link"
          :to="`/${repository.owner}/${repository.name}/wiki/${encodeURIComponent(page.slug)}`"
          ><strong>{{ page.title }}</strong
          ><code>{{ page.slug }}</code
          ><small>r{{ page.revision }} · {{ page.updatedBy }}</small></RouterLink
        >
        <p v-if="!pages.length" class="empty-inline">{{ t("empty") }}</p>
        <p v-if="pages.length >= 100" class="list-limit-note">{{ t("listLimited") }}</p>
      </div>
    </template>
    <template v-else-if="item">
      <RouterLink class="back-link" :to="`/${repository.owner}/${repository.name}/${section}`"
        >← {{ t(section === "wiki" ? "wiki" : section) }}</RouterLink
      >
      <article class="content-card detail-card">
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
            <button class="btn" @click="editMode = !editMode">
              {{ editMode ? t("cancel") : t("edit") }}</button
            ><button
              v-if="'state' in item && item.state === 'closed'"
              class="btn"
              :disabled="saving"
              @click="updateState('open')"
            >
              {{ t("reopen") }}</button
            ><button
              v-if="'state' in item && item.state === 'open'"
              class="btn"
              :disabled="saving"
              @click="updateState('closed')"
            >
              {{ t("closeIssue") }}
            </button>
          </div>
        </div>
        <div v-if="'actor' in item" class="actor-line">
          {{ actorName(item) }} · {{ new Date(itemCreatedAt(item)).toLocaleString()
          }}<span v-if="item.actor.kind === 'agent'" class="pill agent-badge">{{
            t("agentAuthored")
          }}</span>
        </div>
        <p v-else-if="'author' in item" class="actor-line">
          {{ item.author }} · {{ new Date(itemCreatedAt(item)).toLocaleString() }}
        </p>
        <form v-if="editMode" class="inline-form item-edit" @submit.prevent="saveItem">
          <input v-model="editDraft.title" required /><textarea
            v-model="editDraft.body"
            rows="6"
          /><template v-if="section === 'issues'"
            ><label
              >{{ t("labels")
              }}<input v-model="editDraft.labels" :placeholder="t('commaSeparated')" /></label
            ><label
              >{{ t("assignees")
              }}<input
                v-model="editDraft.assignees"
                :placeholder="t('commaSeparated')" /></label></template
          ><label v-if="section === 'pulls'" class="checkbox-line"
            ><input v-model="editDraft.draft" type="checkbox" />{{ t("draftPull") }}</label
          ><button class="btn primary" :disabled="saving">{{ t("save") }}</button>
        </form>
        <pre v-else class="body-content">{{ "content" in item ? item.content : item.body }}</pre>
        <div v-if="'labels' in item" class="metadata-row">
          <span v-for="label in item.labels" :key="label" class="pill">{{ label }}</span
          ><span v-for="assignee in item.assignees" :key="assignee" class="pill"
            >{{ t("assignee") }}: {{ assignee }}</span
          >
        </div>
        <div v-if="'headRef' in item" class="pull-meta">
          <span>{{ item.headRef }} → {{ item.baseRef }}</span
          ><span v-if="item.headSessionId" class="pill agent-badge"
            >{{ t("sessionFork") }} · {{ item.headSessionId }}</span
          ><span v-if="'mergedOid' in item && item.mergedOid" class="pill open"
            >{{ t("mergedCommit") }} {{ item.mergedOid.slice(0, 8) }}</span
          >
        </div>
        <div v-if="section === 'wiki' && showEditActions" class="wiki-edit-actions">
          <button class="btn" @click="wikiEditing = !wikiEditing">
            {{ wikiEditing ? t("cancel") : t("edit") }}
          </button>
          <form v-if="wikiEditing" class="inline-form" @submit.prevent="saveWiki">
            <input v-model="wikiDraft.title" required /><textarea
              v-model="wikiDraft.content"
              rows="8"
            /><button class="btn primary" :disabled="saving">{{ t("save") }}</button>
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
            ><button
              v-if="showEditActions"
              class="btn"
              :disabled="saving || isCurrentRevision(revision.revision)"
              @click="restoreWiki(revision)"
            >
              {{ t("restoreRevision") }}
            </button>
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
            <button class="btn primary" :disabled="saving || !diff.headOid" @click="mergePull">
              {{ t("mergePull") }}</button
            ><span class="muted">{{ t("mergeUsesCurrentHeads") }}</span>
          </div>
        </div>
      </article>
      <section v-if="section === 'pulls'" class="content-card review-panel">
        <p class="eyebrow">{{ t("reviews") }}</p>
        <div v-for="review in reviews" :key="review.id" class="item-row">
          <strong>{{ t(`review${review.state}`) }}</strong
          ><span class="pill" :class="review.actor.kind === 'agent' ? 'agent-badge' : ''">{{
            actorName(review)
          }}</span
          ><code>{{ review.commitOid.slice(0, 8) }}</code
          ><span v-if="review.commitOid !== diff?.headOid" class="pill stale-check">{{
            t("outdatedReview")
          }}</span>
          <p>{{ review.body }}</p>
        </div>
        <form v-if="canCreate && pullIsOpen" class="inline-form" @submit.prevent="addReview">
          <select v-model="reviewForm.state">
            <option value="commented">{{ t("reviewcommented") }}</option>
            <option value="approved">{{ t("reviewapproved") }}</option>
            <option value="changes_requested">{{ t("reviewchanges_requested") }}</option></select
          ><textarea v-model="reviewForm.body" :placeholder="t('reviewBody')" rows="2" /><button
            class="btn"
            type="submit"
          >
            {{ t("submitReview") }}
          </button>
        </form>
      </section>
      <section v-if="section === 'pulls'" class="content-card checks-panel">
        <p class="eyebrow">{{ t("checks") }}</p>
        <div v-for="check in checks" :key="check.id" class="item-row">
          <strong>{{ check.name }}</strong
          ><span class="pill" :class="check.conclusion === 'success' ? 'open' : ''"
            >{{ check.status }} · {{ check.conclusion || t("pending") }}</span
          ><span class="pill" :class="check.actor.kind === 'agent' ? 'agent-badge' : ''">{{
            actorName(check)
          }}</span
          ><code>{{ check.commitOid.slice(0, 8) }}</code
          ><span v-if="check.commitOid !== diff?.headOid" class="pill stale-check">{{
            t("outdatedCheck")
          }}</span>
          <p>{{ check.summary }}</p>
          <a v-if="check.detailsUrl" :href="check.detailsUrl" target="_blank" rel="noreferrer">{{
            t("details")
          }}</a>
        </div>
        <form
          v-if="repository.canWrite && pullIsOpen"
          class="inline-form"
          @submit.prevent="addCheck"
        >
          <input v-model="checkForm.name" :placeholder="t('checkName')" required /><input
            v-model="checkForm.commitOid"
            :placeholder="t('commitOid')"
            required
          /><select v-model="checkForm.status">
            <option value="queued">queued</option>
            <option value="in_progress">in_progress</option>
            <option value="completed">completed</option></select
          ><select v-if="checkForm.status === 'completed'" v-model="checkForm.conclusion">
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="neutral">neutral</option>
            <option value="cancelled">cancelled</option></select
          ><textarea v-model="checkForm.summary" :placeholder="t('summary')" rows="2" /><button
            class="btn"
            type="submit"
          >
            {{ t("addCheck") }}
          </button>
        </form>
      </section>
      <section v-if="section === 'discussions'" class="content-card answer-panel">
        <div v-if="discussionItem">
          <p class="eyebrow">{{ t("acceptedAnswer") }}</p>
          <p v-if="discussionItem?.answerCommentId">
            {{
              comments.find((comment) => comment.id === discussionItem?.answerCommentId)?.body ||
              t("answerMarked")
            }}
          </p>
          <button v-if="showEditActions" class="btn" @click="markAnswer(null)">
            {{ t("clearAnswer") }}
          </button>
        </div>
      </section>
      <section v-if="section !== 'wiki'" class="content-card comments-panel">
        <p class="eyebrow">{{ t("comments") }}</p>
        <article v-for="comment in comments" :key="comment.id" class="comment-row">
          <div class="actor-line">
            <strong>{{ actorName(comment) }}</strong
            ><span class="pill agent-badge" v-if="comment.actor.kind === 'agent'">{{
              t("agentAuthored")
            }}</span
            ><small>{{ new Date(comment.createdAt).toLocaleString() }}</small
            ><button v-if="showEditActions" class="text-button" @click="startEditComment(comment)">
              {{ t("edit") }}</button
            ><button v-if="showEditActions" class="text-button" @click="removeComment(comment)">
              {{ t("delete") }}</button
            ><button
              v-if="section === 'discussions' && showEditActions"
              class="text-button"
              @click="markAnswer(comment)"
            >
              {{ t("markAnswer") }}
            </button>
          </div>
          <pre class="body-content">{{ comment.body }}</pre>
        </article>
        <form v-if="canCreate" class="inline-form" @submit.prevent="postComment">
          <textarea
            v-model="commentBody"
            :placeholder="t('writeComment')"
            rows="4"
            required
          /><button class="btn primary" type="submit" :disabled="saving">
            {{ editCommentId ? t("save") : t("comment") }}
          </button>
        </form>
        <p v-else class="muted">{{ t("signInToComment") }}</p>
      </section>
    </template>
  </section>
</template>

<style scoped>
.collab-section {
  display: grid;
  gap: 18px;
}
.section-actions {
  display: flex;
  justify-content: flex-end;
}
.content-card {
  border-radius: 6px;
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 18px;
  min-width: 0;
}
.item-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-height: 48px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--line);
}
.item-link {
  text-decoration: none;
}
.item-link:hover strong {
  color: var(--accent);
}
.item-row small,
.actor-line,
.muted {
  color: var(--muted);
}
.item-row small {
  margin-left: auto;
}
.number,
code {
  color: var(--link);
  font-family: "IBM Plex Mono", monospace;
  font-size: 12px;
}
.pill {
  border: 1px solid var(--line);
  border-radius: 99px;
  padding: 2px 7px;
  color: var(--muted);
  font: 10px "IBM Plex Mono";
}
.pill.open {
  color: var(--ok);
  border-color: var(--ok);
}
.pill.agent-badge {
  color: var(--link);
  border-color: var(--line);
}
.pill.stale-check {
  color: var(--link);
  border-color: var(--link);
}
.empty-inline {
  padding: 28px;
  text-align: center;
  color: var(--muted);
}
.list-limit-note {
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}
.create-form,
.inline-form {
  display: grid;
  gap: 12px;
}
.create-form label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.create-form input,
.create-form textarea,
.create-form select,
.inline-form input,
.inline-form textarea,
.inline-form select {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--line);
  color: inherit;
  background: var(--subtle);
  font: inherit;
}
.detail-card {
  margin-top: 16px;
}
.detail-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
}
.detail-heading h2 {
  margin: 0 0 16px;
  font-size: 30px;
}
.detail-actions {
  display: flex;
  gap: 8px;
}
.actor-line {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}
.body-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
  font: 14px/1.7 inherit;
  margin: 18px 0;
}
.metadata-row,
.pull-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 0;
}
.wiki-history,
.wiki-edit-actions,
.pull-review,
.review-panel,
.checks-panel,
.answer-panel,
.comments-panel {
  margin-top: 18px;
}
.changed-file {
  border-top: 1px solid var(--line);
  padding: 12px 0;
}
.diff-preview {
  max-height: 420px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--text);
  background: var(--subtle);
  padding: 12px;
  font:
    12px/1.6 "IBM Plex Mono",
    monospace;
}
.merge-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 10px;
}
.comment-row {
  border-bottom: 1px solid var(--line);
  padding: 12px 0;
}
.comment-row .actor-line small {
  margin-left: auto;
}
.inline-form {
  margin-top: 14px;
}
.item-edit label {
  display: grid;
  gap: 6px;
  color: var(--muted);
}
.checkbox-line {
  display: flex !important;
  align-items: center;
}
.checkbox-line input {
  width: auto !important;
}
@media (max-width: 640px) {
  .detail-heading {
    display: block;
  }
  .detail-actions {
    margin-bottom: 12px;
  }
}
</style>
