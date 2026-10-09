import { z } from "zod";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import type { GitEnv } from "./access";

const FORKS_PER_CALL = 25;
const PurgeRequestSchema = z.object({ repositoryId: z.string().min(1) });

/**
 * Deletes the Artifacts repository and agent session forks of a soft-deleted repository.
 * Each call is bounded and idempotent; `complete` turns true once nothing is left to delete.
 */
export async function purgeRepositoryArtifacts(request: Request, env: GitEnv): Promise<Response> {
  const parsed = PurgeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid purge request.");
  const repositoryId = parsed.data.repositoryId;
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git", repoId: repositoryId });
  const repository = await env.DB.prepare(
    "SELECT artifact_name AS artifactName FROM repositories WHERE id = ? AND deleted_at IS NOT NULL AND purge_state = 'revoked'"
  )
    .bind(repositoryId)
    .first<{ artifactName: string | null }>();
  if (!repository) return errorResponse(404, "not_found", "Repository is not awaiting purge.");
  const forks = await env.DB.prepare(
    "SELECT id, workspace_name AS workspaceName FROM auth_agent_sessions WHERE repository_id = ? ORDER BY id LIMIT ?"
  )
    .bind(repositoryId, FORKS_PER_CALL + 1)
    .all<{ id: string; workspaceName: string }>();
  for (const fork of forks.results.slice(0, FORKS_PER_CALL)) {
    await env.ARTIFACTS.delete(fork.workspaceName);
    await env.DB.prepare("DELETE FROM auth_agent_sessions WHERE id = ?").bind(fork.id).run();
  }
  if (forks.results.length > FORKS_PER_CALL) {
    logger.info("artifacts:purge-partial", { deleted: FORKS_PER_CALL });
    return dataResponse({ complete: false });
  }
  if (repository.artifactName) await env.ARTIFACTS.delete(repository.artifactName);
  logger.info("artifacts:purged", { forks: forks.results.length });
  return dataResponse({ complete: true });
}
