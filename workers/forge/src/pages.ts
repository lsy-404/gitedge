import {
  PAGES_CHECK_ACTOR,
  PAGES_CHECK_ACTOR_KEY,
  PAGES_CHECK_NAME,
  UpdatePagesInputSchema,
  pagesHostUrl,
  pagesPathUrl,
  pagesPreviewPath,
  type PagesSettings,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";

interface PagesRow {
  source_branch: string;
  folder: string;
  not_found_path: string | null;
  spa_fallback: number;
  last_published_oid: string | null;
  last_published_at: number | null;
}

const NO_OID = /^0+$/;
const PREVIEW_SUMMARY = "Preview ready";

function previewsAvailable(repository: RepositoryRow): boolean {
  return repository.pages_enabled === 1 && repository.visibility === "public";
}

async function readPages(
  env: ForgeEnv,
  repository: RepositoryRow,
  canManage: boolean
): Promise<PagesSettings> {
  const row = await env.DB.prepare(
    "SELECT source_branch, folder, not_found_path, spa_fallback, last_published_oid, last_published_at FROM repository_pages WHERE repository_id = ?"
  )
    .bind(repository.id)
    .first<PagesRow>();
  return {
    enabled: repository.pages_enabled === 1,
    available: repository.visibility === "public",
    branch: row?.source_branch ?? repository.default_branch ?? "main",
    folder: row?.folder ?? "/",
    notFoundPath: row ? row.not_found_path : "404.html",
    spaFallback: row?.spa_fallback === 1,
    lastPublishedOid: row?.last_published_oid ?? null,
    lastPublishedAt: row?.last_published_at ?? null,
    pathUrl: pagesPathUrl(repository.owner, repository.slug),
    hostUrl: pagesHostUrl(repository.owner, repository.slug, env.SITES_HOST),
    canManage,
  };
}

/** Routes `/repositories/:id/pages`: any reader sees the site settings, repository administrators change them. */
export async function handleRepositoryPages(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: readonly string[]
): Promise<Response | null> {
  if (parts[2] !== "pages") return null;
  if (parts.length !== 3) return errorResponse(404, "not_found", "Endpoint was not found.");
  const admin =
    !user.agentSession && (await repositoryRole(env.DB, repository.id, user.id)) === "admin";
  if (request.method === "GET") return dataResponse(await readPages(env, repository, admin));
  if (request.method !== "PUT")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if (!admin)
    return errorResponse(403, "forbidden", "Repository administrator access is required.");
  const parsed = UpdatePagesInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid Pages settings.");
  const input = parsed.data;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge-pages", repoId: repository.id });
  await env.DB.prepare(
    "INSERT INTO repository_pages (repository_id, source_branch, folder, not_found_path, spa_fallback, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET last_published_oid = CASE WHEN source_branch = excluded.source_branch THEN last_published_oid END, last_published_at = CASE WHEN source_branch = excluded.source_branch THEN last_published_at END, source_branch = excluded.source_branch, folder = excluded.folder, not_found_path = excluded.not_found_path, spa_fallback = excluded.spa_fallback, updated_at = excluded.updated_at"
  )
    .bind(
      repository.id,
      input.branch,
      input.folder,
      input.notFoundPath,
      Number(input.spaFallback),
      Date.now()
    )
    .run();
  logger.info("pages:settings-updated", {
    branch: input.branch,
    folder: input.folder,
    spaFallback: input.spaFallback,
  });
  await recordAudit(env, {
    action: "pages.updated",
    actor: auditActor(user),
    target: {
      type: "repository",
      id: repository.id,
      label: `${repository.owner}/${repository.slug}`,
    },
    repositoryId: repository.id,
    namespaceId: repository.namespace_id,
    metadata: { branch: input.branch, folder: input.folder, spaFallback: input.spaFallback },
  });
  return dataResponse(await readPages(env, repository, true));
}

function previewCheckStatement(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullId: string,
  oid: string,
  now: number
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO forge_check_runs (id, repository_id, pull_request_id, actor_json, actor_key, name, commit_oid, status, conclusion, summary, details_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'neutral', ?, ?, ?, ?) ON CONFLICT(pull_request_id, commit_oid, name, actor_key) DO NOTHING"
  ).bind(
    crypto.randomUUID(),
    repository.id,
    pullId,
    JSON.stringify(PAGES_CHECK_ACTOR),
    PAGES_CHECK_ACTOR_KEY,
    PAGES_CHECK_NAME,
    oid,
    PREVIEW_SUMMARY,
    pagesPreviewPath(repository.owner, repository.slug, oid),
    now,
    now
  );
}

/**
 * Records a neutral "Preview ready" check for a pull request head. Neutral keeps it from counting
 * as a passing check for merge policy; earlier heads keep their own check so their previews stay valid.
 */
export async function recordPreviewCheck(
  env: ForgeEnv,
  repository: RepositoryRow,
  pullId: string,
  oid: string
): Promise<void> {
  if (!previewsAvailable(repository)) return;
  await previewCheckStatement(env, repository, pullId, oid, Date.now()).run();
  createLogger(env.LOG_LEVEL, { service: "forge-pages", repoId: repository.id }).info(
    "pages:preview-recorded",
    { pullId, oid }
  );
}

/** Tracks the source-branch head and posts previews for open same-repository pull requests. */
export async function syncPagesAfterPush(
  env: ForgeEnv,
  repository: RepositoryRow,
  updates: readonly { ref: string; after: string }[]
): Promise<void> {
  if (!previewsAvailable(repository)) return;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge-pages", repoId: repository.id });
  const source = await env.DB.prepare(
    "SELECT source_branch FROM repository_pages WHERE repository_id = ?"
  )
    .bind(repository.id)
    .first<{ source_branch: string }>();
  const sourceBranch = source?.source_branch ?? repository.default_branch ?? "main";
  const now = Date.now();
  for (const update of updates) {
    if (!update.ref.startsWith("refs/heads/") || NO_OID.test(update.after)) continue;
    const branch = update.ref.slice("refs/heads/".length);
    if (branch === sourceBranch)
      await env.DB.prepare(
        "INSERT INTO repository_pages (repository_id, source_branch, folder, not_found_path, spa_fallback, last_published_oid, last_published_at, updated_at) VALUES (?, ?, '/', '404.html', 0, ?, ?, ?) ON CONFLICT(repository_id) DO UPDATE SET last_published_oid = excluded.last_published_oid, last_published_at = excluded.last_published_at WHERE source_branch = excluded.source_branch"
      )
        .bind(repository.id, branch, update.after, now, now)
        .run();
    const pulls = await env.DB.prepare(
      "SELECT id FROM forge_pull_requests WHERE repository_id = ? AND state = 'open' AND head_session_id IS NULL AND head_ref = ? LIMIT 101"
    )
      .bind(repository.id, branch)
      .all<{ id: string }>();
    if (pulls.results.length > 100)
      logger.warn("pages:preview-pulls-truncated", { branch, count: pulls.results.length });
    const statements = pulls.results
      .slice(0, 100)
      .map((pull) => previewCheckStatement(env, repository, pull.id, update.after, now));
    if (statements.length > 0) await env.DB.batch(statements);
  }
}
