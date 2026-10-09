import {
  RepositoryPurgeRequestSchema,
  type RepositoryPurgeResult,
} from "../../../packages/contracts/src/lifecycle";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import type { GitEnv } from "./access";

const FORKS_PER_CALL = 25;

/**
 * Deletes the agent session forks and then the Artifacts repository of a repository in purge.
 * Each call deletes at most FORKS_PER_CALL forks after the caller's cursor; Artifacts `delete`
 * returns false for missing repositories, so repeating a call is safe.
 */
export async function purgeRepositoryArtifacts(request: Request, env: GitEnv): Promise<Response> {
  const parsed = RepositoryPurgeRequestSchema.safeParse(
    await readJsonLimited(request, SMALL_JSON_BYTES)
  );
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid purge request.");
  const { repositoryId, after } = parsed.data;
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git", repoId: repositoryId });
  const repository = await env.DB.prepare(
    "SELECT artifact_name AS artifactName FROM repositories WHERE id = ? AND deleted_at IS NOT NULL AND purge_state = 'revoked'"
  )
    .bind(repositoryId)
    .first<{ artifactName: string | null }>();
  if (!repository) return errorResponse(404, "not_found", "Repository is not awaiting purge.");
  const forks = await env.DB.prepare(
    "SELECT id, workspace_name AS workspaceName FROM auth_agent_sessions WHERE repository_id = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?"
  )
    .bind(repositoryId, after, after, FORKS_PER_CALL + 1)
    .all<{ id: string; workspaceName: string }>();
  const batch = forks.results.slice(0, FORKS_PER_CALL);
  for (const fork of batch) await env.ARTIFACTS.delete(fork.workspaceName);
  const last = batch.at(-1);
  if (forks.results.length > FORKS_PER_CALL && last) {
    logger.info("artifacts:purge-partial", { deleted: batch.length });
    return dataResponse({ complete: false, next: last.id } satisfies RepositoryPurgeResult);
  }
  if (repository.artifactName) await env.ARTIFACTS.delete(repository.artifactName);
  logger.info("artifacts:purged", { forks: batch.length });
  return dataResponse({ complete: true, next: null } satisfies RepositoryPurgeResult);
}
