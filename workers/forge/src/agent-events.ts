import {
  extractMentions,
  type AgentWebhookEvent,
  type RevokeAgentSessionsInput,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import type { ForgeEnv, RepositoryRow } from "./common";

export async function agentEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  agentId: string,
  event: AgentWebhookEvent,
  data: Record<string, unknown>
): Promise<void> {
  if (!env.AUTH || repository.agents_enabled === 0) return;
  try {
    const result = await env.AUTH.fetch(
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
    if (!result.ok) throw new Error("event_rejected");
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
): Promise<void> {
  if (!env.AUTH || repository.agents_enabled === 0) return;
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
  }
}

export async function pullRequestEvent(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  pullRequestId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!env.AUTH || repository.agents_enabled === 0) return;
  const agents = await env.DB.prepare(
    "SELECT assignee_id AS id FROM forge_assignments WHERE target_kind='pull_request' AND target_id=? AND assignee_kind='agent' UNION SELECT s.agent_id AS id FROM forge_pull_requests p JOIN auth_agent_sessions s ON s.id=p.head_session_id WHERE p.id=? LIMIT 21"
  )
    .bind(pullRequestId, pullRequestId)
    .all<{ id: string }>();
  if (agents.results.length > 20)
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("agent:pull-recipients-truncated", {
      pullRequestId,
    });
  for (const agent of agents.results.slice(0, 20))
    await agentEvent(env, repository, user, agent.id, "pull_request.updated", {
      ...data,
      pullRequestId,
    });
}
