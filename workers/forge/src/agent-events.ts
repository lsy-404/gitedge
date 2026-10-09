import {
  agentEventData,
  extractMentions,
  type AgentWebhookEvent,
  type RevokeAgentSessionsInput,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { agentDeliveryMode, appendFeedEvent } from "./agent-feed";
import type { ForgeEnv, RepositoryRow } from "./common";

/**
 * Routes one event to the agent's chosen channels: the signed webhook outbox owned by Auth, the
 * pull feed, or both. Delivery failures are logged and never fail the originating write.
 */
export async function agentEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id">,
  agentId: string,
  event: AgentWebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (repository.agents_enabled === 0) return;
  const mode = await agentDeliveryMode(env, agentId);
  if (mode === null) return;
  if (mode !== "pull" && env.AUTH)
    await queueWebhookEvent(env, repository, user, agentId, event, data);
  if (mode !== "webhook")
    await appendFeedEvent(
      env,
      repository,
      agentId,
      event,
      agentEventData(data, repository.id, agentId)
    );
}

async function queueWebhookEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id">,
  agentId: string,
  event: AgentWebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const result = await env.AUTH?.fetch(
      new Request("https://auth.internal/_internal/agent-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          repositoryId: repository.id,
          actorUserId: user.id,
          event,
          data,
        }),
      })
    );
    if (!result?.ok) throw new Error("event_rejected");
    await result.body?.cancel();
  } catch {
    createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id }).warn(
      "agent:event-queue-failed",
      { agentId, event }
    );
  }
}

const REVOCATION_ATTEMPTS = 5;

/** Returns true only when Auth confirms no active session remains in scope. */
export async function revokeAgentSessions(
  env: ForgeEnv,
  scope: RevokeAgentSessionsInput
): Promise<boolean> {
  if (!env.AUTH) return true;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  for (let attempt = 1; attempt <= REVOCATION_ATTEMPTS; attempt += 1) {
    try {
      const result = await env.AUTH.fetch(
        new Request("https://auth.internal/_internal/agent-sessions/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scope),
        })
      );
      await result.body?.cancel();
      if (result.ok) return true;
      logger.warn("agent:session-revocation-rejected", { status: result.status, attempt });
    } catch {
      logger.warn("agent:session-revocation-failed", { attempt });
    }
  }
  logger.error("agent:session-revocation-incomplete", scope);
  return false;
}

export async function mentionAgents(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  body: string,
  target: Record<string, unknown>
): Promise<Set<string>> {
  const notified = new Set<string>();
  if (repository.agents_enabled === 0) return notified;
  const { agents: mentions } = extractMentions(body);
  if (mentions.length > 10)
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("agent:mentions-truncated", {
      count: mentions.length,
    });
  for (const match of mentions.slice(0, 10)) {
    const agent = await env.DB.prepare(
      "SELECT a.id, a.user_id AS ownerId FROM auth_agents a JOIN users u ON u.id=a.user_id WHERE u.identifier=? AND a.handle=? AND a.disabled_at IS NULL"
    )
      .bind(match.owner, match.handle)
      .first<{ id: string; ownerId: string }>();
    if (!agent) continue;
    if ((await repositoryRole(env.DB, repository.id, agent.ownerId)) === null) {
      createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id }).debug(
        "agent:mention-ignored-no-access",
        { agentId: agent.id }
      );
      continue;
    }
    await agentEvent(env, repository, user, agent.id, "agent.mentioned", target);
    notified.add(agent.id);
  }
  return notified;
}

/** Agents working on a pull request: its agent assignees and the agent whose session owns the head. */
async function pullRequestAgents(env: ForgeEnv, pullRequestId: string): Promise<string[]> {
  const agents = await env.DB.prepare(
    "SELECT assignee_id AS id FROM forge_assignments WHERE target_kind='pull_request' AND target_id=? AND assignee_kind='agent' UNION SELECT s.agent_id AS id FROM forge_pull_requests p JOIN auth_agent_sessions s ON s.id=p.head_session_id WHERE p.id=? LIMIT 21"
  )
    .bind(pullRequestId, pullRequestId)
    .all<{ id: string }>();
  if (agents.results.length > 20)
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("agent:pull-recipients-truncated", {
      pullRequestId,
    });
  return agents.results.slice(0, 20).map((agent) => agent.id);
}

/**
 * Notifies the agents of a pull request. Events caused by an agent's own session skip that agent
 * unless `includeActor` is set, so state changes are still announced to the agent that made them.
 */
export async function pullRequestEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: Pick<TrustedUser, "id"> & Partial<Pick<TrustedUser, "agentSession">>,
  pullRequestId: string,
  data: Record<string, unknown>,
  event: AgentWebhookEvent = "pull_request.updated"
): Promise<void> {
  if (repository.agents_enabled === 0) return;
  const skip = event === "pull_request.updated" ? undefined : user.agentSession?.agentId;
  for (const agentId of await pullRequestAgents(env, pullRequestId))
    if (agentId !== skip)
      await agentEvent(env, repository, user, agentId, event, { ...data, pullRequestId });
}

/** Announces a new comment to the agents assigned to its issue or pull request. */
export async function commentEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  target: { kind: "issue" | "pull_request" | "discussion"; id: string; number: number },
  commentId: string,
  alreadyNotified: ReadonlySet<string>
): Promise<void> {
  if (repository.agents_enabled === 0 || target.kind === "discussion") return;
  const agents =
    target.kind === "pull_request"
      ? await pullRequestAgents(env, target.id)
      : (
          await env.DB.prepare(
            "SELECT assignee_id AS id FROM forge_assignments WHERE target_kind='issue' AND target_id=? AND assignee_kind='agent' LIMIT 20"
          )
            .bind(target.id)
            .all<{ id: string }>()
        ).results.map((agent) => agent.id);
  for (const agentId of agents) {
    if (agentId === user.agentSession?.agentId || alreadyNotified.has(agentId)) continue;
    await agentEvent(env, repository, user, agentId, "comment.created", {
      targetKind: target.kind,
      targetId: target.id,
      number: target.number,
      commentId,
    });
  }
}
