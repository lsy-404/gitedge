import { z } from "zod";
import {
  ConfirmationInputSchema,
  REPOSITORY_RESTORE_WINDOW_MS,
  RepositoryPurgeResultSchema,
  TransferRepositoryInputSchema,
  type RepositoryPurgeRequest,
  type RepositoryPurgeResult,
  type DeletedRepository,
  type Repository,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import {
  dataResponse,
  errorResponse,
  jsonResponse,
  requireRecentAuth,
} from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { revokeAgentSessions } from "./agent-events";
import { purgeReleaseAssets } from "./releases";
import { parseJson, repoResponse, type ForgeEnv, type RepositoryRow } from "./common";

const MAX_DELETED_LISTING = 100;
const PURGE_BATCH = 5;
const GIT_PURGE_CALLS = 4;
const PURGE_RETRY_DELAY_MS = 60 * 60 * 1000;
const GitPurgeResponseSchema = z.object({ data: RepositoryPurgeResultSchema });

type NamespaceTarget = { id: string; slug: string; kind: "personal" | "organization" };
type DeletedRow = {
  id: string;
  owner: string;
  name: string;
  namespaceId: string;
  deletedAt: number;
  purgeAfter: number;
  deletedBy: string | null;
  purgeState: string | null;
};

function fullName(repository: Pick<RepositoryRow, "owner" | "slug">): string {
  return `${repository.owner}/${repository.slug}`;
}

async function confirmed(request: Request, expected: string): Promise<boolean> {
  const parsed = ConfirmationInputSchema.safeParse(await parseJson(request));
  return parsed.success && parsed.data.confirm === expected;
}

function confirmationMismatch(): Response {
  return errorResponse(
    400,
    "confirmation_mismatch",
    "The confirmation text does not match the expected name."
  );
}

/** Namespace-level owner: the personal account's creator or an organization owner. */
async function namespaceOwner(
  env: ForgeEnv,
  namespaceId: string,
  userId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT role FROM namespace_memberships WHERE namespace_id = ? AND user_id = ?"
  )
    .bind(namespaceId, userId)
    .first<{ role: string }>();
  return row?.role === "owner";
}

async function transferTarget(
  env: ForgeEnv,
  slug: string,
  user: TrustedUser
): Promise<NamespaceTarget | null> {
  return env.DB.prepare(
    "SELECT n.id, n.slug, n.kind FROM namespaces n JOIN namespace_memberships m ON m.namespace_id = n.id AND m.user_id = ? AND m.role = 'owner' WHERE n.slug = ?"
  )
    .bind(user.id, slug)
    .first<NamespaceTarget>();
}

/** Soft delete and ownership transfer of a live repository the viewer can already read. */
export async function repositoryLifecycle(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  const isDelete = request.method === "DELETE" && parts.length === 2;
  const isTransfer = request.method === "POST" && parts.length === 3 && parts[2] === "transfer";
  if (!isDelete && !isTransfer) return null;
  if (user.agentSession || (await repositoryRole(env.DB, repository.id, user.id)) !== "admin")
    return errorResponse(403, "forbidden", "Repository administrator access is required.");
  const logger = createLogger(env.LOG_LEVEL, {
    service: "repository-lifecycle",
    repoId: repository.id,
  });

  if (isDelete) {
    const reauth = requireRecentAuth(user);
    if (reauth) return reauth;
    if (!(await confirmed(request, fullName(repository)))) return confirmationMismatch();
    const now = Date.now();
    const purgeAfter = now + REPOSITORY_RESTORE_WINDOW_MS;
    const [marked] = await env.DB.batch([
      env.DB.prepare(
        "UPDATE repositories SET deleted_at = ?, deleted_by = ?, deleted_slug = slug, purge_after = ?, purge_state = NULL, slug = 'deleted~' || id, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING id"
      ).bind(now, user.id, purgeAfter, now, repository.id),
      env.DB.prepare(
        "DELETE FROM repository_paths WHERE repository_id = ? AND slug != 'deleted~' || ?"
      ).bind(repository.id, repository.id),
    ]);
    if (marked.results.length !== 1)
      return errorResponse(404, "not_found", "Repository was not found.");
    // Session forks hold direct Artifacts credentials, so they must not outlive the deletion.
    const revoked = await revokeAgentSessions(env, { repositoryId: repository.id });
    logger.info("lifecycle:repository-deleted", { userId: user.id, purgeAfter, revoked });
    return dataResponse({
      deletedAt: now,
      purgeAfter,
      ...(revoked ? {} : { revocationIncomplete: true }),
    });
  }

  const parsed = TransferRepositoryInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid transfer payload.");
  if (parsed.data.confirm !== fullName(repository)) return confirmationMismatch();
  if (!(await namespaceOwner(env, repository.namespace_id, user.id)))
    return errorResponse(403, "forbidden", "Only the current owner can transfer a repository.");
  const reauth = requireRecentAuth(user);
  if (reauth) return reauth;
  const target = await transferTarget(env, parsed.data.owner, user);
  if (!target)
    return errorResponse(
      403,
      "forbidden",
      "The target must be your own account or an organization you own."
    );
  if (target.id === repository.namespace_id)
    return errorResponse(400, "bad_request", "The repository already belongs to this owner.");
  const taken = await env.DB.prepare(
    "SELECT 1 AS found FROM repository_paths WHERE namespace_id = ? AND slug = ? AND repository_id != ?"
  )
    .bind(target.id, repository.slug, repository.id)
    .first<{ found: number }>();
  if (taken)
    return errorResponse(409, "conflict", "The target already has a repository with this name.");
  const now = Date.now();
  try {
    const moved = await env.DB.prepare(
      "UPDATE repositories SET namespace_id = ?, updated_at = ? WHERE id = ? AND namespace_id = ? AND deleted_at IS NULL RETURNING id"
    )
      .bind(target.id, now, repository.id, repository.namespace_id)
      .first<{ id: string }>();
    if (!moved)
      return errorResponse(409, "conflict", "The repository changed during the transfer.");
  } catch {
    logger.warn("lifecycle:transfer-conflict", { targetId: target.id });
    return errorResponse(409, "conflict", "The target already has a repository with this name.");
  }
  // Sessions were scoped to the previous owner's membership, so they end with the transfer.
  const revoked = await revokeAgentSessions(env, { repositoryId: repository.id });
  logger.info("lifecycle:repository-transferred", {
    userId: user.id,
    from: repository.namespace_id,
    to: target.id,
    revoked,
  });
  const transferred = repoResponse(
    { ...repository, namespace_id: target.id, owner: target.slug, updated_at: now },
    "admin",
    true
  ) satisfies Repository;
  return dataResponse({ ...transferred, ...(revoked ? {} : { revocationIncomplete: true }) });
}

function presentDeleted(row: DeletedRow): DeletedRepository {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    deletedAt: row.deletedAt,
    purgeAfter: row.purgeAfter,
    deletedBy: row.deletedBy,
    purging: row.purgeState !== null,
  };
}

const deletedSelect =
  "SELECT r.id, n.slug AS owner, r.deleted_slug AS name, r.namespace_id AS namespaceId, r.deleted_at AS deletedAt, r.purge_after AS purgeAfter, u.identifier AS deletedBy, r.purge_state AS purgeState FROM repositories r JOIN namespaces n ON n.id = r.namespace_id LEFT JOIN users u ON u.id = r.deleted_by LEFT JOIN namespace_memberships m ON m.namespace_id = r.namespace_id AND m.user_id = ? LEFT JOIN repository_collaborators c ON c.repository_id = r.id AND c.user_id = ? WHERE r.deleted_at IS NOT NULL AND (m.role = 'owner' OR c.role = 'admin')";

/** Recently deleted repositories visible to administrators, with restore and purge-now. */
export async function deletedRepositories(
  env: ForgeEnv,
  request: Request,
  user: TrustedUser,
  parts: string[]
): Promise<Response> {
  if (user.agentSession)
    return errorResponse(403, "forbidden", "Agent sessions cannot manage deleted repositories.");
  const logger = createLogger(env.LOG_LEVEL, { service: "repository-lifecycle" });
  if (request.method === "GET" && parts.length === 1) {
    const rows = await env.DB.prepare(`${deletedSelect} ORDER BY r.deleted_at DESC LIMIT ?`)
      .bind(user.id, user.id, MAX_DELETED_LISTING + 1)
      .all<DeletedRow>();
    return jsonResponse({
      data: rows.results.slice(0, MAX_DELETED_LISTING).map(presentDeleted),
      truncated: rows.results.length > MAX_DELETED_LISTING,
    });
  }
  const id = parts[1];
  if (!id || parts.length > 3) return errorResponse(404, "not_found", "Endpoint was not found.");
  const row = await env.DB.prepare(`${deletedSelect} AND r.id = ?`)
    .bind(user.id, user.id, id)
    .first<DeletedRow>();
  if (!row) return errorResponse(404, "not_found", "Deleted repository was not found.");

  if (request.method === "POST" && parts[2] === "restore") {
    const now = Date.now();
    if (row.purgeState !== null || row.purgeAfter <= now)
      return errorResponse(409, "conflict", "The restore window has closed.");
    const taken = await env.DB.prepare(
      "SELECT 1 AS found FROM repository_paths WHERE namespace_id = ? AND slug = ?"
    )
      .bind(row.namespaceId, row.name)
      .first<{ found: number }>();
    if (taken) return errorResponse(409, "conflict", "Another repository now uses this name.");
    try {
      const [restored] = await env.DB.batch([
        env.DB.prepare(
          "UPDATE repositories SET slug = deleted_slug, deleted_at = NULL, deleted_by = NULL, deleted_slug = NULL, purge_after = NULL, purge_cursor = NULL, purge_retry_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL AND purge_state IS NULL AND purge_after > ? RETURNING id"
        ).bind(now, id, now),
        env.DB.prepare(
          "DELETE FROM repository_paths WHERE repository_id = ? AND slug = 'deleted~' || ?"
        ).bind(id, id),
      ]);
      if (restored.results.length !== 1)
        return errorResponse(409, "conflict", "The restore window has closed.");
    } catch {
      logger.warn("lifecycle:restore-conflict", { repositoryId: id });
      return errorResponse(409, "conflict", "Another repository now uses this name.");
    }
    logger.info("lifecycle:repository-restored", { repositoryId: id, userId: user.id });
    const restored = await env.DB.prepare(
      "SELECT repositories.*, namespaces.slug AS owner FROM repositories JOIN namespaces ON namespaces.id = repositories.namespace_id WHERE repositories.id = ?"
    )
      .bind(id)
      .first<RepositoryRow>();
    if (!restored) return errorResponse(404, "not_found", "Repository was not found.");
    return dataResponse(repoResponse(restored, "admin", true) satisfies Repository);
  }

  if (request.method === "DELETE" && parts.length === 2) {
    const reauth = requireRecentAuth(user);
    if (reauth) return reauth;
    if (!(await confirmed(request, `${row.owner}/${row.name}`))) return confirmationMismatch();
    const now = Date.now();
    const expedited = await env.DB.prepare(
      "UPDATE repositories SET purge_after = MIN(purge_after, ?) WHERE id = ? AND deleted_at IS NOT NULL"
    )
      .bind(now, id)
      .run();
    if (expedited.meta.changes !== 1)
      return errorResponse(404, "not_found", "Deleted repository was not found.");
    logger.info("lifecycle:repository-purge-requested", { repositoryId: id, userId: user.id });
    const purged = await attemptPurge(env, id, now);
    return dataResponse({ purged }, purged ? 200 : 202);
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
}

/** Deletes a user-owned organization that no longer holds any repository rows. */
export async function deleteOrganization(
  env: ForgeEnv,
  request: Request,
  organization: { id: string; slug: string },
  user: TrustedUser
): Promise<Response> {
  const reauth = requireRecentAuth(user);
  if (reauth) return reauth;
  if (!(await confirmed(request, organization.slug))) return confirmationMismatch();
  const logger = createLogger(env.LOG_LEVEL, { service: "repository-lifecycle" });
  const removed = await env.DB.prepare(
    "DELETE FROM namespaces WHERE id = ? AND kind = 'organization' AND NOT EXISTS (SELECT 1 FROM repositories WHERE namespace_id = ?) RETURNING id"
  )
    .bind(organization.id, organization.id)
    .first<{ id: string }>();
  if (!removed) {
    logger.info("lifecycle:organization-delete-blocked", { organizationId: organization.id });
    return errorResponse(
      409,
      "organization_not_empty",
      "Transfer or delete every repository, and wait for deleted repositories to be purged, before deleting the organization."
    );
  }
  logger.info("lifecycle:organization-deleted", {
    organizationId: organization.id,
    userId: user.id,
  });
  return new Response(null, { status: 204 });
}

async function requestArtifactsPurge(
  env: ForgeEnv,
  repositoryId: string,
  after: string | null
): Promise<RepositoryPurgeResult | null> {
  const response = await env.GIT.fetch(
    new Request("https://git.internal/internal/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryId, after } satisfies RepositoryPurgeRequest),
    })
  );
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const parsed = GitPurgeResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data.data : null;
}

/**
 * Advances one soft-deleted repository through revoke, Artifacts deletion and row removal.
 * Progress is persisted in purge_state and purge_cursor so interrupted runs resume without
 * repeating work.
 */
export async function purgeRepository(env: ForgeEnv, repositoryId: string): Promise<boolean> {
  const logger = createLogger(env.LOG_LEVEL, { service: "repository-purge", repoId: repositoryId });
  const read = () =>
    env.DB.prepare(
      "SELECT purge_state AS state, purge_cursor AS cursor FROM repositories WHERE id = ? AND deleted_at IS NOT NULL"
    )
      .bind(repositoryId)
      .first<{ state: string | null; cursor: string | null }>();
  let row = await read();
  if (!row) return true;
  if (row.state === null) {
    if (!(await revokeAgentSessions(env, { repositoryId }))) {
      logger.warn("purge:revocation-pending", {});
      return false;
    }
    await env.DB.prepare(
      "UPDATE repositories SET purge_state = 'revoked', purge_cursor = NULL WHERE id = ? AND deleted_at IS NOT NULL AND purge_state IS NULL"
    )
      .bind(repositoryId)
      .run();
    row = await read();
  }
  if (row?.state === "revoked") {
    let cursor = row.cursor;
    let complete = false;
    for (let call = 0; call < GIT_PURGE_CALLS && !complete; call += 1) {
      const result = await requestArtifactsPurge(env, repositoryId, cursor);
      if (!result) {
        logger.warn("purge:artifacts-pending", { call });
        return false;
      }
      complete = result.complete;
      cursor = result.next;
      if (!complete)
        await env.DB.prepare(
          "UPDATE repositories SET purge_cursor = ? WHERE id = ? AND purge_state = 'revoked'"
        )
          .bind(cursor, repositoryId)
          .run();
    }
    if (!complete) {
      logger.info("purge:artifacts-partial", { calls: GIT_PURGE_CALLS });
      return false;
    }
    await env.DB.prepare(
      "UPDATE repositories SET purge_state = 'artifacts_deleted', purge_cursor = NULL WHERE id = ? AND purge_state = 'revoked'"
    )
      .bind(repositoryId)
      .run();
    row = await read();
  }
  if (row?.state === "artifacts_deleted") {
    if (!(await purgeReleaseAssets(env, repositoryId))) {
      logger.info("purge:release-assets-partial", {});
      return false;
    }
    await env.DB.prepare(
      "DELETE FROM repositories WHERE id = ? AND deleted_at IS NOT NULL AND purge_state = 'artifacts_deleted'"
    )
      .bind(repositoryId)
      .run();
    logger.info("purge:repository-removed", {});
    return true;
  }
  return false;
}

/** Runs one purge step and schedules a delayed retry when it cannot finish. */
async function attemptPurge(env: ForgeEnv, repositoryId: string, now: number): Promise<boolean> {
  let done = false;
  try {
    done = await purgeRepository(env, repositoryId);
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "repository-purge", repoId: repositoryId }).error(
      "purge:repository-failed",
      { error: cause instanceof Error ? cause.message : "unknown" }
    );
  }
  if (!done)
    await env.DB.prepare(
      "UPDATE repositories SET purge_retry_at = ? WHERE id = ? AND deleted_at IS NOT NULL"
    )
      .bind(now + PURGE_RETRY_DELAY_MS, repositoryId)
      .run();
  return done;
}

/**
 * Scheduled entry point: purges a bounded number of repositories whose grace period ended.
 * Repositories that failed recently wait for their retry time so they cannot starve the queue.
 */
export async function purgeDueRepositories(env: ForgeEnv, now = Date.now()): Promise<number> {
  const logger = createLogger(env.LOG_LEVEL, { service: "repository-purge" });
  const due = await env.DB.prepare(
    "SELECT id FROM repositories WHERE deleted_at IS NOT NULL AND purge_after <= ? AND (purge_retry_at IS NULL OR purge_retry_at <= ?) ORDER BY COALESCE(purge_retry_at, purge_after) LIMIT ?"
  )
    .bind(now, now, PURGE_BATCH)
    .all<{ id: string }>();
  let purged = 0;
  for (const { id } of due.results) if (await attemptPurge(env, id, now)) purged += 1;
  logger.info("purge:run-finished", { due: due.results.length, purged });
  return purged;
}
