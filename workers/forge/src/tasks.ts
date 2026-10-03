import { agentEvent } from "./agent-events";
import { z } from "zod";
import {
  AGENT_MODE_VERSION,
  AgentAssignmentPolicySchema,
  AssignTaskInputSchema,
  AttachTaskLinkInputSchema,
  BindTaskCommitInputSchema,
  CreateTaskInputSchema,
  GitOidSchema,
  MemoryVisibilitySchema,
  MoveTaskLinkInputSchema,
  PutMemoryIndexInputSchema,
  PutTaskDocumentInputSchema,
  RevisionActorSchema,
  SYSTEM_ACTOR,
  TASK_STATUS_LABELS,
  TaskDocumentKindSchema,
  TaskLinkKindSchema,
  TaskStatusSchema,
  UpdateRepositorySettingsInputSchema,
  UpdateTaskInputSchema,
  type Actor,
  type Assignee,
  type MemoryIndex,
  type RepositorySettings,
  type RevisionActor,
  type Task,
  type TaskCommit,
  type TaskCommitSource,
  type TaskDetail,
  type TaskDocument,
  type TaskDocumentKind,
  type TaskLink,
  type TaskLinkKind,
  type TaskReference,
  type TaskStatus,
  type TaskTable,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { actorForUser, trustedHeaders } from "../../../packages/contracts/src/trust";
import { createLogger } from "../../../src/worker/common/logger";
import { assigneeCandidates, resolveAssignable } from "./assignments";
import {
  error,
  json,
  nextNumber,
  parseActor,
  parseJson,
  type ForgeEnv,
  type RepositoryRow,
} from "./common";

/** Who is asking; anonymous public readers have no user and no membership. */
export type Viewer = {
  readonly user: TrustedUser | null;
  readonly member: boolean;
  readonly writeAllowed: boolean;
  /** True for the namespace owner acting as a human (never an agent session). */
  readonly isOwner: () => Promise<boolean>;
};

type TaskRow = {
  id: string;
  number: number;
  type: string;
  title: string;
  motivation: string;
  description: string;
  status: TaskStatus;
  assignee_kind: "user" | "agent" | null;
  assignee_id: string | null;
  assignee_name: string | null;
  actor_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  link_total: number;
  link_done: number;
  commit_count: number;
};
type DocumentRow = {
  kind: TaskDocumentKind;
  content: string;
  revision: number;
  actor_json: string;
  updated_at: number;
};
type MemoryRow = {
  content: string;
  guideline_version: string;
  revision: number;
  actor_json: string;
  updated_at: number;
};
type CommitRow = {
  oid: string;
  ref: string;
  summary: string;
  author_name: string;
  bound_by_json: string;
  source: TaskCommitSource;
  bound_at: number;
};
type LinkRow = {
  kind: TaskLinkKind;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  created_at: number;
};
type HistoryRow = { revision: number; actor_json: string; size: number; updated_at: number };

/** Subset of the Git service commit response the forge needs to snapshot a binding. */
const GitCommitResponseSchema = z.object({
  data: z.object({
    oid: GitOidSchema,
    message: z.string(),
    author: z.object({ name: z.string() }),
  }),
});

const TASK_DOCUMENT_KINDS = TaskDocumentKindSchema.options;
const LINK_TABLES: Record<TaskLinkKind, "forge_issues" | "forge_pull_requests"> = {
  issue: "forge_issues",
  pull_request: "forge_pull_requests",
};

const TASK_SELECT = `SELECT t.id, t.number, t.type, t.title, t.motivation, t.description, t.status, t.assignee_kind, t.assignee_id, COALESCE(u.identifier, g.name, t.assignee_id) AS assignee_name, t.actor_json, t.created_by, t.created_at, t.updated_at,
  (SELECT COUNT(*) FROM forge_task_links l WHERE l.task_id = t.id) AS link_total,
  (SELECT COUNT(*) FROM forge_task_links l LEFT JOIN forge_issues i ON l.target_kind = 'issue' AND i.id = l.target_id LEFT JOIN forge_pull_requests p ON l.target_kind = 'pull_request' AND p.id = l.target_id WHERE l.task_id = t.id AND (i.state = 'closed' OR p.state IN ('closed', 'merged'))) AS link_done,
  (SELECT COUNT(*) FROM forge_task_commits c WHERE c.task_id = t.id) AS commit_count
  FROM forge_tasks t LEFT JOIN users u ON t.assignee_kind = 'user' AND u.id = t.assignee_id LEFT JOIN auth_agents g ON t.assignee_kind = 'agent' AND g.id = t.assignee_id`;

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRevisionActor(value: string): RevisionActor {
  try {
    const parsed = RevisionActorSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {
    /* unreadable audit data is reported as a platform entry */
  }
  return SYSTEM_ACTOR;
}

function presentTask(row: TaskRow): Task {
  const assignee: Assignee | null =
    row.assignee_kind && row.assignee_id
      ? { kind: row.assignee_kind, id: row.assignee_id, name: row.assignee_name ?? row.assignee_id }
      : null;
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    title: row.title,
    motivation: row.motivation,
    description: row.description,
    status: row.status,
    assignee,
    actor: parseActor(row.actor_json, row.created_by),
    progress: {
      total: row.link_total,
      done: row.link_done,
      percent: row.link_total ? Math.round((row.link_done / row.link_total) * 100) : null,
    },
    commitCount: row.commit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentDocument(row: DocumentRow): TaskDocument {
  return {
    kind: row.kind,
    content: row.content,
    revision: row.revision,
    actor: parseRevisionActor(row.actor_json),
    updatedAt: row.updated_at,
  };
}

function presentMemory(row: MemoryRow | null): MemoryIndex {
  return row
    ? {
        content: row.content,
        guidelineVersion: row.guideline_version,
        revision: row.revision,
        actor: parseRevisionActor(row.actor_json),
        updatedAt: row.updated_at,
      }
    : {
        content: "",
        guidelineVersion: AGENT_MODE_VERSION,
        revision: 0,
        actor: null,
        updatedAt: null,
      };
}

function presentCommit(row: CommitRow): TaskCommit {
  return {
    oid: row.oid,
    ref: row.ref,
    summary: row.summary,
    author: row.author_name,
    boundBy: parseRevisionActor(row.bound_by_json),
    source: row.source,
    boundAt: row.bound_at,
  };
}

async function repositorySettings(
  env: ForgeEnv,
  repositoryId: string
): Promise<Omit<RepositorySettings, "canManage">> {
  const row = await env.DB.prepare(
    "SELECT slug, description, visibility, default_branch, archived, issues_enabled, pulls_enabled, discussions_enabled, wiki_enabled, required_approvals, require_passing_checks, tasks_enabled, agents_enabled, deployments_enabled, graph_enabled, actions_enabled, actions_network_enabled, online_editing_enabled, allow_merge_commit, allow_squash_merge, allow_rebase_merge, delete_branch_on_merge, memory_visibility, agent_assignment_policy FROM repositories WHERE id = ?"
  )
    .bind(repositoryId)
    .first<{
      slug: string;
      description: string;
      visibility: "public" | "private";
      default_branch: string;
      archived: number;
      issues_enabled: number;
      pulls_enabled: number;
      discussions_enabled: number;
      wiki_enabled: number;
      tasks_enabled: number;
      agents_enabled: number;
      deployments_enabled: number;
      graph_enabled: number;
      actions_enabled: number;
      actions_network_enabled: number;
      online_editing_enabled: number;
      allow_merge_commit: number;
      allow_squash_merge: number;
      allow_rebase_merge: number;
      delete_branch_on_merge: number;
      required_approvals: number;
      require_passing_checks: number;
      memory_visibility: string;
      agent_assignment_policy: string;
    }>();
  return {
    name: row?.slug ?? "",
    slug: row?.slug ?? "",
    description: row?.description ?? "",
    visibility: row?.visibility ?? "private",
    defaultBranch: row?.default_branch ?? "main",
    archived: row?.archived === 1,
    issuesEnabled: row?.issues_enabled !== 0,
    pullsEnabled: row?.pulls_enabled !== 0,
    discussionsEnabled: row?.discussions_enabled !== 0,
    wikiEnabled: row?.wiki_enabled !== 0,
    tasksEnabled: row?.tasks_enabled !== 0,
    agentsEnabled: row?.agents_enabled !== 0,
    deploymentsEnabled: row?.deployments_enabled !== 0,
    graphEnabled: row?.graph_enabled !== 0,
    actionsEnabled: row?.actions_enabled === 1,
    actionsNetworkEnabled: row?.actions_network_enabled === 1,
    onlineEditingEnabled: row?.online_editing_enabled !== 0,
    allowMergeCommit: row?.allow_merge_commit !== 0,
    allowSquashMerge: row?.allow_squash_merge !== 0,
    allowRebaseMerge: row?.allow_rebase_merge !== 0,
    deleteBranchOnMerge: row?.delete_branch_on_merge === 1,
    requiredApprovals: row?.required_approvals ?? 0,
    requirePassingChecks: row?.require_passing_checks === 1,
    memoryVisibility: MemoryVisibilitySchema.catch("members").parse(row?.memory_visibility),
    agentAssignmentPolicy: AgentAssignmentPolicySchema.catch("owner").parse(
      row?.agent_assignment_policy
    ),
  };
}

type ProgressTarget =
  { readonly taskId: string } | { readonly targetKind: TaskLinkKind; readonly targetId: string };

/**
 * Statements that append one platform-authored entry to a task's progress document and record
 * it as a new revision. The append happens in SQL so it never needs an optimistic revision, and
 * both statements are guarded so they only apply when the preceding batch statement changed a row.
 */
export function systemProgressStatements(
  env: ForgeEnv,
  target: ProgressTarget,
  text: string,
  now: number,
  guardedByPreviousStatement: boolean
): D1PreparedStatement[] {
  const taskClause =
    "taskId" in target
      ? "task_id = ?"
      : "task_id = (SELECT task_id FROM forge_task_links WHERE target_kind = ? AND target_id = ?)";
  const targetBinds = "taskId" in target ? [target.taskId] : [target.targetKind, target.targetId];
  const entry = `- ${new Date(now).toISOString()} [system] ${text}\n`;
  const guard = guardedByPreviousStatement ? " AND changes() = 1" : "";
  return [
    env.DB.prepare(
      `UPDATE forge_task_documents SET content = content || CASE WHEN content = '' OR substr(content, -1) = char(10) THEN '' ELSE char(10) END || ?, revision = revision + 1, updated_by = NULL, actor_json = ?, updated_at = ? WHERE kind = 'progress' AND ${taskClause}${guard}`
    ).bind(entry, JSON.stringify(SYSTEM_ACTOR), now, ...targetBinds),
    env.DB.prepare(
      `INSERT INTO forge_task_document_revisions (task_id, kind, revision, content, updated_by, actor_json, updated_at) SELECT task_id, kind, revision, content, NULL, actor_json, updated_at FROM forge_task_documents WHERE kind = 'progress' AND ${taskClause} AND changes() = 1`
    ).bind(...targetBinds),
  ];
}

/** Progress entry for an issue or pull request whose state just changed (guarded by that update). */
export function targetStateProgressStatements(
  env: ForgeEnv,
  targetKind: TaskLinkKind,
  targetId: string,
  text: string,
  now: number
): D1PreparedStatement[] {
  return systemProgressStatements(env, { targetKind, targetId }, text, now, true);
}

export type MergedPullRequest = {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly number: number;
  readonly oid: string;
  readonly baseRef: string;
  readonly summary: string;
  readonly author: string;
  readonly actor: Actor;
  readonly now: number;
};

/**
 * Statements appended to the pull request merge batch right after the merge UPDATE: record a
 * system progress entry (guarded by that UPDATE changing a row), then bind the merge commit to
 * the task the pull request is linked to. Both are no-ops for pull requests without a task or
 * whose merge record did not land. The progress entry comes first so an already bound commit
 * (a fast-forward merge of a head the task tracked) cannot suppress it. The binding stores the
 * pull request title and merger as summary and author; it does not re-read the Git commit.
 */
export function mergeBindingStatements(
  env: ForgeEnv,
  merge: MergedPullRequest
): D1PreparedStatement[] {
  return [
    ...targetStateProgressStatements(
      env,
      "pull_request",
      merge.pullRequestId,
      `Pull request #${merge.number} merged as ${merge.oid.slice(0, 7)} into ${merge.baseRef}`,
      merge.now
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO forge_task_commits (id, repository_id, task_id, oid, ref, summary, author_name, bound_by_json, source, bound_at) SELECT ?, l.repository_id, l.task_id, p.merged_oid, ?, ?, ?, ?, 'pull_request_merge', ? FROM forge_task_links l JOIN forge_pull_requests p ON p.id = l.target_id WHERE l.target_kind = 'pull_request' AND l.target_id = ? AND p.state = 'merged' AND p.merged_oid = ?"
    ).bind(
      crypto.randomUUID(),
      merge.baseRef,
      merge.summary,
      merge.author,
      JSON.stringify(merge.actor),
      merge.now,
      merge.pullRequestId,
      merge.oid
    ),
  ];
}

function markdownCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

async function taskTable(env: ForgeEnv, repository: RepositoryRow): Promise<TaskTable> {
  const [tasks, memory] = await Promise.all([
    env.DB.prepare(
      "SELECT number, type, title, motivation, description, status FROM forge_tasks WHERE repository_id = ? ORDER BY number ASC"
    )
      .bind(repository.id)
      .all<Pick<TaskRow, "number" | "type" | "title" | "motivation" | "description" | "status">>(),
    env.DB.prepare("SELECT guideline_version FROM forge_memory_index WHERE repository_id = ?")
      .bind(repository.id)
      .first<{ guideline_version: string }>(),
  ]);
  const guidelineVersion = memory?.guideline_version ?? AGENT_MODE_VERSION;
  const rows = tasks.results.map(
    (task) =>
      `| ${String(task.number).padStart(3, "0")} | [${task.type}] ${markdownCell(task.title)} | ${markdownCell(task.description)} | ${markdownCell(task.motivation)} | ${TASK_STATUS_LABELS[task.status]} |`
  );
  const markdown = [
    `# ${repository.slug} 任务追踪`,
    `> 准则版本: ${guidelineVersion}`,
    "## 任务列表",
    "| 编号 | 任务名称 | 任务描述 | 变更动机 | 状态 |",
    "| :--: | :------: | :------: | :------: | :--: |",
    ...rows,
  ].join("\n");
  return { markdown: `${markdown}\n`, guidelineVersion };
}

async function readMemory(env: ForgeEnv, repositoryId: string): Promise<MemoryRow | null> {
  return env.DB.prepare(
    "SELECT content, guideline_version, revision, actor_json, updated_at FROM forge_memory_index WHERE repository_id = ?"
  )
    .bind(repositoryId)
    .first<MemoryRow>();
}

async function memoryRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  viewer: Viewer,
  rest: string[]
): Promise<Response | null> {
  const [, item, action] = rest;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  if (request.method === "GET" && !item)
    return json({ data: presentMemory(await readMemory(env, repository.id)) });
  if (request.method === "GET" && item === "history" && !action) {
    const rows = await env.DB.prepare(
      "SELECT revision, actor_json, length(content) AS size, updated_at FROM forge_memory_index_revisions WHERE repository_id = ? ORDER BY revision DESC"
    )
      .bind(repository.id)
      .all<HistoryRow>();
    return json({ data: rows.results.map(presentHistory) });
  }
  if (request.method === "GET" && item === "revisions" && action) {
    const revision = positiveInteger(action);
    const row = revision
      ? await env.DB.prepare(
          "SELECT content, guideline_version, revision, actor_json, updated_at FROM forge_memory_index_revisions WHERE repository_id = ? AND revision = ?"
        )
          .bind(repository.id, revision)
          .first<MemoryRow>()
      : null;
    return row
      ? json({ data: presentMemory(row) })
      : error(404, "not_found", "Memory revision was not found.");
  }
  if (request.method !== "PUT" || item || !viewer.user) return null;

  const parsed = PutMemoryIndexInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid memory index payload.");
  const actor = actorForUser(viewer.user);
  const actorJson = JSON.stringify(actor);
  const now = Date.now();
  const { content, expectedRevision } = parsed.data;
  const inserted = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO forge_memory_index (repository_id, content, guideline_version, revision, updated_by, actor_json, updated_at) SELECT ?, ?, ?, 1, ?, ?, ? WHERE ? = 0 ON CONFLICT(repository_id) DO NOTHING"
    ).bind(
      repository.id,
      content,
      parsed.data.guidelineVersion ?? AGENT_MODE_VERSION,
      viewer.user.id,
      actorJson,
      now,
      expectedRevision
    ),
    env.DB.prepare(
      "INSERT INTO forge_memory_index_revisions (repository_id, revision, content, guideline_version, updated_by, actor_json, updated_at) SELECT repository_id, revision, content, guideline_version, updated_by, actor_json, updated_at FROM forge_memory_index WHERE repository_id = ? AND revision = 1 AND changes() = 1"
    ).bind(repository.id),
  ]);
  const created = inserted[0].meta.changes === 1;
  if (!created) {
    const updated = await env.DB.batch([
      env.DB.prepare(
        "UPDATE forge_memory_index SET content = ?, guideline_version = COALESCE(?, guideline_version), revision = revision + 1, updated_by = ?, actor_json = ?, updated_at = ? WHERE repository_id = ? AND revision = ?"
      ).bind(
        content,
        parsed.data.guidelineVersion ?? null,
        viewer.user.id,
        actorJson,
        now,
        repository.id,
        expectedRevision
      ),
      env.DB.prepare(
        "INSERT INTO forge_memory_index_revisions (repository_id, revision, content, guideline_version, updated_by, actor_json, updated_at) SELECT repository_id, revision, content, guideline_version, updated_by, actor_json, updated_at FROM forge_memory_index WHERE repository_id = ? AND revision = ? AND changes() = 1"
      ).bind(repository.id, expectedRevision + 1),
    ]);
    if (updated[0].meta.changes !== 1) {
      logger.warn("forge:memory-index-conflict", {
        repositoryId: repository.id,
        expectedRevision,
      });
      return error(409, "conflict", "Memory index revision has changed.");
    }
  }
  logger.info("forge:memory-index-saved", {
    repositoryId: repository.id,
    revision: expectedRevision + 1,
    actorKind: actor.kind,
  });
  return json({ data: presentMemory(await readMemory(env, repository.id)) }, created ? 201 : 200);
}

function presentHistory(row: HistoryRow) {
  return {
    revision: row.revision,
    actor: parseRevisionActor(row.actor_json),
    size: row.size,
    updatedAt: row.updated_at,
  };
}

async function listTasks(
  env: ForgeEnv,
  repository: RepositoryRow,
  request: Request
): Promise<Response> {
  const statusParam = new URL(request.url).searchParams.get("status");
  const status = statusParam === null ? null : TaskStatusSchema.safeParse(statusParam);
  if (status && !status.success) return error(400, "bad_request", "Invalid task status filter.");
  const rows = await env.DB.prepare(
    `${TASK_SELECT} WHERE t.repository_id = ? AND (? IS NULL OR t.status = ?) ORDER BY t.number DESC`
  )
    .bind(repository.id, status?.data ?? null, status?.data ?? null)
    .all<TaskRow>();
  return json({ data: rows.results.map(presentTask) });
}

async function taskDetail(env: ForgeEnv, taskId: string): Promise<TaskDetail | null> {
  const [task, documents, links, commits] = await Promise.all([
    env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(taskId).first<TaskRow>(),
    env.DB.prepare(
      "SELECT kind, content, revision, actor_json, updated_at FROM forge_task_documents WHERE task_id = ?"
    )
      .bind(taskId)
      .all<DocumentRow>(),
    env.DB.prepare(
      "SELECT l.target_kind AS kind, COALESCE(i.number, p.number) AS number, COALESCE(i.title, p.title) AS title, COALESCE(i.state, p.state) AS state, l.created_at FROM forge_task_links l LEFT JOIN forge_issues i ON l.target_kind = 'issue' AND i.id = l.target_id LEFT JOIN forge_pull_requests p ON l.target_kind = 'pull_request' AND p.id = l.target_id WHERE l.task_id = ? ORDER BY l.created_at ASC, number ASC"
    )
      .bind(taskId)
      .all<LinkRow>(),
    env.DB.prepare(
      "SELECT oid, ref, summary, author_name, bound_by_json, source, bound_at FROM forge_task_commits WHERE task_id = ? ORDER BY bound_at DESC"
    )
      .bind(taskId)
      .all<CommitRow>(),
  ]);
  if (!task) return null;
  const byKind = new Map(documents.results.map((row) => [row.kind, presentDocument(row)]));
  const actor = parseActor(task.actor_json, task.created_by);
  const empty = (kind: TaskDocumentKind): TaskDocument => ({
    kind,
    content: "",
    revision: 0,
    actor,
    updatedAt: task.created_at,
  });
  return {
    ...presentTask(task),
    documents: {
      plan: byKind.get("plan") ?? empty("plan"),
      findings: byKind.get("findings") ?? empty("findings"),
      progress: byKind.get("progress") ?? empty("progress"),
    },
    links: links.results.map((row): TaskLink => ({
      kind: row.kind,
      number: row.number,
      title: row.title,
      state: row.state,
      createdAt: row.created_at,
    })),
    commits: commits.results.map(presentCommit),
  };
}

async function createTask(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser
): Promise<Response> {
  const parsed = CreateTaskInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid task payload.");
  const actor = actorForUser(user);
  const actorJson = JSON.stringify(actor);
  const number = await nextNumber(env, "forge_tasks", repository.id);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO forge_tasks (id, repository_id, number, type, title, motivation, description, status, created_by, actor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)"
    ).bind(
      id,
      repository.id,
      number,
      parsed.data.type,
      parsed.data.title,
      parsed.data.motivation,
      parsed.data.description,
      user.id,
      actorJson,
      now,
      now
    ),
    ...TASK_DOCUMENT_KINDS.map((kind) =>
      env.DB.prepare(
        "INSERT INTO forge_task_documents (task_id, kind, content, revision, updated_by, actor_json, updated_at) VALUES (?, ?, '', 0, ?, ?, ?)"
      ).bind(id, kind, user.id, actorJson, now)
    ),
  ]);
  createLogger(env.LOG_LEVEL, { service: "forge" }).info("forge:task-created", {
    repositoryId: repository.id,
    taskNumber: number,
    type: parsed.data.type,
    actorKind: actor.kind,
  });
  return json({ data: await taskDetail(env, id) }, 201);
}

async function updateTask(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  task: { id: string; number: number; status: TaskStatus }
): Promise<Response> {
  const parsed = UpdateTaskInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid task update.");
  const p = parsed.data;
  const now = Date.now();
  const statusChanged = p.status !== undefined && p.status !== task.status;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE forge_tasks SET type = COALESCE(?, type), title = COALESCE(?, title), motivation = COALESCE(?, motivation), description = COALESCE(?, description), status = COALESCE(?, status), updated_at = ? WHERE id = ?"
    ).bind(
      p.type ?? null,
      p.title ?? null,
      p.motivation ?? null,
      p.description ?? null,
      p.status ?? null,
      now,
      task.id
    ),
    ...(statusChanged
      ? systemProgressStatements(
          env,
          { taskId: task.id },
          `Task status changed from ${task.status} to ${p.status} by ${actorForUser(user).name}`,
          now,
          true
        )
      : []),
  ]);
  createLogger(env.LOG_LEVEL, { service: "forge" }).info("forge:task-updated", {
    repositoryId: repository.id,
    taskNumber: task.number,
    statusChanged,
  });
  return json({ data: await taskDetail(env, task.id) });
}

async function assignTask(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  task: { id: string; number: number }
): Promise<Response> {
  const parsed = AssignTaskInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid task assignee payload.");
  let kind: "user" | "agent" | null = null;
  let id: string | null = null;
  if (parsed.data.assignee) {
    const resolved = await resolveAssignable(env, repository, user, parsed.data.assignee);
    if (!resolved.ok) return resolved.response;
    kind = resolved.assignee.kind;
    id = resolved.assignee.id;
  }
  await env.DB.prepare(
    "UPDATE forge_tasks SET assignee_kind = ?, assignee_id = ?, updated_at = ? WHERE id = ?"
  )
    .bind(kind, id, Date.now(), task.id)
    .run();
  if (kind === "agent" && id)
    await agentEvent(env, repository, user, id, "agent.assigned", {
      targetKind: "task",
      targetId: task.id,
      number: task.number,
    });
  createLogger(env.LOG_LEVEL, { service: "forge" }).info("forge:task-assigned", {
    repositoryId: repository.id,
    taskNumber: task.number,
    assigneeKind: kind,
  });
  return json({ data: await taskDetail(env, task.id) });
}

async function documentRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser | null,
  task: { id: string; number: number },
  rest: string[]
): Promise<Response | null> {
  const [, , , kindParam, view, revisionParam] = rest;
  const kind = TaskDocumentKindSchema.safeParse(kindParam);
  if (!kind.success) return error(404, "not_found", "Task document was not found.");
  if (request.method === "GET" && !view) {
    const row = await env.DB.prepare(
      "SELECT kind, content, revision, actor_json, updated_at FROM forge_task_documents WHERE task_id = ? AND kind = ?"
    )
      .bind(task.id, kind.data)
      .first<DocumentRow>();
    return row
      ? json({ data: presentDocument(row) })
      : error(404, "not_found", "Task document was not found.");
  }
  if (request.method === "GET" && view === "history" && !revisionParam) {
    const rows = await env.DB.prepare(
      "SELECT revision, actor_json, length(content) AS size, updated_at FROM forge_task_document_revisions WHERE task_id = ? AND kind = ? ORDER BY revision DESC"
    )
      .bind(task.id, kind.data)
      .all<HistoryRow>();
    return json({ data: rows.results.map(presentHistory) });
  }
  if (request.method === "GET" && view === "revisions" && revisionParam) {
    const revision = positiveInteger(revisionParam);
    const row = revision
      ? await env.DB.prepare(
          "SELECT kind, content, revision, actor_json, updated_at FROM forge_task_document_revisions WHERE task_id = ? AND kind = ? AND revision = ?"
        )
          .bind(task.id, kind.data, revision)
          .first<DocumentRow>()
      : null;
    return row
      ? json({ data: presentDocument(row) })
      : error(404, "not_found", "Task document revision was not found.");
  }
  if (request.method !== "PUT" || view || !user) return null;
  const parsed = PutTaskDocumentInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid task document payload.");
  const actor = actorForUser(user);
  const now = Date.now();
  const { content, expectedRevision } = parsed.data;
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE forge_task_documents SET content = ?, revision = revision + 1, updated_by = ?, actor_json = ?, updated_at = ? WHERE task_id = ? AND kind = ? AND revision = ?"
    ).bind(content, user.id, JSON.stringify(actor), now, task.id, kind.data, expectedRevision),
    env.DB.prepare(
      "INSERT INTO forge_task_document_revisions (task_id, kind, revision, content, updated_by, actor_json, updated_at) SELECT task_id, kind, revision, content, updated_by, actor_json, updated_at FROM forge_task_documents WHERE task_id = ? AND kind = ? AND revision = ? AND changes() = 1"
    ).bind(task.id, kind.data, expectedRevision + 1),
    env.DB.prepare("UPDATE forge_tasks SET updated_at = ? WHERE id = ? AND changes() = 1").bind(
      now,
      task.id
    ),
  ]);
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  if (results[0].meta.changes !== 1) {
    logger.warn("forge:task-document-conflict", {
      repositoryId: repository.id,
      taskNumber: task.number,
      kind: kind.data,
      expectedRevision,
    });
    return error(409, "conflict", "Task document revision has changed.");
  }
  logger.info("forge:task-document-saved", {
    repositoryId: repository.id,
    taskNumber: task.number,
    kind: kind.data,
    revision: expectedRevision + 1,
    actorKind: actor.kind,
  });
  return json({
    data: presentDocument({
      kind: kind.data,
      content,
      revision: expectedRevision + 1,
      actor_json: JSON.stringify(actor),
      updated_at: now,
    }),
  });
}

async function linkRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  task: { id: string; number: number },
  rest: string[]
): Promise<Response | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const [, , , kindParam, numberParam] = rest;
  if (request.method === "POST" && !kindParam) {
    const parsed = AttachTaskLinkInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return error(400, "bad_request", "Invalid task link payload.");
    const target = await env.DB.prepare(
      `SELECT id, title, state FROM ${LINK_TABLES[parsed.data.kind]} WHERE repository_id = ? AND number = ?`
    )
      .bind(repository.id, parsed.data.number)
      .first<{ id: string; title: string; state: LinkRow["state"] }>();
    if (!target) return error(404, "not_found", "Issue or pull request was not found.");
    const now = Date.now();
    const inserted = await env.DB.prepare(
      "INSERT INTO forge_task_links (id, repository_id, task_id, target_kind, target_id, actor_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_kind, target_id) DO NOTHING"
    )
      .bind(
        crypto.randomUUID(),
        repository.id,
        task.id,
        parsed.data.kind,
        target.id,
        JSON.stringify(actorForUser(user)),
        now
      )
      .run();
    if (inserted.meta.changes !== 1) {
      logger.warn("forge:task-link-conflict", {
        repositoryId: repository.id,
        targetKind: parsed.data.kind,
        targetNumber: parsed.data.number,
      });
      return error(409, "conflict", "Issue or pull request already belongs to a task.");
    }
    logger.info("forge:task-link-attached", {
      repositoryId: repository.id,
      taskNumber: task.number,
      targetKind: parsed.data.kind,
      targetNumber: parsed.data.number,
    });
    return json(
      {
        data: {
          kind: parsed.data.kind,
          number: parsed.data.number,
          title: target.title,
          state: target.state,
          createdAt: now,
        } satisfies TaskLink,
      },
      201
    );
  }
  if (request.method === "DELETE" && kindParam && numberParam) {
    const kind = z.enum(["issue", "pull_request"]).safeParse(kindParam);
    const number = positiveInteger(numberParam);
    if (!kind.success || !number) return error(404, "not_found", "Task link was not found.");
    const removed = await env.DB.prepare(
      `DELETE FROM forge_task_links WHERE task_id = ? AND target_kind = ? AND target_id = (SELECT id FROM ${LINK_TABLES[kind.data]} WHERE repository_id = ? AND number = ?) RETURNING id`
    )
      .bind(task.id, kind.data, repository.id, number)
      .first<{ id: string }>();
    if (!removed) return error(404, "not_found", "Task link was not found.");
    logger.info("forge:task-link-detached", {
      repositoryId: repository.id,
      taskNumber: task.number,
      targetKind: kind.data,
      targetNumber: number,
    });
    return new Response(null, { status: 204 });
  }
  return null;
}

const OWNING_TASK_SELECT =
  "SELECT t.number, t.type, t.title, t.status FROM forge_task_links l JOIN forge_tasks t ON t.id = l.task_id WHERE l.target_kind = ? AND l.target_id = ?";

/** Reads the task an issue or pull request belongs to, or moves it between tasks in one batch. */
async function itemTaskRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser | null,
  kindParam: string | undefined,
  numberParam: string | undefined
): Promise<Response | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const kind = TaskLinkKindSchema.safeParse(kindParam);
  const number = positiveInteger(numberParam);
  if (!kind.success || !number)
    return error(404, "not_found", "Issue or pull request was not found.");
  const target = await env.DB.prepare(
    `SELECT id FROM ${LINK_TABLES[kind.data]} WHERE repository_id = ? AND number = ?`
  )
    .bind(repository.id, number)
    .first<{ id: string }>();
  if (!target) return error(404, "not_found", "Issue or pull request was not found.");
  const owning = () =>
    env.DB.prepare(OWNING_TASK_SELECT).bind(kind.data, target.id).first<TaskReference>();
  if (request.method === "GET") return json({ data: (await owning()) ?? null });
  if (request.method !== "PUT" || !user) return null;
  const parsed = MoveTaskLinkInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid task move payload.");
  const destination = parsed.data.task;
  const task =
    destination === null
      ? null
      : await env.DB.prepare("SELECT id FROM forge_tasks WHERE repository_id = ? AND number = ?")
          .bind(repository.id, destination)
          .first<{ id: string }>();
  if (destination !== null && !task) return error(404, "not_found", "Task was not found.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM forge_task_links WHERE target_kind = ? AND target_id = ?").bind(
      kind.data,
      target.id
    ),
    ...(task
      ? [
          env.DB.prepare(
            "INSERT INTO forge_task_links (id, repository_id, task_id, target_kind, target_id, actor_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            crypto.randomUUID(),
            repository.id,
            task.id,
            kind.data,
            target.id,
            JSON.stringify(actorForUser(user)),
            Date.now()
          ),
        ]
      : []),
  ]);
  logger.info("forge:task-link-moved", {
    repositoryId: repository.id,
    targetKind: kind.data,
    targetNumber: number,
    taskNumber: destination,
  });
  return json({ data: (await owning()) ?? null });
}

async function commitRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  task: { id: string; number: number },
  rest: string[]
): Promise<Response | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const [, , , oidParam] = rest;
  if (request.method === "POST" && !oidParam) {
    const parsed = BindTaskCommitInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return error(400, "bad_request", "Invalid commit binding payload.");
    // One hop to the Git service confirms the repository itself holds the commit on the given
    // ref (never an agent session workspace) and snapshots it.
    const gitUrl = new URL(`/repositories/${repository.id}/commit`, request.url);
    gitUrl.searchParams.set("oid", parsed.data.oid);
    gitUrl.searchParams.set("ref", parsed.data.ref);
    const gitResponse = await env.GIT.fetch(new Request(gitUrl, { headers: trustedHeaders(user) }));
    if (gitResponse.status === 404) {
      logger.warn("forge:task-commit-not-found", {
        repositoryId: repository.id,
        oid: parsed.data.oid,
      });
      return error(404, "not_found", "Commit was not found on this ref of the repository.");
    }
    const commit = GitCommitResponseSchema.safeParse(await gitResponse.json().catch(() => null));
    if (!gitResponse.ok || !commit.success) {
      logger.error("forge:task-commit-lookup-failed", {
        repositoryId: repository.id,
        status: gitResponse.status,
      });
      return error(502, "internal_error", "Git service could not verify the commit.");
    }
    const actor = actorForUser(user);
    const now = Date.now();
    const summary = (commit.data.data.message.split("\n")[0] ?? "").trim().slice(0, 200);
    const inserted = await env.DB.prepare(
      "INSERT INTO forge_task_commits (id, repository_id, task_id, oid, ref, summary, author_name, bound_by_json, source, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?) ON CONFLICT(task_id, oid) DO NOTHING"
    )
      .bind(
        crypto.randomUUID(),
        repository.id,
        task.id,
        parsed.data.oid,
        parsed.data.ref,
        summary,
        commit.data.data.author.name,
        JSON.stringify(actor),
        now
      )
      .run();
    if (inserted.meta.changes !== 1)
      return error(409, "conflict", "Commit is already bound to this task.");
    logger.info("forge:task-commit-bound", {
      repositoryId: repository.id,
      taskNumber: task.number,
      oid: parsed.data.oid,
      actorKind: actor.kind,
    });
    return json(
      {
        data: {
          oid: parsed.data.oid,
          ref: parsed.data.ref,
          summary,
          author: commit.data.data.author.name,
          boundBy: actor,
          source: "manual",
          boundAt: now,
        } satisfies TaskCommit,
      },
      201
    );
  }
  if (request.method === "DELETE" && oidParam) {
    const removed = await env.DB.prepare(
      "DELETE FROM forge_task_commits WHERE task_id = ? AND oid = ? RETURNING id"
    )
      .bind(task.id, oidParam)
      .first<{ id: string }>();
    if (!removed) return error(404, "not_found", "Bound commit was not found.");
    logger.info("forge:task-commit-unbound", {
      repositoryId: repository.id,
      taskNumber: task.number,
      oid: oidParam,
    });
    return new Response(null, { status: 204 });
  }
  return null;
}

async function taskRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  viewer: Viewer,
  rest: string[]
): Promise<Response | null> {
  const [, item, action] = rest;
  const reading = request.method === "GET";
  if (!item) {
    if (reading) return listTasks(env, repository, request);
    if (request.method === "POST" && viewer.user)
      return createTask(env, request, repository, viewer.user);
    return null;
  }
  if (item === "table" && reading && !action)
    return json({ data: await taskTable(env, repository) });
  if (item === "link")
    return itemTaskRequest(env, request, repository, viewer.user, action, rest[3]);
  const number = positiveInteger(item);
  if (!number) return error(404, "not_found", "Task was not found.");
  const task = await env.DB.prepare(
    "SELECT id, number, status FROM forge_tasks WHERE repository_id = ? AND number = ?"
  )
    .bind(repository.id, number)
    .first<{ id: string; number: number; status: TaskStatus }>();
  if (!task) return error(404, "not_found", "Task was not found.");
  if (reading && !action) return json({ data: await taskDetail(env, task.id) });
  if (request.method === "PATCH" && !action && viewer.user)
    return updateTask(env, request, repository, viewer.user, task);
  if (request.method === "PUT" && action === "assignee" && viewer.user)
    return assignTask(env, request, repository, viewer.user, task);
  if (action === "documents")
    return documentRequest(env, request, repository, viewer.user, task, rest);
  if (action === "links" && viewer.user)
    return linkRequest(env, request, repository, viewer.user, task, rest);
  if (action === "commits" && viewer.user)
    return commitRequest(env, request, repository, viewer.user, task, rest);
  return null;
}

async function settingsRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  viewer: Viewer
): Promise<Response | null> {
  if (request.method === "GET") {
    const settings = await repositorySettings(env, repository.id);
    return json({ data: { ...settings, canManage: await viewer.isOwner() } });
  }
  if (request.method !== "PATCH" || !viewer.user) return null;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  if (!(await viewer.isOwner()))
    return error(403, "forbidden", "Repository owner access is required to change settings.");
  const parsed = UpdateRepositorySettingsInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return error(400, "bad_request", "Invalid repository settings.");
  const input = parsed.data;
  const slug = input.name ?? input.slug;
  if (
    !(input.allowMergeCommit ?? repository.allow_merge_commit !== 0) &&
    !(input.allowSquashMerge ?? repository.allow_squash_merge !== 0) &&
    !(input.allowRebaseMerge ?? repository.allow_rebase_merge !== 0)
  )
    return error(400, "bad_request", "At least one merge method must be enabled.");
  if (slug && slug !== repository.slug) {
    const collision = await env.DB.prepare(
      "SELECT 1 AS found FROM repository_paths WHERE namespace_id = ? AND slug = ? AND repository_id != ?"
    )
      .bind(repository.namespace_id, slug, repository.id)
      .first<{ found: number }>();
    if (collision) return error(409, "conflict", "Repository slug already exists.");
  }
  if (input.defaultBranch && input.defaultBranch !== repository.default_branch) {
    const gitUrl = new URL(`/repositories/${repository.id}/refs`, request.url);
    const response = await env.GIT.fetch(
      new Request(gitUrl, { headers: trustedHeaders(viewer.user) })
    );
    const branchFound = await repositoryBranchExists(response, input.defaultBranch);
    if (branchFound === null)
      return error(
        503,
        "internal_error",
        "Repository refs are unavailable or exceed the response limit."
      );
    if (!branchFound)
      return error(400, "bad_request", "Default branch must name an existing repository branch.");
  }
  const visibility = input.visibility ?? null;
  const memoryVisibility = visibility === "private" ? "members" : (input.memoryVisibility ?? null);
  try {
    const mutation = env.DB.prepare(
      "UPDATE repositories SET slug = COALESCE(?, slug), description = COALESCE(?, description), visibility = COALESCE(?, visibility), default_branch = COALESCE(?, default_branch), archived = COALESCE(?, archived), issues_enabled = COALESCE(?, issues_enabled), pulls_enabled = COALESCE(?, pulls_enabled), discussions_enabled = COALESCE(?, discussions_enabled), wiki_enabled = COALESCE(?, wiki_enabled), required_approvals = COALESCE(?, required_approvals), require_passing_checks = COALESCE(?, require_passing_checks), tasks_enabled = COALESCE(?, tasks_enabled), agents_enabled = COALESCE(?, agents_enabled), deployments_enabled = COALESCE(?, deployments_enabled), graph_enabled = COALESCE(?, graph_enabled), actions_enabled = COALESCE(?, actions_enabled), actions_network_enabled = COALESCE(?, actions_network_enabled), online_editing_enabled = COALESCE(?, online_editing_enabled), allow_merge_commit = COALESCE(?, allow_merge_commit), allow_squash_merge = COALESCE(?, allow_squash_merge), allow_rebase_merge = COALESCE(?, allow_rebase_merge), delete_branch_on_merge = COALESCE(?, delete_branch_on_merge), memory_visibility = COALESCE(?, memory_visibility), agent_assignment_policy = COALESCE(?, agent_assignment_policy), updated_at = ? WHERE id = ? AND (? IS NULL OR ? = 'members' OR COALESCE(?, visibility) = 'public')"
    ).bind(
      slug ?? null,
      input.description ?? null,
      visibility,
      input.defaultBranch ?? null,
      input.archived === undefined ? null : input.archived ? 1 : 0,
      input.issuesEnabled === undefined ? null : input.issuesEnabled ? 1 : 0,
      input.pullsEnabled === undefined ? null : input.pullsEnabled ? 1 : 0,
      input.discussionsEnabled === undefined ? null : input.discussionsEnabled ? 1 : 0,
      input.wikiEnabled === undefined ? null : input.wikiEnabled ? 1 : 0,
      input.requiredApprovals ?? null,
      input.requirePassingChecks === undefined ? null : input.requirePassingChecks ? 1 : 0,
      input.tasksEnabled === undefined ? null : Number(input.tasksEnabled),
      input.agentsEnabled === undefined ? null : Number(input.agentsEnabled),
      input.deploymentsEnabled === undefined ? null : Number(input.deploymentsEnabled),
      input.graphEnabled === undefined ? null : Number(input.graphEnabled),
      input.actionsEnabled === undefined ? null : Number(input.actionsEnabled),
      input.actionsNetworkEnabled === undefined ? null : Number(input.actionsNetworkEnabled),
      input.onlineEditingEnabled === undefined ? null : Number(input.onlineEditingEnabled),
      input.allowMergeCommit === undefined ? null : Number(input.allowMergeCommit),
      input.allowSquashMerge === undefined ? null : Number(input.allowSquashMerge),
      input.allowRebaseMerge === undefined ? null : Number(input.allowRebaseMerge),
      input.deleteBranchOnMerge === undefined ? null : Number(input.deleteBranchOnMerge),

      memoryVisibility,
      input.agentAssignmentPolicy ?? null,
      Date.now(),
      repository.id,
      memoryVisibility,
      memoryVisibility,
      visibility
    );
    const changed = await mutation.run();
    if (changed.meta.changes < 1)
      return error(
        400,
        "bad_request",
        "Only public repositories can expose tasks and memory publicly."
      );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown";
    if (!detail.includes("UNIQUE constraint") && !detail.includes("repository path")) {
      logger.error("forge:settings-update-failed", { repositoryId: repository.id, error: detail });
      return error(500, "internal_error", "Repository settings could not be updated.");
    }
    logger.warn("forge:settings-conflict", { repositoryId: repository.id });
    return error(409, "conflict", "Repository slug already exists.");
  }
  logger.info("forge:settings-updated", {
    repositoryId: repository.id,
    slug,
    visibility,
    archived: input.archived,
  });
  return json({
    data: { ...(await repositorySettings(env, repository.id)), canManage: true },
  });
}

async function repositoryBranchExists(response: Response, branch: string): Promise<boolean | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  )
    return null;
  return payload.data.some(
    (ref) => ref && typeof ref === "object" && "name" in ref && ref.name === `refs/heads/${branch}`
  );
}

/**
 * Routes for repository memory, tasks, settings and assignee candidates. `rest` is the path after
 * the repository id. Returns null when the path or method is not handled here.
 */
export async function memoryTaskRequest(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  viewer: Viewer,
  rest: string[]
): Promise<Response | null> {
  if ((rest[0] === "tasks" || rest[0] === "memory") && repository.tasks_enabled === 0)
    return error(404, "feature_disabled", "Tasks and memory are disabled.");
  const resource = rest[0];
  if (resource === "settings" && rest.length === 1)
    return settingsRequest(env, request, repository, viewer);
  if (resource && request.method !== "GET" && repository.archived === 1)
    return error(409, "repository_archived", "Archived repositories are read-only.");
  if (resource === "assignee-candidates" && rest.length === 1 && request.method === "GET") {
    if (!viewer.user || !viewer.member)
      return error(403, "forbidden", "Repository membership is required.");
    return json({ data: await assigneeCandidates(env, repository, viewer.user) });
  }
  if (resource !== "memory" && resource !== "tasks") return null;

  if (request.method === "GET") {
    const settings = await repositorySettings(env, repository.id);
    const publicRead = repository.visibility === "public" && settings.memoryVisibility === "public";
    if (!viewer.member && !publicRead)
      return error(403, "forbidden", "Repository membership is required to read tasks and memory.");
  } else if (!viewer.user || !viewer.member || !viewer.writeAllowed) {
    return error(403, "forbidden", "Repository membership and a writable session are required.");
  }
  return resource === "memory"
    ? memoryRequest(env, request, repository, viewer, rest)
    : taskRequest(env, request, repository, viewer, rest);
}
