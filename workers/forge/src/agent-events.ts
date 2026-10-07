import type { AgentWebhookEvent, TrustedUser } from "../../../packages/contracts/src/index";
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

export type AgentSessionRevocationScope =
  | { readonly repositoryId: string; readonly userId?: string }
  | { readonly namespaceId: string; readonly userId: string };

export async function revokeAgentSessions(
  env: ForgeEnv,
  scope: AgentSessionRevocationScope
): Promise<void> {
  if (!env.AUTH) return;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  try {
    const result = await env.AUTH.fetch(
      new Request("https://auth.internal/_internal/agent-sessions/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scope),
      })
    );
    await result.body?.cancel();
    if (!result.ok) logger.warn("agent:session-revocation-rejected", { status: result.status });
  } catch {
    logger.warn("agent:session-revocation-failed", scope);
  }
}

export async function mentionAgents(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  body: string,
  target: Record<string, unknown>
): Promise<void> {
  if (!env.AUTH || repository.agents_enabled === 0) return;
  const mentions = [...body.matchAll(/\b([a-z0-9][a-z0-9-]{2,62})\/@([a-z0-9][a-z0-9-]{0,39})\b/g)];
  const unique = new Map(mentions.map((match) => [`${match[1]}/${match[2]}`, match]));
  if (unique.size > 10)
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("agent:mentions-truncated", {
      count: unique.size,
    });
  for (const [, match] of [...unique].slice(0, 10)) {
    const agent = await env.DB.prepare(
      "SELECT a.id, a.user_id AS ownerId FROM auth_agents a JOIN users u ON u.id=a.user_id WHERE u.identifier=? AND a.handle=? AND a.disabled_at IS NULL"
    )
      .bind(match[1], match[2])
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
