import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import {
  repositoryRole,
  writableRole,
  resolveRepositoryPath,
} from "../../../src/worker/common/repositories";
import { z } from "zod";
import {
  AGENT_SESSION_MAX_LIFETIME_MS,
  CreateAgentInputSchema,
  CreateAgentSessionInputSchema,
  RenewAgentSessionInputSchema,
  RevokeAgentSessionsInputSchema,
  accessTokenAllows,
  accessTokenAllowsRepository,
  sha256Hex,
  type Agent,
  UpdateAgentInputSchema,
  type AgentSession,
  type CreatedAgentSession,
  type RenewedAgentSession,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { handleAgentWebhookManagement } from "./agent-webhooks";
import { authenticateAccessToken, isAccessToken } from "./access-tokens";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";

export interface AgentAuthEnv {
  DB: D1Database;
  ARTIFACTS: Artifacts;
  WEBHOOK_ENCRYPTION_KEY?: string;
  LOG_LEVEL?: string;
}
interface AgentRow {
  id: string;
  owner: string;
  handle: string;
  profilePath: string;
  name: string;
  description: string;
  profilePublic: number;
  createdAt: number;
  updatedAt: number;
  disabledAt: number | null;
  deliveryMode: Agent["deliveryMode"];
}
interface AgentSessionRow extends AgentSession {
  gitTokenId: string;
  userId: string;
  identifier: string;
  groupKey: string;
}
interface RepositoryRow {
  id: string;
  artifactName: string | null;
  owner: string;
  slug: string;
  archived: number;
  agentsEnabled: number;
  writable: boolean;
}
export interface GitAuthentication {
  user: TrustedUser;
  repositoryId: string;
  permission: "read" | "write";
}

const agentSelect =
  "SELECT a.id, u.identifier AS owner, a.handle, '/' || u.identifier || '/@' || a.handle AS profilePath, a.name, a.description, a.profile_public AS profilePublic, a.created_at AS createdAt, a.updated_at AS updatedAt, a.disabled_at AS disabledAt, a.delivery_mode AS deliveryMode FROM auth_agents a JOIN users u ON u.id = a.user_id";
const sessionSelect = `SELECT s.id, s.agent_id AS agentId, a.name AS agentName, s.repository_id AS repositoryId, s.workspace_name AS workspaceName, s.remote, s.base_ref AS baseRef, s.base_oid AS baseOid, s.permission, s.status, s.created_at AS createdAt, s.expires_at AS expiresAt, s.created_at + ${AGENT_SESSION_MAX_LIFETIME_MS} AS maxExpiresAt, s.renewal_count AS renewalCount, s.git_token_id AS gitTokenId, s.user_id AS userId, u.identifier, u.group_key AS groupKey FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id JOIN users u ON u.id = s.user_id`;

function newToken(prefix: string): string {
  return prefix + randomHex(32);
}
function sessionResponse(row: AgentSessionRow): AgentSession {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    repositoryId: row.repositoryId,
    workspaceName: row.workspaceName,
    remote: row.remote,
    baseRef: row.baseRef,
    baseOid: row.baseOid,
    permission: row.permission,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    maxExpiresAt: row.maxExpiresAt,
    renewalCount: row.renewalCount,
  };
}

async function repositoryForOwner(
  env: { DB: D1Database },
  userId: string,
  repositoryId: string
): Promise<RepositoryRow | null> {
  const role = await repositoryRole(env.DB, repositoryId, userId);
  if (!role) return null;
  const row = await env.DB.prepare(
    "SELECT r.id,r.artifact_name AS artifactName,n.slug AS owner,r.slug,r.archived,r.agents_enabled AS agentsEnabled,0 AS writable FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE r.id=? AND r.deleted_at IS NULL"
  )
    .bind(repositoryId)
    .first<RepositoryRow>();
  return row ? { ...row, writable: writableRole(role) } : null;
}

const activeSessionSelect =
  sessionSelect +
  " JOIN repositories r ON r.id=s.repository_id LEFT JOIN namespace_memberships m ON m.namespace_id=r.namespace_id AND m.user_id=s.user_id LEFT JOIN repository_collaborators c ON c.repository_id=r.id AND c.user_id=s.user_id WHERE s.status='active' AND s.expires_at>? AND a.disabled_at IS NULL AND u.disabled_at IS NULL AND r.deleted_at IS NULL AND r.agents_enabled=1 AND (m.user_id IS NOT NULL OR c.role IN ('write','admin') OR (s.permission='read' AND c.role='read'))";

export async function authenticateAgentSession(
  env: AgentAuthEnv,
  token: string
): Promise<TrustedUser | null> {
  if (!/^ge_session_[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(activeSessionSelect + " AND s.token_hash=?")
    .bind(Date.now(), await sha256Hex(token))
    .first<AgentSessionRow>();
  return trustedAgentSession(row);
}

function trustedAgentSession(row: AgentSessionRow | null): TrustedUser | null {
  if (!row) return null;
  return {
    id: row.userId,
    identifier: row.identifier,
    groupKey: row.groupKey,
    agentSession: {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      repositoryId: row.repositoryId,
      workspaceName: row.workspaceName,
      permission: row.permission,
    },
  };
}

export interface GitCredentials {
  username: string | null;
  token: string;
}

/** Reads Bearer or HTTP Basic credentials; Basic permits an empty username because Git helpers vary. */
export function parseGitAuthorization(header: string | null): GitCredentials | null {
  const auth = header ?? "";
  if (auth.startsWith("Bearer ")) return { username: null, token: auth.slice(7) };
  if (!auth.startsWith("Basic ")) return null;
  try {
    const value = new TextDecoder().decode(
      Uint8Array.from(atob(auth.slice(6)), (character) => character.charCodeAt(0))
    );
    const separator = value.indexOf(":");
    if (separator < 0) return null;
    return { username: value.slice(0, separator), token: value.slice(separator + 1) };
  } catch {
    return null;
  }
}

/**
 * A valid credential that cannot reach a repository must not answer 401, because Git then erases
 * the stored credential from its helper. Missing and inaccessible private repositories stay alike.
 */
export type GitAuthenticationResult =
  | { outcome: "granted"; grant: GitAuthentication }
  | { outcome: "invalid" }
  | { outcome: "not_found"; privateRepository: boolean }
  | { outcome: "insufficient_scope" };

const INVALID_GIT_CREDENTIAL: GitAuthenticationResult = { outcome: "invalid" };

async function authenticateAccessTokenForRepository(
  env: AgentAuthEnv,
  token: string,
  owner: string,
  slug: string
): Promise<GitAuthenticationResult> {
  const user = await authenticateAccessToken(env, token);
  const identity = user?.token;
  if (!user || !identity) return INVALID_GIT_CREDENTIAL;
  const path = await resolveRepositoryPath(env.DB, owner, slug);
  if (!path) return { outcome: "not_found", privateRepository: false };
  const role = await repositoryRole(env.DB, path.id, user.id);
  if (role === null && path.visibility !== "public")
    return { outcome: "not_found", privateRepository: true };
  if (!accessTokenAllows(identity, "repo:read") || !accessTokenAllowsRepository(identity, path.id))
    return { outcome: "insufficient_scope" };
  const write = accessTokenAllows(identity, "repo:write") && writableRole(role);
  return {
    outcome: "granted",
    grant: { user, repositoryId: path.id, permission: write ? "write" : "read" },
  };
}

export async function authenticateGitToken(
  request: Request,
  env: AgentAuthEnv
): Promise<GitAuthenticationResult> {
  const credentials = parseGitAuthorization(request.headers.get("Authorization"));
  if (!credentials) return INVALID_GIT_CREDENTIAL;
  const owner = new URL(request.url).searchParams.get("owner");
  const slug = new URL(request.url).searchParams.get("repo");
  if (!owner || !slug) return INVALID_GIT_CREDENTIAL;
  if (isAccessToken(credentials.token))
    return authenticateAccessTokenForRepository(env, credentials.token, owner, slug);
  const grant = await authenticateRepositoryCredential(env, credentials, owner, slug);
  return grant ? { outcome: "granted", grant } : INVALID_GIT_CREDENTIAL;
}

async function authenticateRepositoryCredential(
  env: AgentAuthEnv,
  { username, token }: GitCredentials,
  owner: string,
  slug: string
): Promise<GitAuthentication | null> {
  const path = await resolveRepositoryPath(env.DB, owner, slug);
  if (!path) return null;
  const agent = await authenticateAgentSession(env, token);
  if (agent?.agentSession) {
    if (
      agent.agentSession.repositoryId !== path.id ||
      (username !== null && username !== owner && username !== agent.identifier)
    )
      return null;
    return { user: agent, repositoryId: path.id, permission: agent.agentSession.permission };
  }
  if (!/^ge_token_[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT t.repository_id AS repositoryId,t.permission,u.id,u.identifier,u.group_key AS groupKey FROM auth_git_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND t.repository_id=? AND u.disabled_at IS NULL"
  )
    .bind(await sha256Hex(token), Date.now(), path.id)
    .first<TrustedUser & { repositoryId: string; permission: "read" | "write" }>();
  if (!row || (username !== null && username !== owner && username !== row.identifier)) return null;
  const role = await repositoryRole(env.DB, row.repositoryId, row.id);
  if (!role) return null;
  return {
    user: { id: row.id, identifier: row.identifier, groupKey: row.groupKey },
    repositoryId: row.repositoryId,
    permission: row.permission === "write" && writableRole(role) ? "write" : "read",
  };
}

function readableHandle(name: string): string {
  const value = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return value || "agent";
}
async function availableHandle(
  env: AgentAuthEnv,
  userId: string,
  base: string
): Promise<string | null> {
  for (let suffix = 1; suffix <= 100; suffix += 1) {
    const candidate =
      suffix === 1
        ? base
        : `${base.slice(0, 39 - String(suffix).length).replace(/-+$/g, "")}-${suffix}`;
    const found = await env.DB.prepare(
      "SELECT 1 AS found FROM auth_agents WHERE user_id = ? AND handle = ?"
    )
      .bind(userId, candidate)
      .first<{ found: number }>();
    if (!found) return candidate;
  }
  return null;
}
async function loadManagedAgent(
  env: AgentAuthEnv,
  userId: string,
  agentId: string
): Promise<Agent | null> {
  const row = await env.DB.prepare(agentSelect + " WHERE a.id = ? AND a.user_id = ?")
    .bind(agentId, userId)
    .first<AgentRow>();
  return row ? { ...row, profilePublic: Boolean(row.profilePublic) } : null;
}

/** Revokes an Artifacts token; an already revoked token counts as success. */
async function revokeArtifactsToken(workspace: ArtifactsRepo, tokenId: string): Promise<void> {
  if (await workspace.revokeToken(tokenId)) return;
  const { tokens } = await workspace.listTokens();
  const alreadyRevoked = tokens.some((token) => token.id === tokenId && token.state === "revoked");
  if (!alreadyRevoked) throw new Error("token_not_revoked");
}

async function revokeSession(env: AgentAuthEnv, row: AgentSessionRow): Promise<void> {
  {
    using workspace = await env.ARTIFACTS.get(row.workspaceName);
    await revokeArtifactsToken(workspace, row.gitTokenId);
  }
  await env.DB.prepare("UPDATE auth_agent_sessions SET status = 'revoked' WHERE id = ?")
    .bind(row.id)
    .run();
}

export type RenewalOutcome =
  | { kind: "renewed"; session: RenewedAgentSession }
  | { kind: "lifetime_exceeded" }
  | { kind: "conflict" };

const MIN_RENEWAL_REMAINING_MS = 60_000;

/**
 * Extends an active session and replaces its Git credential. The new token is created first and
 * the old one revoked before the row moves, so a failure never leaves two valid credentials.
 */
export async function renewAgentSession(
  env: AgentAuthEnv,
  row: AgentSessionRow,
  ttlSeconds: number,
  now = Date.now()
): Promise<RenewalOutcome> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-auth" });
  const ceiling = row.createdAt + AGENT_SESSION_MAX_LIFETIME_MS;
  const expiresAt = Math.min(Math.max(now + ttlSeconds * 1000, row.expiresAt), ceiling);
  if (row.status !== "active" || row.expiresAt <= now) return { kind: "conflict" };
  if (row.expiresAt >= ceiling || expiresAt - now < MIN_RENEWAL_REMAINING_MS) {
    logger.info("agent:session-renewal-refused", { sessionId: row.id, agentId: row.agentId });
    return { kind: "lifetime_exceeded" };
  }
  using workspace = await env.ARTIFACTS.get(row.workspaceName);
  const next = await workspace.createToken(row.permission, Math.floor((expiresAt - now) / 1000));
  try {
    await revokeArtifactsToken(workspace, row.gitTokenId);
  } catch (error) {
    await workspace.revokeToken(next.id);
    throw error;
  }
  const moved = await env.DB.prepare(
    "UPDATE auth_agent_sessions SET git_token_id = ?, expires_at = ?, renewal_count = renewal_count + 1, renewed_at = ? WHERE id = ? AND status = 'active' AND git_token_id = ?"
  )
    .bind(next.id, Date.parse(next.expiresAt), now, row.id, row.gitTokenId)
    .run();
  if (moved.meta.changes !== 1) {
    await workspace.revokeToken(next.id);
    return { kind: "conflict" };
  }
  logger.info("agent:session-renewed", {
    sessionId: row.id,
    agentId: row.agentId,
    renewalCount: row.renewalCount + 1,
  });
  return {
    kind: "renewed",
    session: {
      ...sessionResponse(row),
      expiresAt: Date.parse(next.expiresAt),
      renewalCount: row.renewalCount + 1,
      gitToken: next.plaintext,
    },
  };
}

function renewalFailure(outcome: Exclude<RenewalOutcome, { kind: "renewed" }>): Response {
  return outcome.kind === "lifetime_exceeded"
    ? errorResponse(
        409,
        "session_lifetime_exceeded",
        "The session reached its maximum lifetime. Create a new session to continue."
      )
    : errorResponse(409, "conflict", "Session changed or is no longer active.");
}

/** Lets an agent renew its own session with the session token; expired sessions explain the next step. */
export async function handleAgentSessionRenewal(
  request: Request,
  env: AgentAuthEnv
): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!/^ge_session_[0-9a-f]{64}$/.test(token))
    return errorResponse(401, "unauthorized", "An agent session token is required.");
  const parsed = RenewAgentSessionInputSchema.safeParse(
    (await readJsonLimited(request, SMALL_JSON_BYTES)) ?? {}
  );
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid renewal payload.");
  const row = await env.DB.prepare(
    sessionSelect + " WHERE s.token_hash = ? AND a.disabled_at IS NULL AND u.disabled_at IS NULL"
  )
    .bind(await sha256Hex(token))
    .first<AgentSessionRow>();
  if (!row || row.status === "revoked")
    return errorResponse(401, "unauthorized", "Agent session is invalid or revoked.");
  if (row.expiresAt <= Date.now() || row.status !== "active")
    return errorResponse(
      401,
      "session_expired",
      "The agent session has expired. Ask its owner to create a new session in Settings, Agents."
    );
  if (!(await authenticateAgentSession(env, token)))
    return errorResponse(401, "unauthorized", "Agent session is invalid or revoked.");
  try {
    const outcome = await renewAgentSession(env, row, parsed.data.ttlSeconds);
    return outcome.kind === "renewed" ? dataResponse(outcome.session) : renewalFailure(outcome);
  } catch {
    createLogger(env.LOG_LEVEL, { service: "agent-auth" }).error("agent:session-renewal-failed", {
      sessionId: row.id,
      agentId: row.agentId,
    });
    return errorResponse(503, "service_unavailable", "Session renewal failed; retry.");
  }
}

async function revokeSessions(
  env: AgentAuthEnv,
  rows: readonly AgentSessionRow[],
  logger: Logger
): Promise<number> {
  let failed = 0;
  for (const row of rows) {
    try {
      await revokeSession(env, row);
    } catch {
      failed += 1;
      logger.error("agent:session-revoke-failed", { sessionId: row.id, agentId: row.agentId });
    }
  }
  return failed;
}

const REVOKE_BATCH_LIMIT = 100;

/**
 * Revokes every active agent session of one user and, when `personalRepositories` is set, every
 * session on repositories in that user's personal namespace; false when some remain active.
 */
export async function revokeUserAgentSessions(
  env: AgentAuthEnv,
  userId: string,
  personalRepositories: boolean
): Promise<boolean> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-auth" });
  for (let round = 0; round < 5; round += 1) {
    const rows = await env.DB.prepare(
      sessionSelect +
        " WHERE s.status = 'active' AND (s.user_id = ?1 OR (?2 = 1 AND s.repository_id IN (SELECT r.id FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE n.kind = 'personal' AND n.created_by = ?1))) LIMIT ?3"
    )
      .bind(userId, Number(personalRepositories), REVOKE_BATCH_LIMIT)
      .all<AgentSessionRow>();
    if (rows.results.length === 0) return true;
    if ((await revokeSessions(env, rows.results, logger)) > 0) return false;
  }
  return false;
}

export async function handleAgentSessionRevocation(
  request: Request,
  env: AgentAuthEnv
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-auth" });
  const parsed = RevokeAgentSessionsInputSchema.safeParse(
    await readJsonLimited(request, SMALL_JSON_BYTES)
  );
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid revocation request.");
  const input = parsed.data;
  const rows =
    "namespaceId" in input
      ? await env.DB.prepare(
          sessionSelect +
            " WHERE s.status = 'active' AND s.user_id = ? AND s.repository_id IN (SELECT r.id FROM repositories r WHERE r.namespace_id = ? AND NOT EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id = r.id AND c.user_id = ?)) LIMIT ?"
        )
          .bind(input.userId, input.namespaceId, input.userId, REVOKE_BATCH_LIMIT + 1)
          .all<AgentSessionRow>()
      : await env.DB.prepare(
          sessionSelect +
            " WHERE s.status = 'active' AND s.repository_id = ? AND (? IS NULL OR s.user_id = ?) LIMIT ?"
        )
          .bind(
            input.repositoryId,
            input.userId ?? null,
            input.userId ?? null,
            REVOKE_BATCH_LIMIT + 1
          )
          .all<AgentSessionRow>();
  const batch = rows.results.slice(0, REVOKE_BATCH_LIMIT);
  const failed = await revokeSessions(env, batch, logger);
  const truncated = rows.results.length > REVOKE_BATCH_LIMIT;
  if (failed > 0 || truncated) {
    logger.warn("agent:session-revocation-incomplete", { failed, truncated });
    return errorResponse(503, "service_unavailable", "Some agent sessions are still active.");
  }
  logger.info("agent:sessions-revoked", { count: batch.length });
  return dataResponse({ revoked: batch.length });
}

export async function handleAgentManagement(
  request: Request,
  env: AgentAuthEnv,
  user: TrustedUser
): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (!["agents", "sessions", "tokens"].includes(parts[0] ?? "")) return null;
  if (user.agentSession)
    return errorResponse(403, "forbidden", "Agent sessions cannot manage account credentials.");
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-auth" });
  try {
    if (parts[0] === "tokens") return await handleGitTokenManagement(request, env, user);
    if (parts[0] === "sessions" && parts.length === 1 && request.method === "GET") {
      const repoId = url.searchParams.get("repositoryId");
      if (repoId) {
        const repository = await repositoryForOwner(env, user.id, repoId);
        if (!repository || repository.agentsEnabled === 0)
          return errorResponse(404, "not_found", "Repository agent sessions are unavailable.");
      }
      const rows = repoId
        ? await env.DB.prepare(
            sessionSelect +
              " WHERE s.user_id = ? AND s.repository_id = ? ORDER BY s.created_at DESC LIMIT 100"
          )
            .bind(user.id, repoId)
            .all<AgentSessionRow>()
        : await env.DB.prepare(
            sessionSelect + " WHERE s.user_id = ? ORDER BY s.created_at DESC LIMIT 100"
          )
            .bind(user.id)
            .all<AgentSessionRow>();
      return dataResponse(rows.results.map(sessionResponse));
    }
    if (parts.length === 1 && request.method === "GET") {
      const rows = await env.DB.prepare(
        agentSelect + " WHERE a.user_id = ? ORDER BY a.created_at DESC"
      )
        .bind(user.id)
        .all<AgentRow>();
      return dataResponse(
        rows.results.map((agent) => ({ ...agent, profilePublic: Boolean(agent.profilePublic) }))
      );
    }
    if (parts.length === 1 && request.method === "POST") {
      const parsed = CreateAgentInputSchema.safeParse(
        await readJsonLimited(request, SMALL_JSON_BYTES)
      );
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid agent payload.");
      const createdAt = Date.now();
      const id = crypto.randomUUID();
      const handle =
        parsed.data.handle ??
        (await availableHandle(env, user.id, readableHandle(parsed.data.name)));
      if (!handle)
        return errorResponse(409, "conflict", "Agent handle or account limit conflicts.");
      if (parsed.data.handle) {
        const occupied = await env.DB.prepare(
          "SELECT 1 AS found FROM auth_agents WHERE user_id = ? AND handle = ?"
        )
          .bind(user.id, handle)
          .first<{ found: number }>();
        if (occupied)
          return errorResponse(409, "conflict", "Agent handle or account limit conflicts.");
      }
      const result = await env.DB.prepare(
        "INSERT OR IGNORE INTO auth_agents (id,user_id,name,description,handle,profile_public,created_at,updated_at) SELECT ?,?,?,?,?,0,?,? WHERE (SELECT COUNT(*) FROM auth_agents WHERE user_id = ? AND disabled_at IS NULL) < 100"
      )
        .bind(
          id,
          user.id,
          parsed.data.name,
          parsed.data.description,
          handle,
          createdAt,
          createdAt,
          user.id
        )
        .run();
      if (result.meta.changes !== 1)
        return errorResponse(409, "conflict", "Agent handle or account limit conflicts.");
      const created = await loadManagedAgent(env, user.id, id);
      if (!created) throw new Error("Created agent was not readable.");
      logger.info("agent:created", { agentId: id, userId: user.id });
      return dataResponse(created, 201);
    }
    const agentId = parts[1];
    const agent = await env.DB.prepare(agentSelect + " WHERE a.id = ? AND a.user_id = ?")
      .bind(agentId ?? "", user.id)
      .first<AgentRow>();
    if (!agent) return errorResponse(404, "not_found", "Agent was not found.");
    const managedAgent: Agent = { ...agent, profilePublic: Boolean(agent.profilePublic) };
    const webhookResponse = await handleAgentWebhookManagement(request, env, user, agent.id);
    if (webhookResponse) return webhookResponse;
    if (parts.length === 2 && request.method === "GET") return dataResponse(managedAgent);
    if (parts.length === 2 && request.method === "PATCH") {
      const parsed = UpdateAgentInputSchema.safeParse(
        await readJsonLimited(request, SMALL_JSON_BYTES)
      );
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid agent payload.");
      const values = parsed.data;
      const handle = values.handle ?? agent.handle;
      if (values.handle && values.handle !== agent.handle) {
        const occupied = await env.DB.prepare(
          "SELECT 1 AS found FROM auth_agents WHERE user_id = ? AND handle = ? AND id != ?"
        )
          .bind(user.id, handle, agent.id)
          .first<{ found: number }>();
        if (occupied) return errorResponse(409, "conflict", "Agent handle is already in use.");
      }
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE auth_agents SET handle = ?, name = ?, description = ?, profile_public = ?, delivery_mode = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
        .bind(
          handle,
          values.name ?? agent.name,
          values.description ?? agent.description,
          Number(values.profilePublic ?? Boolean(agent.profilePublic)),
          values.deliveryMode ?? agent.deliveryMode,
          now,
          agent.id,
          user.id
        )
        .run();
      const updated = await loadManagedAgent(env, user.id, agent.id);
      return updated
        ? dataResponse(updated)
        : errorResponse(404, "not_found", "Agent was not found.");
    }
    if (parts.length === 2 && request.method === "DELETE") {
      await env.DB.prepare("UPDATE auth_agents SET disabled_at = ? WHERE id = ?")
        .bind(Date.now(), agent.id)
        .run();
      const sessions = await env.DB.prepare(
        sessionSelect + " WHERE s.agent_id = ? AND s.status = 'active'"
      )
        .bind(agent.id)
        .all<AgentSessionRow>();
      const failed = await revokeSessions(env, sessions.results, logger);
      if (failed > 0)
        return errorResponse(
          503,
          "service_unavailable",
          "Some agent sessions could not be revoked."
        );
      logger.info("agent:disabled", { agentId: agent.id, userId: user.id });
      return dataResponse({ disabled: true });
    }
    if (parts[2] !== "sessions") return errorResponse(404, "not_found", "Endpoint was not found.");
    if (parts.length === 3 && request.method === "GET") {
      const rows = await env.DB.prepare(
        sessionSelect + " WHERE s.agent_id = ? ORDER BY s.created_at DESC LIMIT 100"
      )
        .bind(agent.id)
        .all<AgentSessionRow>();
      return dataResponse(rows.results.map(sessionResponse));
    }
    if (parts.length === 5 && parts[4] === "renew" && request.method === "POST") {
      const parsed = RenewAgentSessionInputSchema.safeParse(
        (await readJsonLimited(request, SMALL_JSON_BYTES)) ?? {}
      );
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid renewal payload.");
      if (agent.disabledAt !== null) return errorResponse(409, "conflict", "Agent is disabled.");
      const row = await env.DB.prepare(sessionSelect + " WHERE s.id = ? AND s.agent_id = ?")
        .bind(parts[3], agent.id)
        .first<AgentSessionRow>();
      if (!row) return errorResponse(404, "not_found", "Session was not found.");
      const outcome = await renewAgentSession(env, row, parsed.data.ttlSeconds);
      return outcome.kind === "renewed" ? dataResponse(outcome.session) : renewalFailure(outcome);
    }
    if (parts.length === 4 && request.method === "DELETE") {
      const row = await env.DB.prepare(sessionSelect + " WHERE s.id = ? AND s.agent_id = ?")
        .bind(parts[3], agent.id)
        .first<AgentSessionRow>();
      if (!row) return errorResponse(404, "not_found", "Session was not found.");
      await revokeSession(env, row);
      logger.info("agent:session-revoked", { sessionId: row.id, agentId: agent.id });
      return dataResponse({ revoked: true });
    }
    if (parts.length !== 3 || request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    if (agent.disabledAt !== null) return errorResponse(409, "conflict", "Agent is disabled.");
    const parsed = CreateAgentSessionInputSchema.safeParse(
      await readJsonLimited(request, SMALL_JSON_BYTES)
    );
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid session payload.");
    const repository = await repositoryForOwner(env, user.id, parsed.data.repositoryId);
    if (!repository) return errorResponse(404, "not_found", "Repository was not found.");
    if (repository.agentsEnabled === 0)
      return errorResponse(404, "feature_disabled", "Repository agents are disabled.");
    if (!repository.writable && parsed.data.permission === "write")
      return errorResponse(403, "forbidden", "Repository write access is required.");
    if (repository.archived === 1 && parsed.data.permission === "write")
      return errorResponse(
        409,
        "repository_archived",
        "Archived repositories cannot issue write sessions."
      );
    if (!repository.artifactName)
      return errorResponse(
        409,
        "repository_storage_unavailable",
        "Repository must be imported to Artifacts."
      );
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_agent_sessions WHERE user_id = ? AND status = 'active' AND expires_at > ?"
    )
      .bind(user.id, Date.now())
      .first<{ count: number }>();
    if ((active?.count ?? 0) >= 100)
      return errorResponse(409, "conflict", "Session limit reached.");
    const id = crypto.randomUUID();
    const workspaceName = `session-${id}`;
    using source = await env.ARTIFACTS.get(repository.artifactName);
    const base = await source.log({ ref: parsed.data.baseRef, limit: 1 });
    const sourceInfo = await source.info();
    if (!base.length && sourceInfo.lastPushAt !== null)
      return errorResponse(409, "conflict", "Base branch was not found.");
    logger.debug("agent:session-fork-start", { repositoryId: repository.id, sessionId: id });
    const forked = await source.fork(workspaceName, {
      description: agent.name,
      readOnly: parsed.data.permission === "read",
    });
    using workspace = await env.ARTIFACTS.get(workspaceName);
    // The fork's initial write token must not outlive the scoped session credential.
    await workspace.revokeToken(forked.token);
    const gitToken = await workspace.createToken(parsed.data.permission, parsed.data.ttlSeconds);
    const token = newToken("ge_session_");
    const createdAt = Date.now();
    const created: CreatedAgentSession = {
      id,
      agentId: agent.id,
      agentName: agent.name,
      repositoryId: repository.id,
      workspaceName,
      remote: forked.remote,
      baseRef: parsed.data.baseRef,
      baseOid: base[0]?.hash ?? null,
      permission: parsed.data.permission,
      status: "active",
      createdAt,
      expiresAt: Date.parse(gitToken.expiresAt),
      maxExpiresAt: createdAt + AGENT_SESSION_MAX_LIFETIME_MS,
      renewalCount: 0,
      token,
      gitToken: gitToken.plaintext,
      instructions: null,
    };
    try {
      await env.DB.prepare(
        "INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)"
      )
        .bind(
          id,
          agent.id,
          user.id,
          repository.id,
          await sha256Hex(token),
          gitToken.id,
          workspaceName,
          forked.remote,
          created.baseRef,
          created.baseOid,
          created.permission,
          createdAt,
          created.expiresAt
        )
        .run();
    } catch {
      await workspace.revokeToken(gitToken.id);
      throw new Error("Session metadata write failed");
    }
    const instructions = await workspace.readFile({ ref: created.baseRef, path: "AGENTS.md" });
    if (instructions && instructions.size <= 100_000)
      created.instructions = await instructions.text();
    logger.info("agent:session-created", {
      agentId: agent.id,
      repositoryId: repository.id,
      sessionId: id,
    });
    return dataResponse(created, 201);
  } catch {
    logger.error("agent:operation-failed", { userId: user.id, resource: parts[0] });
    return errorResponse(
      503,
      "service_unavailable",
      "Agent operation failed; account changes remain visible for retry."
    );
  }
}

const CreateGitTokenInputSchema = z.object({
  repositoryId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  permission: z.enum(["read", "write"]).default("write"),
  ttlSeconds: z
    .number()
    .int()
    .min(300)
    .max(86_400 * 30)
    .default(86_400),
});
async function handleGitTokenManagement(
  request: Request,
  env: AgentAuthEnv,
  user: TrustedUser
): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length === 1 && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, repository_id AS repositoryId, name, permission, expires_at AS expiresAt, revoked_at AS revokedAt, created_at AS createdAt FROM auth_git_tokens WHERE user_id = ? ORDER BY created_at DESC"
    )
      .bind(user.id)
      .all();
    return dataResponse(rows.results);
  }
  if (parts.length === 2 && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE auth_git_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?"
    )
      .bind(Date.now(), parts[1], user.id)
      .run();
    return result.meta.changes
      ? dataResponse({ revoked: true })
      : errorResponse(404, "not_found", "Token was not found.");
  }
  if (parts.length !== 1 || request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const parsed = CreateGitTokenInputSchema.safeParse(
    await readJsonLimited(request, SMALL_JSON_BYTES)
  );
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid Git token payload.");
  const repository = await repositoryForOwner(env, user.id, parsed.data.repositoryId);
  if (!repository) return errorResponse(404, "not_found", "Repository was not found.");
  if (!repository.writable && parsed.data.permission === "write")
    return errorResponse(403, "forbidden", "Repository write access is required.");
  if (repository.archived === 1 && parsed.data.permission === "write")
    return errorResponse(
      409,
      "repository_archived",
      "Archived repositories cannot issue write credentials."
    );
  const token = newToken("ge_token_");
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + parsed.data.ttlSeconds * 1000;
  await env.DB.prepare(
    "INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      user.id,
      repository.id,
      parsed.data.name,
      await sha256Hex(token),
      parsed.data.permission,
      expiresAt,
      createdAt
    )
    .run();
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:git-token-created", {
    userId: user.id,
    repositoryId: repository.id,
    tokenId: id,
  });
  return dataResponse(
    {
      id,
      token,
      repositoryId: repository.id,
      name: parsed.data.name,
      permission: parsed.data.permission,
      createdAt,
      expiresAt,
    },
    201
  );
}

export async function handleAgentProfile(
  request: Request,
  env: AgentAuthEnv,
  viewer: TrustedUser | null
): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "agent-profiles" || request.method !== "GET")
    return errorResponse(404, "not_found", "Agent profile was not found.");
  const owner = parts[1];
  const handle = parts[2];
  const row = await env.DB.prepare(
    "SELECT u.identifier AS owner, a.handle, a.name, a.description, a.created_at AS createdAt, a.updated_at AS updatedAt, a.profile_public AS profilePublic, a.disabled_at AS disabledAt FROM auth_agents a JOIN users u ON u.id = a.user_id WHERE u.identifier = ? AND a.handle = ?"
  )
    .bind(owner, handle)
    .first<{
      owner: string;
      handle: string;
      name: string;
      description: string;
      createdAt: number;
      updatedAt: number;
      profilePublic: number;
      disabledAt: number | null;
    }>();
  if (!row || row.disabledAt !== null || (row.profilePublic !== 1 && viewer?.identifier !== owner))
    return errorResponse(404, "not_found", "Agent profile was not found.");
  return dataResponse({
    owner: row.owner,
    handle: row.handle,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
