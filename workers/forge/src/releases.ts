import { z } from "zod";
import {
  CreateReleaseInputSchema,
  RELEASE_ASSET_MAX_BYTES,
  RELEASE_LIST_LIMIT,
  RELEASE_MAX_ASSETS,
  RELEASE_MAX_PER_REPOSITORY,
  RELEASE_REPOSITORY_ASSET_BYTES,
  ReleaseAssetNameSchema,
  UpdateReleaseInputSchema,
  actorForUser,
  trustedHeaders,
  type Release,
  type ReleaseAsset,
  type ReleaseEventType,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { contentDisposition } from "../../../src/worker/common/content-disposition";
import {
  dataResponse,
  errorResponse,
  jsonResponse,
  requireRecentAuth,
} from "../../../src/worker/common/http";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { parseJson, isMember, type ForgeEnv, type RepositoryRow } from "./common";
import { emitReleaseEvent } from "./release-events";

interface ReleaseRow {
  id: string;
  tag_name: string;
  target: string | null;
  target_source: string | null;
  title: string;
  body: string;
  draft: number;
  prerelease: number;
  author: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}
interface AssetRow {
  id: string;
  release_id: string;
  name: string;
  content_type: string;
  size: number;
  uploader: string;
  created_at: number;
}

const RELEASE_COLUMNS =
  "r.id, r.tag_name, r.target, r.target_source, r.title, r.body, r.draft, r.prerelease, u.identifier AS author, r.created_at, r.updated_at, r.published_at";
const RELEASE_FROM = "FROM forge_releases r JOIN users u ON u.id = r.author_id";
const ASSET_COLUMNS =
  "a.id, a.release_id, a.name, a.content_type, a.size, u.identifier AS uploader, a.created_at";
const ASSET_FROM = "FROM forge_release_assets a JOIN users u ON u.id = a.uploader_id";
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const SANDBOX_CSP = "default-src 'none'; sandbox";
const GitErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const GitTagListSchema = z.object({ data: z.array(z.object({ name: z.string() })) });

function assetKey(repositoryId: string, assetId: string): string {
  return `${repositoryId}/${assetId}`;
}

function presentAsset(row: AssetRow): ReleaseAsset {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    contentType: row.content_type,
    uploader: row.uploader,
    createdAt: row.created_at,
  };
}

function presentRelease(row: ReleaseRow, assets: AssetRow[]): Release {
  return {
    id: row.id,
    tagName: row.tag_name,
    title: row.title,
    body: row.body,
    draft: row.draft === 1,
    prerelease: row.prerelease === 1,
    target: row.target,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    assets: assets.map(presentAsset),
  };
}

async function releaseAssets(
  env: ForgeEnv,
  releaseIds: string[]
): Promise<Map<string, AssetRow[]>> {
  const grouped = new Map<string, AssetRow[]>();
  if (!releaseIds.length) return grouped;
  const rows = await env.DB.prepare(
    `SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.release_id IN (${releaseIds.map(() => "?").join(",")}) ORDER BY a.name`
  )
    .bind(...releaseIds)
    .all<AssetRow>();
  for (const row of rows.results)
    grouped.set(row.release_id, [...(grouped.get(row.release_id) ?? []), row]);
  return grouped;
}

async function findRelease(
  env: ForgeEnv,
  repositoryId: string,
  releaseId: string
): Promise<ReleaseRow | null> {
  return env.DB.prepare(
    `SELECT ${RELEASE_COLUMNS} ${RELEASE_FROM} WHERE r.repository_id = ? AND r.id = ?`
  )
    .bind(repositoryId, releaseId)
    .first<ReleaseRow>();
}

async function presentOne(env: ForgeEnv, row: ReleaseRow): Promise<Response> {
  const assets = await releaseAssets(env, [row.id]);
  return dataResponse(presentRelease(row, assets.get(row.id) ?? []));
}

/** Reads shared by the anonymous public path and authenticated members; drafts need a member. */
async function readReleases(
  env: ForgeEnv,
  repository: RepositoryRow,
  rest: string[],
  request: Request,
  includeDrafts: boolean
): Promise<Response | null> {
  if (rest[0] !== "releases") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const visibility = includeDrafts ? "" : " AND r.draft = 0";
  const releaseId = rest[1];
  if (!releaseId) {
    const rows = await env.DB.prepare(
      `SELECT ${RELEASE_COLUMNS} ${RELEASE_FROM} WHERE r.repository_id = ?${visibility} ORDER BY COALESCE(r.published_at, r.created_at) DESC, r.id LIMIT ?`
    )
      .bind(repository.id, RELEASE_LIST_LIMIT + 1)
      .all<ReleaseRow>();
    const kept = rows.results.slice(0, RELEASE_LIST_LIMIT);
    const assets = await releaseAssets(
      env,
      kept.map((row) => row.id)
    );
    return jsonResponse({
      data: kept.map((row) => presentRelease(row, assets.get(row.id) ?? [])),
      truncated: rows.results.length > RELEASE_LIST_LIMIT,
    });
  }
  if (releaseId === "latest" && rest.length === 2) {
    const row = await env.DB.prepare(
      `SELECT ${RELEASE_COLUMNS} ${RELEASE_FROM} WHERE r.repository_id = ? AND r.draft = 0 AND r.prerelease = 0 ORDER BY r.published_at DESC LIMIT 1`
    )
      .bind(repository.id)
      .first<ReleaseRow>();
    return row
      ? presentOne(env, row)
      : errorResponse(404, "not_found", "No release was published.");
  }
  const row = await findRelease(env, repository.id, releaseId);
  if (!row || (row.draft === 1 && !includeDrafts))
    return errorResponse(404, "not_found", "Release was not found.");
  if (rest.length === 2) return presentOne(env, row);
  if (rest[2] === "assets" && rest[3] && rest.length === 4)
    return downloadAsset(env, repository, row, rest[3], request);
  return null;
}

async function downloadAsset(
  env: ForgeEnv,
  repository: RepositoryRow,
  release: ReleaseRow,
  assetId: string,
  request: Request
): Promise<Response> {
  const asset = await env.DB.prepare(
    `SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.id = ? AND a.release_id = ?`
  )
    .bind(assetId, release.id)
    .first<AssetRow>();
  if (!asset) return errorResponse(404, "not_found", "Release asset was not found.");
  if (!env.RELEASE_ASSETS)
    return errorResponse(503, "storage_unavailable", "Release asset storage is unavailable.");
  const object = await env.RELEASE_ASSETS.get(assetKey(repository.id, asset.id));
  if (!object) {
    createLogger(env.LOG_LEVEL, { service: "releases", repoId: repository.id }).error(
      "release:asset-object-missing",
      { assetId }
    );
    return errorResponse(404, "not_found", "Release asset content was not found.");
  }
  const publicAsset = repository.visibility === "public" && release.draft === 0;
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": asset.content_type,
      "Content-Length": String(asset.size),
      "Content-Disposition": contentDisposition("attachment", asset.name),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SANDBOX_CSP,
      ETag: object.httpEtag,
      "Cache-Control": publicAsset ? "public, max-age=300" : "private, no-store",
    },
  });
}

export async function publicReleaseRead(
  env: ForgeEnv,
  repository: RepositoryRow,
  suffix: string[],
  request: Request
): Promise<Response | null> {
  return readReleases(env, repository, suffix, request, false);
}

async function gitCall(
  env: ForgeEnv,
  user: TrustedUser,
  repositoryId: string,
  path: string,
  init?: { method: string; body: unknown }
): Promise<Response> {
  const headers = trustedHeaders(user);
  if (init) headers.set("Content-Type", "application/json");
  return env.GIT.fetch(
    new Request(`https://git.internal/repositories/${repositoryId}/${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init ? JSON.stringify(init.body) : undefined,
    })
  );
}

async function gitFailure(response: Response, logger: Logger): Promise<Response> {
  const parsed = GitErrorSchema.safeParse(await response.json().catch(() => null));
  if (response.status >= 400 && response.status < 500 && parsed.success)
    return errorResponse(
      response.status === 404 ? 400 : response.status,
      parsed.data.error.code,
      parsed.data.error.message
    );
  logger.error("release:git-failed", { status: response.status });
  return errorResponse(
    502,
    "git_unavailable",
    "The Git service could not complete the tag change."
  );
}

type TagOutcome =
  { kind: "created" } | { kind: "existing" } | { kind: "failed"; response: Response };

/**
 * Makes sure the release's tag exists, creating it from the chosen target when one is given.
 * An existing tag is reused as is, so the caller must not record the target as its origin.
 */
async function ensureTag(
  env: ForgeEnv,
  user: TrustedUser,
  repositoryId: string,
  tagName: string,
  target: string | null,
  source: string | null,
  logger: Logger
): Promise<TagOutcome> {
  if (target) {
    const created = await gitCall(env, user, repositoryId, "tags", {
      method: "POST",
      body: { name: tagName, target, ...(source ? { source } : {}) },
    });
    if (created.ok) {
      await created.body?.cancel();
      logger.info("release:tag-created", { tagName });
      return { kind: "created" };
    }
    const failure = GitErrorSchema.safeParse(
      await created
        .clone()
        .json()
        .catch(() => null)
    );
    if (created.status === 409 && failure.success && failure.data.error.code === "tag_exists") {
      await created.body?.cancel();
      return { kind: "existing" };
    }
    return { kind: "failed", response: await gitFailure(created, logger) };
  }
  const lookup = await gitCall(env, user, repositoryId, `tags?name=${encodeURIComponent(tagName)}`);
  if (!lookup.ok) return { kind: "failed", response: await gitFailure(lookup, logger) };
  const tags = GitTagListSchema.safeParse(await lookup.json().catch(() => null));
  if (!tags.success)
    return {
      kind: "failed",
      response: errorResponse(502, "git_unavailable", "The tag could not be verified."),
    };
  return tags.data.data.some((tag) => tag.name === tagName)
    ? { kind: "existing" }
    : {
        kind: "failed",
        response: errorResponse(
          400,
          "tag_missing",
          "The tag does not exist. Choose a branch or commit to create it from."
        ),
      };
}

async function emit(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  type: ReleaseEventType,
  row: Pick<ReleaseRow, "id" | "tag_name" | "draft" | "prerelease">
): Promise<void> {
  await emitReleaseEvent(
    {
      type,
      repositoryId: repository.id,
      releaseId: row.id,
      tagName: row.tag_name,
      draft: row.draft === 1,
      prerelease: row.prerelease === 1,
      actor: actorForUser(user),
      occurredAt: Date.now(),
    },
    env.LOG_LEVEL
  );
}

async function deleteObjects(
  env: ForgeEnv,
  repositoryId: string,
  assetIds: string[]
): Promise<void> {
  if (!assetIds.length) return;
  if (!env.RELEASE_ASSETS) throw new Error("Release asset storage is unavailable.");
  await env.RELEASE_ASSETS.delete(assetIds.map((id) => assetKey(repositoryId, id)));
}

async function uploadAsset(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  release: ReleaseRow,
  logger: Logger
): Promise<Response> {
  if (!env.RELEASE_ASSETS)
    return errorResponse(503, "storage_unavailable", "Release asset storage is unavailable.");
  const name = ReleaseAssetNameSchema.safeParse(new URL(request.url).searchParams.get("name"));
  if (!name.success) return errorResponse(400, "bad_request", "Provide a valid asset name.");
  const lengthHeader = request.headers.get("Content-Length");
  if (lengthHeader === null || !/^\d{1,12}$/.test(lengthHeader))
    return errorResponse(411, "length_required", "Content-Length is required for asset uploads.");
  const length = Number(lengthHeader);
  if (length > RELEASE_ASSET_MAX_BYTES)
    return errorResponse(
      413,
      "asset_too_large",
      `Release assets are limited to ${RELEASE_ASSET_MAX_BYTES / (1024 * 1024)} MiB.`
    );
  const totals = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM forge_release_assets WHERE release_id = ?) AS assets, (SELECT COUNT(*) FROM forge_release_assets WHERE release_id = ? AND name = ?) AS duplicate, (SELECT COALESCE(SUM(size), 0) FROM forge_release_assets WHERE repository_id = ?) AS bytes"
  )
    .bind(release.id, release.id, name.data, repository.id)
    .first<{ assets: number; duplicate: number; bytes: number }>();
  if (totals?.duplicate)
    return errorResponse(409, "asset_exists", "An asset with this name already exists.");
  if ((totals?.assets ?? 0) >= RELEASE_MAX_ASSETS)
    return errorResponse(
      409,
      "asset_limit",
      `A release can hold at most ${RELEASE_MAX_ASSETS} assets.`
    );
  if ((totals?.bytes ?? 0) + length > RELEASE_REPOSITORY_ASSET_BYTES)
    return errorResponse(
      409,
      "storage_limit",
      "Release asset storage for this repository is full."
    );
  const declared = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  const contentType = CONTENT_TYPE.test(declared) ? declared : "application/octet-stream";
  const assetId = crypto.randomUUID();
  const key = assetKey(repository.id, assetId);
  const discard = async (reason: string) => {
    try {
      await env.RELEASE_ASSETS?.delete(key);
    } catch {
      logger.error("release:asset-cleanup-failed", { assetId, reason });
    }
  };
  let stored: R2Object;
  try {
    // R2 needs a stream of known length, which forwarded request bodies do not guarantee.
    const { readable, writable } = new FixedLengthStream(length);
    const piping = (request.body ?? new Blob([]).stream()).pipeTo(writable);
    [stored] = await Promise.all([
      env.RELEASE_ASSETS.put(key, readable, {
        httpMetadata: { contentType },
        customMetadata: { repositoryId: repository.id, releaseId: release.id },
      }),
      piping,
    ]);
  } catch (cause) {
    await discard("put-failed");
    logger.warn("release:asset-upload-failed", {
      assetId,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(400, "upload_failed", "The upload was interrupted or malformed.");
  }
  if (stored.size !== length) {
    await discard("length-mismatch");
    return errorResponse(400, "upload_failed", "The uploaded size did not match Content-Length.");
  }
  let inserted: D1Result;
  try {
    inserted = await env.DB.prepare(
      "INSERT INTO forge_release_assets (id, release_id, repository_id, name, content_type, size, uploader_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM forge_release_assets WHERE release_id = ?) < ? AND (SELECT COALESCE(SUM(size), 0) FROM forge_release_assets WHERE repository_id = ?) + ? <= ?"
    )
      .bind(
        assetId,
        release.id,
        repository.id,
        name.data,
        contentType,
        stored.size,
        user.id,
        Date.now(),
        release.id,
        RELEASE_MAX_ASSETS,
        repository.id,
        stored.size,
        RELEASE_REPOSITORY_ASSET_BYTES
      )
      .run();
  } catch (cause) {
    await discard("insert-conflict");
    const duplicate = await env.DB.prepare(
      "SELECT 1 AS found FROM forge_release_assets WHERE release_id = ? AND name = ?"
    )
      .bind(release.id, name.data)
      .first<{ found: number }>();
    if (duplicate)
      return errorResponse(409, "asset_exists", "An asset with this name already exists.");
    if (!(await findRelease(env, repository.id, release.id)))
      return errorResponse(404, "not_found", "Release was not found.");
    logger.error("release:asset-insert-failed", {
      assetId,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    throw cause;
  }
  if (inserted.meta.changes !== 1) {
    await discard("limit");
    return errorResponse(409, "asset_limit", "The release asset limits were reached.");
  }
  await env.DB.prepare("UPDATE forge_releases SET updated_at = ? WHERE id = ?")
    .bind(Date.now(), release.id)
    .run();
  logger.info("release:asset-uploaded", { releaseId: release.id, assetId, size: stored.size });
  const asset = await env.DB.prepare(`SELECT ${ASSET_COLUMNS} ${ASSET_FROM} WHERE a.id = ?`)
    .bind(assetId)
    .first<AssetRow>();
  return dataResponse(asset ? presentAsset(asset) : null, 201);
}

/** Release and asset routes for authenticated callers; null when the path is not a release path. */
export async function repositoryReleases(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  const rest = parts.slice(2);
  if (rest[0] !== "releases") return null;
  const logger = createLogger(env.LOG_LEVEL, { service: "releases", repoId: repository.id });
  const member = !user.agentSession && (await isMember(env, repository.id, user.id));
  const reading = request.method === "GET" || request.method === "HEAD";
  if (reading) return readReleases(env, repository, rest, request, member);
  if (!member)
    return errorResponse(
      403,
      "forbidden",
      "Repository write access is required to manage releases."
    );
  if (repository.archived === 1)
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  const releaseId = rest[1];

  if (request.method === "POST" && !releaseId) {
    const input = CreateReleaseInputSchema.safeParse(await parseJson(request));
    if (!input.success) return errorResponse(400, "bad_request", "Invalid release.");
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) AS releases, SUM(tag_name = ?) AS duplicate FROM forge_releases WHERE repository_id = ?"
    )
      .bind(input.data.tagName, repository.id)
      .first<{ releases: number; duplicate: number | null }>();
    if (counts?.duplicate)
      return errorResponse(409, "release_exists", "A release for this tag already exists.");
    if ((counts?.releases ?? 0) >= RELEASE_MAX_PER_REPOSITORY)
      return errorResponse(409, "release_limit", "The release limit was reached.");
    let target = input.data.target ?? null;
    let source = input.data.source ?? null;
    if (!input.data.draft) {
      const tag = await ensureTag(
        env,
        user,
        repository.id,
        input.data.tagName,
        target,
        source,
        logger
      );
      if (tag.kind === "failed") return tag.response;
      if (tag.kind === "existing") {
        target = null;
        source = null;
      }
    }
    const now = Date.now();
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        "INSERT INTO forge_releases (id, repository_id, tag_name, target, target_source, title, body, draft, prerelease, author_id, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          id,
          repository.id,
          input.data.tagName,
          target,
          source,
          input.data.title || input.data.tagName,
          input.data.body,
          Number(input.data.draft),
          Number(input.data.prerelease),
          user.id,
          now,
          now,
          input.data.draft ? null : now
        )
        .run();
    } catch {
      return errorResponse(409, "release_exists", "A release for this tag already exists.");
    }
    logger.info("release:created", { releaseId: id, draft: input.data.draft });
    const row = await findRelease(env, repository.id, id);
    if (!row) return errorResponse(500, "internal_error", "The release was not saved.");
    if (!input.data.draft) await emit(env, repository, user, "release.published", row);
    return dataResponse(presentRelease(row, []), 201);
  }

  if (!releaseId) return null;
  const release = await findRelease(env, repository.id, releaseId);
  if (!release) return errorResponse(404, "not_found", "Release was not found.");

  if (request.method === "PATCH" && rest.length === 2) {
    const input = UpdateReleaseInputSchema.safeParse(await parseJson(request));
    if (!input.success) return errorResponse(400, "bad_request", "Invalid release update.");
    const publishing = release.draft === 1 && input.data.draft === false;
    let target = release.target;
    let source = release.target_source;
    if (publishing) {
      const tag = await ensureTag(
        env,
        user,
        repository.id,
        release.tag_name,
        target,
        source,
        logger
      );
      if (tag.kind === "failed") return tag.response;
      if (tag.kind === "existing") {
        target = null;
        source = null;
      }
    }
    const draft = input.data.draft ?? release.draft === 1;
    const now = Date.now();
    // The draft state read above guards the write, so concurrent publishes emit one event.
    const written = await env.DB.prepare(
      "UPDATE forge_releases SET title = ?, body = ?, draft = ?, prerelease = ?, published_at = ?, target = ?, target_source = ?, updated_at = ? WHERE id = ? AND repository_id = ? AND draft = ?"
    )
      .bind(
        input.data.title === undefined ? release.title : input.data.title || release.tag_name,
        input.data.body ?? release.body,
        Number(draft),
        Number(input.data.prerelease ?? release.prerelease === 1),
        draft ? null : (release.published_at ?? now),
        target,
        source,
        now,
        release.id,
        repository.id,
        release.draft
      )
      .run();
    if (written.meta.changes !== 1)
      return errorResponse(
        409,
        "release_changed",
        "The release was published or unpublished meanwhile. Reload before retrying."
      );
    const updated = await findRelease(env, repository.id, release.id);
    if (!updated) return errorResponse(404, "not_found", "Release was not found.");
    logger.info("release:updated", { releaseId: release.id, publishing });
    if (!updated.draft || !release.draft)
      await emit(
        env,
        repository,
        user,
        publishing ? "release.published" : "release.updated",
        updated
      );
    return presentOne(env, updated);
  }

  if (request.method === "DELETE" && rest.length === 2) {
    if (!user.token) {
      const reauth = requireRecentAuth(user);
      if (reauth) return reauth;
    }
    const assets = await releaseAssets(env, [release.id]);
    try {
      await deleteObjects(
        env,
        repository.id,
        (assets.get(release.id) ?? []).map((asset) => asset.id)
      );
    } catch (cause) {
      logger.error("release:asset-delete-failed", {
        releaseId: release.id,
        error: cause instanceof Error ? cause.message : "unknown",
      });
      return errorResponse(502, "storage_unavailable", "Release assets could not be deleted.");
    }
    await env.DB.prepare("DELETE FROM forge_releases WHERE id = ? AND repository_id = ?")
      .bind(release.id, repository.id)
      .run();
    logger.info("release:deleted", { releaseId: release.id });
    if (release.draft === 0) await emit(env, repository, user, "release.deleted", release);
    return dataResponse({ deleted: true });
  }

  if (request.method === "PUT" && rest[2] === "assets" && rest.length === 3)
    return uploadAsset(env, request, repository, user, release, logger);

  if (request.method === "DELETE" && rest[2] === "assets" && rest[3] && rest.length === 4) {
    const asset = await env.DB.prepare(
      "SELECT id FROM forge_release_assets WHERE id = ? AND release_id = ?"
    )
      .bind(rest[3], release.id)
      .first<{ id: string }>();
    if (!asset) return errorResponse(404, "not_found", "Release asset was not found.");
    try {
      await deleteObjects(env, repository.id, [asset.id]);
    } catch {
      return errorResponse(502, "storage_unavailable", "The release asset could not be deleted.");
    }
    await env.DB.prepare("DELETE FROM forge_release_assets WHERE id = ?").bind(asset.id).run();
    logger.info("release:asset-deleted", { releaseId: release.id, assetId: asset.id });
    return dataResponse({ deleted: true });
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed.");
}

const PURGE_PAGE = 1000;
const PURGE_PAGES = 5;

/** Removes every stored asset of a repository; false when more remain for a later run. */
export async function purgeReleaseAssets(env: ForgeEnv, repositoryId: string): Promise<boolean> {
  const bucket = env.RELEASE_ASSETS;
  if (!bucket) return true;
  for (let page = 0; page < PURGE_PAGES; page += 1) {
    const listing = await bucket.list({ prefix: `${repositoryId}/`, limit: PURGE_PAGE });
    if (listing.objects.length) await bucket.delete(listing.objects.map((object) => object.key));
    if (!listing.truncated) return true;
  }
  return false;
}
