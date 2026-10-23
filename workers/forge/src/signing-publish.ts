import { SigningPublishDispatchInputSchema } from "../../../packages/contracts/src/signing";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { createLogger } from "../../../src/worker/common/logger";
import { recordAudit } from "../../../src/worker/common/audit";
import { githubCredentials, type GithubConnectionRow } from "./github-sync-store";
import { GithubApiError, githubRepoPath, githubRequest } from "./github-client";
import type { ForgeEnv } from "./common";

/** Dispatches one workflow_dispatch event on behalf of the repository owner's GitHub connection. */
export async function signingPublishDispatch(request: Request, env: ForgeEnv): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "forge.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = SigningPublishDispatchInputSchema.safeParse(await readJsonLimited(request, 8192));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid publish dispatch.");
  const input = parsed.data;
  const logger = createLogger(env.LOG_LEVEL, { service: "signing-publish" });
  const [requestedOwner, requestedName] = input.fullName.split("/");
  const connection = await env.DB.prepare(
    `SELECT c.* FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id
     JOIN users u ON u.id=c.created_by
     WHERE c.github_repository_id=? AND c.owner=? COLLATE NOCASE AND c.name=? COLLATE NOCASE AND c.enabled=1 AND c.created_by=?
     AND p.deleted_at IS NULL AND p.archived=0 AND u.disabled_at IS NULL`
  )
    .bind(Number(input.githubRepositoryId), requestedOwner, requestedName, input.ownerId)
    .first<GithubConnectionRow>();
  if (
    !connection ||
    (await repositoryRole(env.DB, connection.repository_id, input.ownerId)) !== "admin"
  ) {
    logger.warn("signing-publish:connection-unavailable", {
      githubRepositoryId: input.githubRepositoryId,
    });
    return errorResponse(
      404,
      "github_connection_not_found",
      "No enabled GitHub connection owned by the signing owner matches the source repository."
    );
  }
  const { owner, name } = connection;
  try {
    const credentials = await githubCredentials(env, connection);
    await githubRequest(
      credentials.token,
      `${githubRepoPath(owner, name)}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
      "POST",
      { ref: input.ref, inputs: input.inputs }
    );
  } catch (cause) {
    const status = cause instanceof GithubApiError ? cause.status : null;
    const retryAfter = cause instanceof GithubApiError ? cause.retryAfter : 0;
    logger.warn("signing-publish:dispatch-failed", {
      githubRepositoryId: input.githubRepositoryId,
      workflow: input.workflow,
      status,
    });
    if (status === 403 && retryAfter === 0)
      return errorResponse(
        403,
        "github_dispatch_forbidden",
        "GitHub refused the dispatch. The connection token needs Actions read and write permission on the source repository."
      );
    if (status === 404)
      return errorResponse(
        404,
        "github_dispatch_not_found",
        "GitHub returned not found. Either the connection token lacks Actions write permission on the source repository, or the workflow file does not exist on that ref."
      );
    if (status !== null && status >= 300 && status < 400)
      return errorResponse(
        409,
        "github_dispatch_redirected",
        "GitHub redirected the dispatch, which usually means the source repository was renamed or moved. Update the GitHub connection and signing profile."
      );
    if (status === 422)
      return errorResponse(
        422,
        "github_dispatch_rejected",
        "GitHub rejected the dispatch. Check that the workflow exists, declares workflow_dispatch, accepts the inputs and the ref exists."
      );
    return errorResponse(503, "github_dispatch_unavailable", "The GitHub dispatch failed.");
  }
  await recordAudit(env, {
    action: "actions.signing_publish_dispatched",
    actor: { kind: "system", id: input.ownerId, name: "GitEdge signing", ref: null },
    target: { type: "github_workflow", id: input.workflow, label: input.fullName },
    repositoryId: connection.repository_id,
    subjectUserId: input.ownerId,
    metadata: { repository: input.fullName, workflow: input.workflow, ref: input.ref },
  });
  logger.info("signing-publish:dispatched", {
    githubRepositoryId: input.githubRepositoryId,
    workflow: input.workflow,
  });
  return dataResponse({ dispatched: true });
}
