import { ForkRepositoryInputSchema, type TrustedUser } from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { parseJson, repoResponse, type ForgeEnv, type RepositoryRow } from "./common";
import { activeImportPath } from "./imports";
import { readableBy, repositorySocialFields, socialFieldsFor } from "./social";

const FORK_LIST_LIMIT = 100;
const DETACH_BATCH = 500;

export interface ForkOwner {
  id: string;
  slug: string;
  canCreate: boolean;
}
export interface ForkContext {
  resolveOwner(slug: string): Promise<ForkOwner | null>;
  /** A response when the user may not create another repository. */
  checkQuota(): Promise<Response | null>;
}

async function listForks(
  env: ForgeEnv,
  repository: RepositoryRow,
  viewerId: string | null
): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT r.*, n.slug AS owner FROM repositories r JOIN namespaces n ON n.id = r.namespace_id WHERE r.fork_of = ? AND r.deleted_at IS NULL AND r.artifact_name IS NOT NULL AND ${readableBy("r")} ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`
  )
    .bind(repository.id, viewerId, viewerId, FORK_LIST_LIMIT + 1)
    .all<RepositoryRow>();
  const page = rows.results.slice(0, FORK_LIST_LIMIT);
  const social = await repositorySocialFields(env, page, viewerId);
  return jsonResponse({
    data: page.map((row) => repoResponse(row, null, false, social.get(row.id))),
    truncated: rows.results.length > FORK_LIST_LIMIT,
  });
}

/** Anonymous fork listing of a public repository. */
export function publicForkList(env: ForgeEnv, repository: RepositoryRow): Promise<Response> {
  return listForks(env, repository, null);
}

async function createFork(
  env: ForgeEnv,
  request: Request,
  parent: RepositoryRow,
  user: TrustedUser,
  context: ForkContext
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: parent.id });
  const parsed = ForkRepositoryInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid fork payload.");
  if (!parent.artifact_name)
    return errorResponse(503, "internal_error", "Repository storage is unavailable.");
  const owner = await context.resolveOwner(parsed.data.owner ?? user.identifier);
  if (!owner) return errorResponse(404, "not_found", "Fork owner was not found.");
  if (!owner.canCreate)
    return errorResponse(403, "forbidden", "Forking requires namespace owner access.");
  if (!(await namespaceMayHoldFork(env, parent, owner.id)))
    return errorResponse(
      403,
      "fork_owner_not_allowed",
      "A private repository can only be forked into your own account or its owner."
    );
  const quota = await context.checkQuota();
  if (quota) return quota;
  const slug = parsed.data.name ?? parent.slug;
  if (await activeImportPath(env, owner.id, slug))
    return errorResponse(409, "conflict", "Repository name is reserved by an import in progress.");

  const id = crypto.randomUUID();
  const artifactName = `repo-${id}`;
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, fork_of, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        owner.id,
        user.id,
        slug,
        `repo:${id}`,
        parent.default_branch ?? "main",
        parent.visibility,
        parent.description,
        parent.id,
        now,
        now
      )
      .run();
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.message.includes("UNIQUE") || cause.message.includes("repository path"))
    )
      return errorResponse(
        409,
        "conflict",
        "Repository name is already used or reserved by a rename."
      );
    throw cause;
  }
  let remote: string;
  let storageCreated = false;
  try {
    using source = await env.ARTIFACTS.get(parent.artifact_name);
    const forked = await source.fork(artifactName, {
      description: parent.description,
      defaultBranchOnly: true,
    });
    storageCreated = true;
    using copy = await env.ARTIFACTS.get(forked.name);
    // The fork's initial write token must not outlive this request.
    if (!(await copy.revokeToken(forked.token)))
      throw new Error("Initial fork token could not be revoked.");
    remote = forked.remote;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE repositories SET artifact_name = ?, remote = ?, updated_at = ? WHERE id = ?"
      ).bind(forked.name, forked.remote, Date.now(), id),
      env.DB.prepare("INSERT INTO forge_counters (repository_id) VALUES (?)").bind(id),
    ]);
  } catch (cause) {
    await env.DB.prepare("DELETE FROM repositories WHERE id = ?").bind(id).run();
    if (storageCreated)
      await env.ARTIFACTS.delete(artifactName).catch(() =>
        logger.warn("forge:fork-storage-orphaned", { forkId: id, artifactName })
      );
    logger.error("forge:fork-failed", {
      forkId: id,
      userId: user.id,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(503, "internal_error", "Repository could not be forked.");
  }
  logger.info("forge:repository-forked", { forkId: id, namespaceId: owner.id, userId: user.id });
  const created: RepositoryRow = {
    id,
    namespace_id: owner.id,
    owner: owner.slug,
    slug,
    visibility: parent.visibility,
    description: parent.description,
    created_at: now,
    updated_at: Date.now(),
    artifact_name: artifactName,
    remote,
    default_branch: parent.default_branch ?? "main",
    fork_of: parent.id,
  };
  return dataResponse(
    repoResponse(created, "admin", true, await socialFieldsFor(env, created, user.id)),
    201
  );
}

/** `GET`/`POST /repositories/:id/forks` for a repository the caller can already read. */
export async function repositoryForks(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: readonly string[],
  context: ForkContext
): Promise<Response | null> {
  if (parts[2] !== "forks" || parts.length !== 3) return null;
  if (request.method === "GET") return listForks(env, repository, user.id);
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if (user.agentSession)
    return errorResponse(403, "forbidden", "Agent sessions cannot fork repositories.");
  // Like repository creation, a fork lies outside a repository-limited token's scope.
  if (user.token?.repositoryIds)
    return errorResponse(403, "forbidden", "Access token is limited to its repositories.");
  return createFork(env, request, repository, user, context);
}

/** SQL: user column `user` can read parent repository alias `p`. */
function readsParent(user: string): string {
  return `(EXISTS (SELECT 1 FROM namespace_memberships pm WHERE pm.namespace_id = p.namespace_id AND pm.user_id = ${user}) OR EXISTS (SELECT 1 FROM repository_collaborators pc WHERE pc.repository_id = p.id AND pc.user_id = ${user}))`;
}

/**
 * Whether a namespace may hold a fork of `parent`. A private parent's copied history must stay
 * readable only by its own readers: the parent's namespace, or a personal namespace whose members
 * all read the parent. Other organizations are refused because their future members would not.
 */
export async function namespaceMayHoldFork(
  env: ForgeEnv,
  parent: Pick<RepositoryRow, "id" | "namespace_id" | "visibility">,
  namespaceId: string
): Promise<boolean> {
  if (parent.visibility === "public" || namespaceId === parent.namespace_id) return true;
  const row = await env.DB.prepare(
    `SELECT n.kind, EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = n.id AND NOT ${readsParent("m.user_id")}) AS outsider FROM namespaces n JOIN repositories p ON p.id = ? WHERE n.id = ?`
  )
    .bind(parent.id, namespaceId)
    .first<{ kind: string; outsider: number }>();
  return row?.kind === "personal" && row.outsider === 0;
}

/**
 * Whether `userId` may become a collaborator of `repositoryId`: always, unless the repository is a
 * fork attached to a private parent that the user cannot read. Unknown (email) invitees are refused
 * for such forks.
 */
export async function forkAdmitsCollaborator(
  env: ForgeEnv,
  repositoryId: string,
  userId: string | null
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT p.visibility, CASE WHEN ?2 IS NULL THEN 0 ELSE ${readsParent("?2")} END AS reads FROM repositories f JOIN repositories p ON p.id = f.fork_of AND p.deleted_at IS NULL WHERE f.id = ?1`
  )
    .bind(repositoryId, userId)
    .first<{ visibility: string; reads: number }>();
  return !row || row.visibility === "public" || row.reads === 1;
}

/** Closes open pull requests whose head lives in one of `forkIds`. */
export async function closeForkPullRequests(env: ForgeEnv, forkIds: readonly string[]) {
  if (forkIds.length === 0) return;
  await env.DB.prepare(
    "UPDATE forge_pull_requests SET state = 'closed', updated_at = ? WHERE state = 'open' AND head_repository_id IN (SELECT value FROM json_each(?))"
  )
    .bind(Date.now(), JSON.stringify(forkIds))
    .run();
}

/**
 * Detaches forks whose parent was deleted, or whose private parent they may no longer draw from:
 * the fork is public, or one of its readers (namespace member or collaborator) cannot read the
 * parent. A detached fork keeps its own history and becomes a standalone repository; its open
 * cross-repository pull requests are closed.
 */
export async function detachForks(
  env: ForgeEnv,
  options: { parentId?: string; namespaceId?: string; level?: string } = {}
): Promise<number> {
  const detached = await env.DB.prepare(
    `UPDATE repositories SET fork_of = NULL WHERE id IN (SELECT f.id FROM repositories f JOIN repositories p ON p.id = f.fork_of WHERE (?1 IS NULL OR p.id = ?1) AND (?3 IS NULL OR p.namespace_id = ?3) AND (p.deleted_at IS NOT NULL OR (p.visibility = 'private' AND (f.visibility = 'public' OR EXISTS (SELECT 1 FROM namespace_memberships fm WHERE fm.namespace_id = f.namespace_id AND NOT ${readsParent("fm.user_id")}) OR EXISTS (SELECT 1 FROM repository_collaborators fc WHERE fc.repository_id = f.id AND NOT ${readsParent("fc.user_id")})))) LIMIT ?2) RETURNING id`
  )
    .bind(options.parentId ?? null, DETACH_BATCH, options.namespaceId ?? null)
    .all<{ id: string }>();
  if (detached.results.length === 0) return 0;
  await closeForkPullRequests(
    env,
    detached.results.map((row) => row.id)
  );
  createLogger(options.level, { service: "forge" }).info("forge:forks-detached", {
    count: detached.results.length,
    parentId: options.parentId,
  });
  return detached.results.length;
}
