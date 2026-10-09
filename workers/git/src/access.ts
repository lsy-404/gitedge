import { repositoryAccessDenied } from "../../../src/worker/common/repository-response";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import {
  accessTokenAllows,
  accessTokenAllowsRepository,
  readTrustedUser,
  type AgentSession,
  type TrustedUser,
} from "../../../packages/contracts/src/index";

export interface GitEnv {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  FORGE?: { fetch(request: Request): Promise<Response> };
  ACTIONS?: { fetch(request: Request): Promise<Response> };
  LOG_LEVEL?: string;
}
export interface GitRepositoryRow {
  id: string;
  namespaceId: string;
  artifactName: string | null;
  remote: string | null;
  defaultBranch: string;
  visibility: "public" | "private";
  owner: string;
  slug: string;
  canWrite: number;
  archived: number;
  agentsEnabled: number;
  graphEnabled: number;
  onlineEditingEnabled: number;
  cacheGeneration: number;
}
export interface GitRepositoryAccess {
  repository: GitRepositoryRow;
  user: TrustedUser | null;
}

export async function resolveGitAccess(
  request: Request,
  env: GitEnv,
  repositoryId: string
): Promise<GitRepositoryAccess | Response | null> {
  const user = readTrustedUser(request);
  if (user?.agentSession && user.agentSession.repositoryId !== repositoryId) return null;
  if (
    user?.token &&
    (!accessTokenAllowsRepository(user.token, repositoryId) ||
      !accessTokenAllows(user.token, "repo:read"))
  )
    return null;
  const repository = await env.DB.prepare(
    "SELECT r.id, r.namespace_id AS namespaceId, r.artifact_name AS artifactName, r.remote, r.default_branch AS defaultBranch, r.visibility, n.slug AS owner, r.slug, r.archived, r.agents_enabled AS agentsEnabled, r.graph_enabled AS graphEnabled,r.online_editing_enabled AS onlineEditingEnabled,r.cache_generation AS cacheGeneration,0 AS canWrite FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE r.id = ? AND r.deleted_at IS NULL"
  )
    .bind(repositoryId)
    .first<GitRepositoryRow>();
  if (!repository) return null;
  const role = user ? await repositoryRole(env.DB, repositoryId, user.id) : null;
  if (repository.visibility !== "public" && role === null) return repositoryAccessDenied();
  repository.canWrite = Number(writableRole(role));
  if (user?.agentSession) {
    const active = await env.DB.prepare(
      "SELECT s.id FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id WHERE s.id = ? AND s.agent_id = ? AND s.user_id = ? AND s.repository_id = ? AND s.workspace_name = ? AND s.status = 'active' AND s.expires_at > ? AND a.disabled_at IS NULL"
    )
      .bind(
        user.agentSession.id,
        user.agentSession.agentId,
        user.id,
        repositoryId,
        user.agentSession.workspaceName,
        Date.now()
      )
      .first<{ id: string }>();
    if (
      !active ||
      !role ||
      (user.agentSession.permission === "write" && !repository.canWrite) ||
      repository.agentsEnabled === 0
    )
      return null;
  }
  return { repository, user };
}

export interface WorkspaceSession extends AgentSession {
  userId: string;
}

export async function resolveWorkspace(
  env: GitEnv,
  access: GitRepositoryAccess,
  sessionId?: string | null,
  publicHeadRef?: string
): Promise<WorkspaceSession | null> {
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    "SELECT s.id, s.agent_id AS agentId, s.user_id AS userId, a.name AS agentName, s.repository_id AS repositoryId, s.workspace_name AS workspaceName, s.remote, s.base_ref AS baseRef, s.base_oid AS baseOid, s.permission, s.status, s.created_at AS createdAt, s.expires_at AS expiresAt FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id WHERE s.id = ? AND s.repository_id = ?"
  )
    .bind(sessionId, access.repository.id)
    .first<WorkspaceSession>();
  if (!row) return null;
  const ownWorkspace = !access.user?.agentSession || access.user.agentSession.id === sessionId;
  if (access.user?.agentSession?.id !== row.id && (!access.repository.canWrite || !ownWorkspace)) {
    // A published PR grants access to its head only, never to the entire private fork.
    if (!publicHeadRef) return null;
    const publicPull = await env.DB.prepare(
      "SELECT id FROM forge_pull_requests WHERE repository_id = ? AND head_session_id = ? AND ((state = 'open' AND head_ref = ?) OR (state = 'merged' AND merge_head_oid = ?))"
    )
      .bind(access.repository.id, sessionId, publicHeadRef, publicHeadRef)
      .first<{ id: string }>();
    if (!publicPull) return null;
  }
  return row;
}

export interface ProposalHead {
  sessionId?: string | null;
  repositoryId?: string | null;
  ref: string;
}

/**
 * Artifacts name that holds a proposal head: the base repository itself, an agent session fork or a
 * fork owned by a user. A private fork is readable only by its members and through a published
 * pull request for exactly that head ref. Null when the head is unavailable to the caller.
 */
export async function resolveProposalHead(
  env: GitEnv,
  access: GitRepositoryAccess,
  head: ProposalHead
): Promise<string | null> {
  if (head.sessionId && head.repositoryId) return null;
  if (head.sessionId)
    return (await resolveWorkspace(env, access, head.sessionId, head.ref))?.workspaceName ?? null;
  if (!head.repositoryId) return access.repository.artifactName;
  const fork = await env.DB.prepare(
    "SELECT id, artifact_name AS artifactName, visibility FROM repositories WHERE id = ? AND fork_of = ? AND deleted_at IS NULL AND artifact_name IS NOT NULL"
  )
    .bind(head.repositoryId, access.repository.id)
    .first<{ id: string; artifactName: string; visibility: "public" | "private" }>();
  if (!fork) return null;
  const user = access.user;
  // Membership reaches a private fork only for credentials not scoped to another repository.
  const member =
    user !== null &&
    !user.agentSession &&
    (!user.token || accessTokenAllowsRepository(user.token, fork.id)) &&
    (await repositoryRole(env.DB, fork.id, user.id)) !== null;
  if (fork.visibility === "public" || member) return fork.artifactName;
  const published = await env.DB.prepare(
    "SELECT id FROM forge_pull_requests WHERE repository_id = ? AND head_repository_id = ? AND ((state = 'open' AND head_ref = ?) OR (state = 'merged' AND merge_head_oid = ?))"
  )
    .bind(access.repository.id, fork.id, head.ref, head.ref)
    .first<{ id: string }>();
  return published ? fork.artifactName : null;
}

export async function listRepositorySessions(
  env: GitEnv,
  access: GitRepositoryAccess
): Promise<AgentSession[]> {
  if (!access.repository.canWrite || access.repository.agentsEnabled === 0) return [];
  const rows = await env.DB.prepare(
    "SELECT s.id, s.agent_id AS agentId, a.name AS agentName, s.repository_id AS repositoryId, s.workspace_name AS workspaceName, s.remote, s.base_ref AS baseRef, s.base_oid AS baseOid, s.permission, s.status, s.created_at AS createdAt, s.expires_at AS expiresAt FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id WHERE s.repository_id = ? ORDER BY s.created_at DESC LIMIT 100"
  )
    .bind(access.repository.id)
    .all<AgentSession>();
  return access.user?.agentSession
    ? rows.results.filter((session) => session.id === access.user?.agentSession?.id)
    : rows.results;
}
