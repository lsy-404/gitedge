import { readJsonLimited } from "./http";
import {
  repositoryRole,
  writableRole,
  resolveRepositoryPath,
} from "../../../src/worker/common/repositories";
import { z } from "zod";
import {
  CreateAgentInputSchema,
  CreateAgentSessionInputSchema,
  sha256Hex,
  type Agent,
  UpdateAgentInputSchema,
  type AgentSession,
  type CreatedAgentSession,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { handleAgentWebhookManagement } from "./agent-webhooks";

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

const sessionSelect =
  "SELECT s.id, s.agent_id AS agentId, a.name AS agentName, s.repository_id AS repositoryId, s.workspace_name AS workspaceName, s.remote, s.base_ref AS baseRef, s.base_oid AS baseOid, s.permission, s.status, s.created_at AS createdAt, s.expires_at AS expiresAt, s.git_token_id AS gitTokenId, s.user_id AS userId, u.identifier, u.group_key AS groupKey FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id JOIN users u ON u.id = s.user_id";

function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
function fail(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function newToken(prefix: string): string {
  return (
    prefix +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  );
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
    "SELECT r.id,r.artifact_name AS artifactName,n.slug AS owner,r.slug,r.archived,r.agents_enabled AS agentsEnabled,0 AS writable FROM repositories r JOIN namespaces n ON n.id=r.namespace_id WHERE r.id=?"
  )
    .bind(repositoryId)
    .first<RepositoryRow>();
  return row ? { ...row, writable: writableRole(role) } : null;
}

const activeSessionSelect =
  sessionSelect +
  " JOIN repositories r ON r.id=s.repository_id LEFT JOIN namespace_memberships m ON m.namespace_id=r.namespace_id AND m.user_id=s.user_id LEFT JOIN repository_collaborators c ON c.repository_id=r.id AND c.user_id=s.user_id WHERE s.status='active' AND s.expires_at>? AND a.disabled_at IS NULL AND r.agents_enabled=1 AND (m.user_id IS NOT NULL OR c.role IN ('write','admin') OR (s.permission='read' AND c.role='read'))";

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

export async function authenticateGitToken(
  request: Request,
  env: AgentAuthEnv
): Promise<GitAuthentication | null> {
  const auth = request.headers.get("Authorization") ?? "";
  let token: string;
  let username: string | null = null;
  if (auth.startsWith("Bearer ")) token = auth.slice(7);
  else if (auth.startsWith("Basic ")) {
    try {
      const value = atob(auth.slice(6));
      const separator = value.indexOf(":");
      if (separator < 1) return null;
      username = value.slice(0, separator);
      token = value.slice(separator + 1);
    } catch {
      return null;
    }
  } else return null;
  const owner = new URL(request.url).searchParams.get("owner");
  const slug = new URL(request.url).searchParams.get("repo");
  if (!owner || !slug) return null;
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
    "SELECT t.repository_id AS repositoryId,t.permission,u.id,u.identifier,u.group_key AS groupKey FROM auth_git_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>? AND t.repository_id=?"
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
  const row = await env.DB.prepare(
    "SELECT a.id, u.identifier AS owner, a.handle, '/' || u.identifier || '/@' || a.handle AS profilePath, a.name, a.description, a.profile_public AS profilePublic, a.created_at AS createdAt, a.updated_at AS updatedAt, a.disabled_at AS disabledAt FROM auth_agents a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.user_id = ?"
  )
    .bind(agentId, userId)
    .first<AgentRow>();
  return row ? { ...row, profilePublic: Boolean(row.profilePublic) } : null;
}

async function revokeSession(env: AgentAuthEnv, row: AgentSessionRow): Promise<void> {
  await env.DB.prepare("UPDATE auth_agent_sessions SET status = 'revoked' WHERE id = ?")
    .bind(row.id)
    .run();
  using workspace = await env.ARTIFACTS.get(row.workspaceName);
  await workspace.revokeToken(row.gitTokenId);
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
    return fail(403, "forbidden", "Agent sessions cannot manage account credentials.");
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-auth" });
  try {
    if (parts[0] === "tokens") return await handleGitTokenManagement(request, env, user);
    if (parts[0] === "sessions" && parts.length === 1 && request.method === "GET") {
      const repoId = url.searchParams.get("repositoryId");
      if (repoId) {
        const repository = await repositoryForOwner(env, user.id, repoId);
        if (!repository || repository.agentsEnabled === 0)
          return fail(404, "not_found", "Repository agent sessions are unavailable.");
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
      return json(rows.results.map(sessionResponse));
    }
    if (parts.length === 1 && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT a.id, u.identifier AS owner, a.handle, '/' || u.identifier || '/@' || a.handle AS profilePath, a.name, a.description, a.profile_public AS profilePublic, a.created_at AS createdAt, a.updated_at AS updatedAt, a.disabled_at AS disabledAt FROM auth_agents a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? ORDER BY a.created_at DESC"
      )
        .bind(user.id)
        .all<AgentRow>();
      return json(
        rows.results.map((agent) => ({ ...agent, profilePublic: Boolean(agent.profilePublic) }))
      );
    }
    if (parts.length === 1 && request.method === "POST") {
      const parsed = CreateAgentInputSchema.safeParse(await readJsonLimited(request));
      if (!parsed.success) return fail(400, "bad_request", "Invalid agent payload.");
      const createdAt = Date.now();
      const id = crypto.randomUUID();
      const handle =
        parsed.data.handle ??
        (await availableHandle(env, user.id, readableHandle(parsed.data.name)));
      if (!handle) return fail(409, "conflict", "Agent handle or account limit conflicts.");
      if (parsed.data.handle) {
        const occupied = await env.DB.prepare(
          "SELECT 1 AS found FROM auth_agents WHERE user_id = ? AND handle = ?"
        )
          .bind(user.id, handle)
          .first<{ found: number }>();
        if (occupied) return fail(409, "conflict", "Agent handle or account limit conflicts.");
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
        return fail(409, "conflict", "Agent handle or account limit conflicts.");
      const created = await loadManagedAgent(env, user.id, id);
      if (!created) throw new Error("Created agent was not readable.");
      logger.info("agent:created", { agentId: id, userId: user.id });
      return json(created, 201);
    }
    const agentId = parts[1];
    const agent = await env.DB.prepare(
      "SELECT a.id, u.identifier AS owner, a.handle, '/' || u.identifier || '/@' || a.handle AS profilePath, a.name, a.description, a.profile_public AS profilePublic, a.created_at AS createdAt, a.updated_at AS updatedAt, a.disabled_at AS disabledAt FROM auth_agents a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.user_id = ?"
    )
      .bind(agentId ?? "", user.id)
      .first<AgentRow>();
    if (!agent) return fail(404, "not_found", "Agent was not found.");
    const managedAgent: Agent = { ...agent, profilePublic: Boolean(agent.profilePublic) };
    const webhookResponse = await handleAgentWebhookManagement(request, env, user, agent.id);
    if (webhookResponse) return webhookResponse;
    if (parts.length === 2 && request.method === "GET") return json(managedAgent);
    if (parts.length === 2 && request.method === "PATCH") {
      const parsed = UpdateAgentInputSchema.safeParse(await readJsonLimited(request));
      if (!parsed.success) return fail(400, "bad_request", "Invalid agent payload.");
      const values = parsed.data;
      const handle = values.handle ?? agent.handle;
      if (values.handle && values.handle !== agent.handle) {
        const occupied = await env.DB.prepare(
          "SELECT 1 AS found FROM auth_agents WHERE user_id = ? AND handle = ? AND id != ?"
        )
          .bind(user.id, handle, agent.id)
          .first<{ found: number }>();
        if (occupied) return fail(409, "conflict", "Agent handle is already in use.");
      }
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE auth_agents SET handle = ?, name = ?, description = ?, profile_public = ?, updated_at = ? WHERE id = ? AND user_id = ?"
      )
        .bind(
          handle,
          values.name ?? agent.name,
          values.description ?? agent.description,
          Number(values.profilePublic ?? Boolean(agent.profilePublic)),
          now,
          agent.id,
          user.id
        )
        .run();
      const updated = await loadManagedAgent(env, user.id, agent.id);
      return updated ? json(updated) : fail(404, "not_found", "Agent was not found.");
    }
    if (parts.length === 2 && request.method === "DELETE") {
      await env.DB.prepare("UPDATE auth_agents SET disabled_at = ? WHERE id = ?")
        .bind(Date.now(), agent.id)
        .run();
      const sessions = await env.DB.prepare(
        sessionSelect + " WHERE s.agent_id = ? AND s.status != 'completed'"
      )
        .bind(agent.id)
        .all<AgentSessionRow>();
      for (const row of sessions.results) await revokeSession(env, row);
      logger.info("agent:disabled", { agentId: agent.id, userId: user.id });
      return json({ disabled: true });
    }
    if (parts[2] !== "sessions") return fail(404, "not_found", "Endpoint was not found.");
    if (parts.length === 3 && request.method === "GET") {
      const rows = await env.DB.prepare(
        sessionSelect + " WHERE s.agent_id = ? ORDER BY s.created_at DESC LIMIT 100"
      )
        .bind(agent.id)
        .all<AgentSessionRow>();
      return json(rows.results.map(sessionResponse));
    }
    if (parts.length === 4 && request.method === "DELETE") {
      const row = await env.DB.prepare(sessionSelect + " WHERE s.id = ? AND s.agent_id = ?")
        .bind(parts[3], agent.id)
        .first<AgentSessionRow>();
      if (!row) return fail(404, "not_found", "Session was not found.");
      await revokeSession(env, row);
      logger.info("agent:session-revoked", { sessionId: row.id, agentId: agent.id });
      return json({ revoked: true });
    }
    if (parts.length !== 3 || request.method !== "POST")
      return fail(405, "method_not_allowed", "Method is not allowed.");
    if (agent.disabledAt !== null) return fail(409, "conflict", "Agent is disabled.");
    const parsed = CreateAgentSessionInputSchema.safeParse(await readJsonLimited(request));
    if (!parsed.success) return fail(400, "bad_request", "Invalid session payload.");
    const repository = await repositoryForOwner(env, user.id, parsed.data.repositoryId);
    if (!repository) return fail(404, "not_found", "Repository was not found.");
    if (repository.agentsEnabled === 0)
      return fail(404, "feature_disabled", "Repository agents are disabled.");
    if (!repository.writable && parsed.data.permission === "write")
      return fail(403, "forbidden", "Repository write access is required.");
    if (repository.archived === 1 && parsed.data.permission === "write")
      return fail(409, "repository_archived", "Archived repositories cannot issue write sessions.");
    if (!repository.artifactName)
      return fail(
        409,
        "repository_storage_unavailable",
        "Repository must be imported to Artifacts."
      );
    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_agent_sessions WHERE user_id = ? AND status = 'active' AND expires_at > ?"
    )
      .bind(user.id, Date.now())
      .first<{ count: number }>();
    if ((active?.count ?? 0) >= 100) return fail(409, "conflict", "Session limit reached.");
    const id = crypto.randomUUID();
    const workspaceName = `session-${id}`;
    using source = await env.ARTIFACTS.get(repository.artifactName);
    const base = await source.log({ ref: parsed.data.baseRef, limit: 1 });
    const sourceInfo = await source.info();
    if (!base.length && sourceInfo.lastPushAt !== null)
      return fail(409, "conflict", "Base branch was not found.");
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
    return json(created, 201);
  } catch {
    logger.error("agent:operation-failed", { userId: user.id, resource: parts[0] });
    return fail(
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
    return json(rows.results);
  }
  if (parts.length === 2 && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE auth_git_tokens SET revoked_at = ? WHERE id = ? AND user_id = ?"
    )
      .bind(Date.now(), parts[1], user.id)
      .run();
    return result.meta.changes
      ? json({ revoked: true })
      : fail(404, "not_found", "Token was not found.");
  }
  if (parts.length !== 1 || request.method !== "POST")
    return fail(405, "method_not_allowed", "Method is not allowed.");
  const parsed = CreateGitTokenInputSchema.safeParse(await readJsonLimited(request));
  if (!parsed.success) return fail(400, "bad_request", "Invalid Git token payload.");
  const repository = await repositoryForOwner(env, user.id, parsed.data.repositoryId);
  if (!repository) return fail(404, "not_found", "Repository was not found.");
  if (!repository.writable && parsed.data.permission === "write")
    return fail(403, "forbidden", "Repository write access is required.");
  if (repository.archived === 1 && parsed.data.permission === "write")
    return fail(
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
  return json(
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
    return fail(404, "not_found", "Agent profile was not found.");
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
    return fail(404, "not_found", "Agent profile was not found.");
  return json({
    owner: row.owner,
    handle: row.handle,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
