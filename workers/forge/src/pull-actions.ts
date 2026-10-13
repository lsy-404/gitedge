import { trustedHeaders } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import type { ForgeEnv } from "./common";
import { actingUser } from "./merge-automation";

export async function triggerPullActions(env: ForgeEnv, pullRequestId: string): Promise<void> {
  if (!env.ACTIONS) return;
  const pull = await env.DB.prepare(
    "SELECT p.repository_id, p.author_id FROM forge_pull_requests p JOIN repositories r ON r.id = p.repository_id WHERE p.id = ? AND p.state = 'open' AND p.draft = 0 AND p.head_repository_id IS NULL AND r.deleted_at IS NULL AND r.archived = 0 AND r.actions_enabled = 1"
  )
    .bind(pullRequestId)
    .first<{ repository_id: string; author_id: string }>();
  if (!pull) return;
  const user = await actingUser(env, pull.author_id);
  if (!user) return;
  const headers = trustedHeaders(user);
  headers.set("Content-Type", "application/json");
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: pull.repository_id });
  try {
    const response = await env.ACTIONS.fetch(
      new Request("https://actions.internal/internal/pull-request", {
        method: "POST",
        headers,
        body: JSON.stringify({ repositoryId: pull.repository_id, pullRequestId }),
      })
    );
    if (!response.ok)
      logger.warn("forge:pull-actions-rejected", { pullRequestId, status: response.status });
    await response.body?.cancel();
  } catch {
    logger.warn("forge:pull-actions-unavailable", { pullRequestId });
  }
}
