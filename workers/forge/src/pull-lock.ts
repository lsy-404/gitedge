import { PullLockInputSchema, type TrustedUser } from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { acquireRefWrites, RefWriteBlocked } from "../../../src/worker/common/ref-writes";
import { createLogger } from "../../../src/worker/common/logger";
import { isMember, parseJson, type ForgeEnv, type RepositoryRow } from "./common";
import { loadPull } from "./merge-automation";
import { pullRequestHeadOid } from "./pull-git";

export async function pullLockRoute(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  if (parts[2] !== "pull-requests" || parts[4] !== "lock" || parts.length !== 5) return null;
  if (request.method !== "PUT") return errorResponse(405, "method_not_allowed", "Use PUT.");
  if (user.agentSession || user.token || !(await isMember(env, repository.id, user.id)))
    return errorResponse(
      403,
      "forbidden",
      "A repository writer must change the lock from a signed-in browser."
    );
  if (repository.archived)
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  const parsed = PullLockInputSchema.safeParse(await parseJson(request));
  if (!parsed.success)
    return errorResponse(400, "bad_request", "A lock state and current head are required.");
  const id = await env.DB.prepare(
    "SELECT id FROM forge_pull_requests WHERE repository_id = ? AND number = ?"
  )
    .bind(repository.id, Number(parts[3]))
    .first<{ id: string }>();
  const pull = id ? await loadPull(env, id.id) : null;
  if (!pull) return errorResponse(404, "not_found", "Pull request was not found.");
  if (pull.state !== "open")
    return errorResponse(409, "pull_closed", "Only open pull requests can be locked.");
  const source = await env.DB.prepare(
    `SELECT COALESCE(s.workspace_name, r.artifact_name) AS artifactName,
    s.git_token_id AS legacyToken FROM forge_pull_requests p
    JOIN repositories r ON r.id = COALESCE(p.head_repository_id, p.repository_id)
    LEFT JOIN auth_agent_sessions s ON s.id = p.head_session_id WHERE p.id = ?`
  )
    .bind(pull.id)
    .first<{ artifactName: string | null; legacyToken: string | null }>();
  if (!source?.artifactName)
    return errorResponse(409, "source_unavailable", "Source repository is unavailable.");
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });
  try {
    await using _lease = await acquireRefWrites(
      env.DB,
      source.artifactName,
      [`refs/heads/${pull.head_ref}`],
      true
    );
    if (source.legacyToken) {
      using workspace = await env.ARTIFACTS.get(source.artifactName);
      const revoked = await workspace.revokeToken(source.legacyToken);
      if (!revoked) {
        const tokens = await workspace.listTokens();
        if (
          tokens.tokens.some(
            (token) => token.id === source.legacyToken && token.state !== "revoked"
          )
        )
          return errorResponse(
            503,
            "credential_revoke_failed",
            "The source credential could not be revoked. Retry locking."
          );
      }
      const remoteUrl = new URL(`/${repository.owner}/${repository.slug}.git`, request.url);
      remoteUrl.username = String(pull.head_session_id);
      const remote = remoteUrl.toString();
      await env.DB.prepare(
        "UPDATE auth_agent_sessions SET git_token_id = '', remote = ? WHERE id = ? AND git_token_id = ?"
      )
        .bind(remote, pull.head_session_id, source.legacyToken)
        .run();
    }
    const head = await pullRequestHeadOid(env, request.url, repository, pull, user);
    if (head instanceof Response) return head;
    if (head !== parsed.data.expectedHeadOid)
      return errorResponse(
        409,
        "stale_commit",
        "The source changed. Refresh before changing its lock."
      );
    const now = Date.now();
    const changed = await env.DB.prepare(
      `UPDATE forge_pull_requests SET locked_at = ?, locked_by = ?, locked_head_oid = ?, updated_at = ?
      WHERE id = ? AND state = 'open' AND (merge_started_at IS NULL OR merge_started_at < ?)`
    )
      .bind(
        parsed.data.locked ? now : null,
        parsed.data.locked ? user.id : null,
        parsed.data.locked ? head : null,
        now,
        pull.id,
        now - 300_000
      )
      .run();
    if (changed.meta.changes !== 1)
      return errorResponse(409, "merge_in_progress", "Wait for the current merge to finish.");
    logger.info(parsed.data.locked ? "forge:pull-locked" : "forge:pull-unlocked", {
      pullRequestId: pull.id,
      headOid: head,
    });
    await recordAudit(env, {
      action: parsed.data.locked ? "pull_request.locked" : "pull_request.unlocked",
      actor: auditActor(user),
      target: { type: "pull_request", id: String(pull.id) },
      repositoryId: repository.id,
      metadata: { headOid: head },
    });
    return dataResponse({
      lockedAt: parsed.data.locked ? now : null,
      lockedBy: parsed.data.locked ? user.id : null,
      lockedHeadOid: parsed.data.locked ? head : null,
    });
  } catch (cause) {
    if (cause instanceof RefWriteBlocked) return errorResponse(409, cause.code, cause.message);
    logger.error("forge:pull-lock-failed", { pullRequestId: pull.id });
    return errorResponse(503, "lock_failed", "Unable to change the lock. Retry.");
  }
}
