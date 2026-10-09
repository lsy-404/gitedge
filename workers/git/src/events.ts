import {
  trustedHeaders,
  type PushEventInput,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import type { GitEnv } from "./access";
import { resolveCommit } from "./read";

export async function recordGitWrite(
  env: GitEnv,
  repositoryId: string,
  artifactName: string,
  user: TrustedUser,
  ref: string,
  oid: string
): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "git-events", repoId: repositoryId });
  try {
    using repo = await env.ARTIFACTS.get(artifactName);
    if ((await resolveCommit(repo, ref))?.hash !== oid) return;
    await env.DB.prepare("UPDATE repositories SET updated_at=? WHERE id=?")
      .bind(Date.now(), repositoryId)
      .run();
    if (!env.ACTIONS || user.agentSession) return;
    const flags = await env.DB.prepare(
      "SELECT actions_enabled, archived FROM repositories WHERE id=?"
    )
      .bind(repositoryId)
      .first<{ actions_enabled: number; archived: number }>();
    if (flags?.actions_enabled !== 1 || flags.archived !== 0) return;
    const headers = trustedHeaders(user);
    headers.set("Content-Type", "application/json");
    const response = await env.ACTIONS.fetch(
      new Request("https://actions.internal/internal/push", {
        method: "POST",
        headers,
        body: JSON.stringify({ repositoryId, ref, expectedOid: oid }),
      })
    );
    if (!response.ok)
      logger.warn("actions:push-trigger-failed", { ref, oid, status: response.status });
    await response.body?.cancel();
  } catch {
    logger.error("git:write-event-failed", { ref, oid });
  }
}

/** Tells Forge which refs changed so it can queue repository webhook deliveries. */
export async function reportPushEvent(
  env: GitEnv,
  repositoryId: string,
  user: TrustedUser,
  updates: PushEventInput["updates"]
): Promise<void> {
  if (!env.FORGE || user.agentSession || updates.length === 0) return;
  const logger = createLogger(env.LOG_LEVEL, { service: "git-events", repoId: repositoryId });
  try {
    const input: PushEventInput = { repositoryId, pusherId: user.id, updates };
    const response = await env.FORGE.fetch(
      new Request("https://forge.internal/internal/push-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    );
    if (!response.ok) logger.warn("webhooks:push-report-failed", { status: response.status });
    await response.body?.cancel();
  } catch {
    logger.error("webhooks:push-report-error", { count: updates.length });
  }
}
