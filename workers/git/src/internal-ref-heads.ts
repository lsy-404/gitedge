import {
  PushEventRefHeadInputSchema,
  type PushEventRefHeads,
} from "../../../packages/contracts/src/index";
import { errorResponse, dataResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import type { GitEnv } from "./access";
import { listArtifactRefs, resolveCommit } from "./read";

export async function handleInternalRefHeads(request: Request, env: GitEnv): Promise<Response> {
  if (new URL(request.url).hostname !== "git.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = PushEventRefHeadInputSchema.safeParse(await readJsonLimited(request, 64_000));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid ref head request.");
  const input = parsed.data;
  const now = Date.now();
  let artifactName: string | null;
  if (input.agentSessionId) {
    const session = await env.DB.prepare(
      "SELECT s.workspace_name AS artifactName FROM auth_agent_sessions s JOIN auth_agents a ON a.id = s.agent_id AND a.user_id = s.user_id JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL JOIN auth_git_tokens t ON t.id = s.git_token_id AND t.user_id = s.user_id AND t.repository_id = s.repository_id AND t.permission = s.permission WHERE s.id = ? AND s.repository_id = ? AND s.user_id = ? AND s.permission = 'write' AND s.status = 'active' AND s.expires_at > ? AND a.disabled_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > ? AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = s.repository_id AND r.deleted_at IS NULL AND r.archived = 0 AND r.agents_enabled = 1)"
    )
      .bind(input.agentSessionId, input.repositoryId, input.pusherId, now, now)
      .first<{ artifactName: string }>();
    if (!session || !writableRole(await repositoryRole(env.DB, input.repositoryId, input.pusherId)))
      return errorResponse(403, "forbidden", "Session ref is unavailable.");
    artifactName = session.artifactName;
  } else {
    const repository = await env.DB.prepare(
      "SELECT r.artifact_name AS artifactName FROM repositories r JOIN users u ON u.id = ? AND u.disabled_at IS NULL WHERE r.id = ? AND r.deleted_at IS NULL AND r.archived = 0"
    )
      .bind(input.pusherId, input.repositoryId)
      .first<{ artifactName: string | null }>();
    if (
      !repository ||
      !writableRole(await repositoryRole(env.DB, input.repositoryId, input.pusherId))
    )
      return errorResponse(403, "forbidden", "Repository ref is unavailable.");
    artifactName = repository.artifactName;
  }
  if (!artifactName)
    return errorResponse(
      409,
      "repository_storage_unavailable",
      "Repository storage is unavailable."
    );

  const logger = createLogger(env.LOG_LEVEL, {
    service: "git-ref-heads",
    repoId: input.repositoryId,
  });
  try {
    using repo = await env.ARTIFACTS.get(artifactName);
    const needsRefAdvertisement = input.updates.some(
      (update) => !update.ref.startsWith("refs/heads/")
    );
    const advertisedRefs = needsRefAdvertisement
      ? new Map((await listArtifactRefs(repo, env.LOG_LEVEL)).map((ref) => [ref.name, ref.oid]))
      : new Map<string, string>();
    const heads: PushEventRefHeads["heads"] = [];
    for (const update of input.updates) {
      if (update.ref.startsWith("refs/heads/")) {
        const commit = await resolveCommit(repo, update.ref);
        heads.push({ ref: update.ref, oid: commit?.hash ?? null });
      } else {
        heads.push({ ref: update.ref, oid: advertisedRefs.get(update.ref) ?? null });
      }
    }
    return dataResponse({ heads });
  } catch {
    logger.error("artifacts:ref-head-read-failed", {
      session: Boolean(input.agentSessionId),
      count: input.updates.length,
    });
    return errorResponse(503, "service_unavailable", "Current Git refs could not be read.");
  }
}
