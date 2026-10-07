import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { readJsonLimited } from "../../../src/worker/common/readText";
import {
  ActorSchema,
  type Actor,
  type Repository,
  type RepositoryRole,
  type TrustedUser,
} from "../../../packages/contracts/src/index";

export type ForgeEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: Artifacts;
  readonly AUTH?: { fetch(request: Request): Promise<Response> };
  readonly GIT: { fetch(request: Request): Promise<Response> };
  readonly LOG_LEVEL?: string;
  readonly USER_GROUP_LIMITS_JSON?: string;
};
export type RepositoryRow = {
  id: string;
  can_write?: number;
  namespace_id: string;
  owner: string;
  slug: string;
  visibility: "public" | "private";
  description: string;
  artifact_name?: string | null;
  remote?: string | null;
  default_branch?: string;
  archived?: number;
  issues_enabled?: number;
  pulls_enabled?: number;
  discussions_enabled?: number;
  wiki_enabled?: number;
  tasks_enabled?: number;
  agents_enabled?: number;
  deployments_enabled?: number;
  graph_enabled?: number;
  actions_enabled?: number;
  actions_network_enabled?: number;
  online_editing_enabled?: number;
  allow_merge_commit?: number;
  allow_squash_merge?: number;
  allow_rebase_merge?: number;
  delete_branch_on_merge?: number;
  required_approvals?: number;
  require_passing_checks?: number;
  created_at: number;
  updated_at: number;
};
type NumberRow = { number: number | null };
export type NumberedTable =
  "forge_issues" | "forge_pull_requests" | "forge_discussions" | "forge_tasks";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export async function parseJson(request: Request): Promise<unknown> {
  return readJsonLimited(request);
}

export async function isMember(
  env: ForgeEnv,
  repositoryId: string,
  userId: string
): Promise<boolean> {
  return writableRole(await repositoryRole(env.DB, repositoryId, userId));
}

export function canWriteSession(user: TrustedUser, repositoryId: string): boolean {
  return (
    !user.agentSession ||
    (user.agentSession.repositoryId === repositoryId && user.agentSession.permission === "write")
  );
}

export async function nextNumber(
  env: ForgeEnv,
  table: NumberedTable,
  repositoryId: string
): Promise<number> {
  const column =
    table === "forge_discussions"
      ? "discussion_number"
      : table === "forge_tasks"
        ? "task_number"
        : "conversation_number";
  await env.DB.prepare("INSERT OR IGNORE INTO forge_counters (repository_id) VALUES (?)")
    .bind(repositoryId)
    .run();
  const row = await env.DB.prepare(
    `UPDATE forge_counters SET ${column} = ${column} + 1 WHERE repository_id = ? RETURNING ${column} AS number`
  )
    .bind(repositoryId)
    .first<NumberRow>();
  if (!row?.number) throw new Error("Repository counter did not return a number.");
  return row.number;
}

export function parseActor(value: unknown, authorId: unknown): Actor {
  try {
    const parsed = ActorSchema.safeParse(JSON.parse(String(value)));
    if (parsed.success) return parsed.data;
  } catch {
    /* malformed legacy actor data falls back to the stored user identity */
  }
  const id = typeof authorId === "string" ? authorId : "unknown";
  return { kind: "user", id, name: id };
}

export function repoResponse(
  row: RepositoryRow,
  viewerRole: RepositoryRole | null = null,
  canWrite = false
) {
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    owner: row.owner,
    name: row.slug,
    slug: row.slug,
    defaultBranch: row.default_branch ?? "main",
    visibility: row.visibility,
    description: row.description,
    archived: row.archived === 1,
    issuesEnabled: row.issues_enabled !== 0,
    pullsEnabled: row.pulls_enabled !== 0,
    discussionsEnabled: row.discussions_enabled !== 0,
    wikiEnabled: row.wiki_enabled !== 0,
    tasksEnabled: row.tasks_enabled !== 0,
    agentsEnabled: row.agents_enabled !== 0,
    deploymentsEnabled: row.deployments_enabled !== 0,
    graphEnabled: row.graph_enabled !== 0,
    actionsEnabled: row.actions_enabled === 1,
    actionsNetworkEnabled: row.actions_network_enabled === 1,
    onlineEditingEnabled: row.online_editing_enabled !== 0,
    allowMergeCommit: row.allow_merge_commit !== 0,
    allowSquashMerge: row.allow_squash_merge !== 0,
    allowRebaseMerge: row.allow_rebase_merge !== 0,
    deleteBranchOnMerge: row.delete_branch_on_merge === 1,
    requiredApprovals: row.required_approvals ?? 0,
    requirePassingChecks: row.require_passing_checks === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    viewerRole,
    canWrite,
  } satisfies Omit<Repository, "createdAt"> & { createdAt: number };
}
