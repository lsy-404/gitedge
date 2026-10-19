import { z } from "zod";
import {
  CreateReleaseInputSchema,
  ReleaseAssetNameSchema,
  UpdateReleaseInputSchema,
  RepositorySchema,
  type Release,
  type Repository,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { createLogger } from "../../../src/worker/common/logger";

export interface GitHubApiContext {
  db: D1Database;
  user: TrustedUser | null;
  dispatch(request: Request): Promise<Response>;
}

interface IdRow {
  id: number;
  native_id: string;
  repository_id: string | null;
}

const NativeAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string(),
  uploader: z.string(),
  createdAt: z.number(),
});
const NativeReleaseSchema = z.object({
  id: z.string(),
  tagName: z.string(),
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  target: z.string().nullable(),
  author: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  publishedAt: z.number().nullable(),
  assets: z.array(NativeAssetSchema),
});
const NativeReleaseListSchema = z.object({
  data: z.array(NativeReleaseSchema),
  truncated: z.boolean(),
});

const CreateInput = z
  .object({
    tag_name: z.string().min(1).max(200),
    target_commitish: z.string().min(1).max(255).optional(),
    name: z.string().max(200).optional(),
    body: z.string().max(50_000).optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    make_latest: z.unknown().optional(),
    generate_release_notes: z.unknown().optional(),
    discussion_category_name: z.unknown().optional(),
  })
  .strict();

const UpdateInput = z
  .object({
    name: z.string().max(200).optional(),
    body: z.string().max(50_000).optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    make_latest: z.unknown().optional(),
    generate_release_notes: z.unknown().optional(),
    discussion_category_name: z.unknown().optional(),
  })
  .strict();

const UserBodySchema = z.object({}).passthrough();

function json(status: number, value: unknown, headers?: HeadersInit): Response {
  const output = new Headers(headers);
  output.set("Content-Type", "application/json; charset=utf-8");
  output.set("Cache-Control", "no-store");
  return Response.json(value, { status, headers: output });
}

export function githubApiError(status: number, code: string, message: string): Response {
  return json(status, {
    message,
    code,
    documentation_url: "https://docs.github.com/rest",
  });
}

export function isGitHubApiPath(pathname: string): boolean {
  return pathname === "/api/v3" || pathname.startsWith("/api/v3/") || pathname === "/api/graphql";
}

function unsupported(message: string): Response {
  return githubApiError(501, "unsupported", message);
}

function badRequest(message: string): Response {
  return githubApiError(422, "validation_failed", message);
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).slice(2);
}

function internalRequest(
  request: Request,
  pathname: string,
  method = request.method,
  body?: BodyInit | null
): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  const headers = new Headers();
  for (const name of ["Accept", "Content-Type", "Content-Length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (typeof body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    redirect: "manual",
  });
}

async function data<T>(response: Response, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = z.object({ data: schema }).safeParse(await response.json());
    return parsed.success ? parsed.data.data : null;
  } catch {
    return null;
  }
}

function errorFromNative(response: Response): Response {
  const status = response.status;
  const message =
    status === 404
      ? "Not Found"
      : status === 403
        ? "Resource not accessible by integration"
        : "GitEdge could not complete the request";
  return githubApiError(
    status,
    status === 404 ? "not_found" : status === 403 ? "forbidden" : "native_error",
    message
  );
}

async function mapId(
  context: GitHubApiContext,
  kind: string,
  nativeId: string,
  repositoryId: string | null
): Promise<number> {
  await context.db
    .prepare(
      "INSERT OR IGNORE INTO github_api_ids (kind, native_id, repository_id) VALUES (?, ?, ?)"
    )
    .bind(kind, nativeId, repositoryId)
    .run();
  const row = await context.db
    .prepare(
      "SELECT id, native_id, repository_id FROM github_api_ids WHERE kind = ? AND native_id = ?"
    )
    .bind(kind, nativeId)
    .first<IdRow>();
  if (
    !row ||
    row.native_id !== nativeId ||
    row.repository_id !== repositoryId ||
    !Number.isSafeInteger(row.id)
  )
    throw new Error("compatibility id mapping unavailable");
  return row.id;
}

async function nativeId(
  context: GitHubApiContext,
  kind: string,
  id: string,
  repositoryId: string
): Promise<string | null> {
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) return null;
  const row = await context.db
    .prepare("SELECT native_id FROM github_api_ids WHERE id = ? AND kind = ? AND repository_id = ?")
    .bind(Number(id), kind, repositoryId)
    .first<Pick<IdRow, "native_id">>();
  return row?.native_id ?? null;
}

function repositoryObject(repository: Repository, id: number, origin: string) {
  return {
    id,
    name: repository.name,
    full_name: `${repository.owner}/${repository.name}`,
    private: repository.visibility === "private",
    description: repository.description,
    html_url: new URL(`/${repository.owner}/${repository.name}`, origin).toString(),
    clone_url: new URL(`/${repository.owner}/${repository.name}.git`, origin).toString(),
    default_branch: repository.defaultBranch,
    owner: { login: repository.owner },
  };
}

async function releaseObject(
  context: GitHubApiContext,
  repository: Repository,
  release: Release,
  origin: string
) {
  const releaseId = await mapId(context, "release", release.id, repository.id);
  const assets = await Promise.all(
    release.assets.map(async (asset) => {
      const assetId = await mapId(context, "asset", asset.id, repository.id);
      const url = new URL(
        `/api/v3/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/assets/${assetId}`,
        origin
      ).toString();
      return {
        id: assetId,
        name: asset.name,
        size: asset.size,
        content_type: asset.contentType,
        state: "uploaded",
        browser_download_url: url,
        url,
      };
    })
  );
  const base = `/api/v3/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases`;
  return {
    id: releaseId,
    tag_name: release.tagName,
    name: release.title,
    body: release.body,
    draft: release.draft,
    prerelease: release.prerelease,
    target_commitish: release.target ?? repository.defaultBranch,
    author: { login: release.author },
    created_at: new Date(release.createdAt).toISOString(),
    updated_at: new Date(release.updatedAt).toISOString(),
    published_at: release.publishedAt === null ? null : new Date(release.publishedAt).toISOString(),
    upload_url: `${new URL(`${base}/${releaseId}/assets`, origin).toString()}{?name,label}`,
    assets,
    html_url: new URL(
      `/${repository.owner}/${repository.name}/releases/tag/${encodeURIComponent(release.tagName)}`,
      origin
    ).toString(),
    url: new URL(`${base}/${releaseId}`, origin).toString(),
  };
}

async function resolveRepository(
  request: Request,
  context: GitHubApiContext,
  owner: string,
  repo: string
): Promise<
  { repository: Repository; response?: never } | { repository?: never; response: Response }
> {
  const path = `/api/forge/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const response = await context.dispatch(internalRequest(request, path));
  if (!response.ok) return { response: errorFromNative(response) };
  const repository = await data(response, RepositorySchema);
  if (!repository)
    return { response: githubApiError(502, "native_error", "Repository data was unavailable") };
  return { repository };
}

function queryError(url: URL, allowed: string[]): Response | null {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) return unsupported(`Query parameter '${key}' is not supported.`);
    if (url.searchParams.getAll(key).length !== 1)
      return badRequest(`Query parameter '${key}' must appear once.`);
  }
  return null;
}

async function getReleaseList(
  request: Request,
  context: GitHubApiContext,
  repository: Repository,
  origin: string
): Promise<Response> {
  const url = new URL(request.url);
  const invalid = queryError(url, ["page", "per_page"]);
  if (invalid) return invalid;
  const page = Number(url.searchParams.get("page") ?? "1");
  const perPage = Number(url.searchParams.get("per_page") ?? "30");
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  )
    return badRequest("page must be positive and per_page must be between 1 and 100.");
  const native = await context.dispatch(
    internalRequest(
      request,
      `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases`
    )
  );
  if (!native.ok) return errorFromNative(native);
  const list = await data(native, NativeReleaseListSchema);
  if (!list) return githubApiError(502, "native_error", "Release data was unavailable");
  if (list.truncated)
    return githubApiError(
      422,
      "bounded_result",
      "The complete release list exceeds the supported bound."
    );
  const start = (page - 1) * perPage;
  const selected = list.data.slice(start, start + perPage);
  const output = await Promise.all(
    selected.map((release) => releaseObject(context, repository, release, origin))
  );
  const headers = new Headers();
  if (start + perPage < list.data.length) {
    const next = new URL(url);
    next.searchParams.set("page", String(page + 1));
    const first = new URL(url);
    first.searchParams.set("page", "1");
    headers.set("Link", `<${next.toString()}>; rel="next", <${first.toString()}>; rel="first"`);
  }
  return json(200, output, headers);
}

async function findRelease(
  context: GitHubApiContext,
  request: Request,
  repository: Repository,
  selector: string
): Promise<Release | null | Response> {
  const response = await context.dispatch(
    internalRequest(
      request,
      `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases`
    )
  );
  if (!response.ok) return errorFromNative(response);
  const list = await data(response, NativeReleaseListSchema);
  if (!list) return githubApiError(502, "native_error", "Release data was unavailable");
  if (list.truncated)
    return githubApiError(
      422,
      "bounded_result",
      "The complete release list exceeds the supported bound."
    );
  return list.data.find((release) => release.tagName === selector) ?? null;
}

async function findAsset(
  context: GitHubApiContext,
  request: Request,
  repository: Repository,
  numericId: string
): Promise<{ release: Release; asset: Release["assets"][number] } | Response | null> {
  const assetId = await nativeId(context, "asset", numericId, repository.id);
  if (!assetId) return null;
  const response = await context.dispatch(
    internalRequest(
      request,
      `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases`
    )
  );
  if (!response.ok) return errorFromNative(response);
  const list = await data(response, NativeReleaseListSchema);
  if (!list) return githubApiError(502, "native_error", "Release data was unavailable");
  if (list.truncated)
    return githubApiError(
      422,
      "bounded_result",
      "The complete release list exceeds the supported bound."
    );
  for (const release of list.data) {
    const asset = release.assets.find((item) => item.id === assetId);
    if (asset) return { release, asset };
  }
  return null;
}

function hasUnsupportedReleaseFeatures(value: Record<string, unknown>): boolean {
  return ["make_latest", "generate_release_notes", "discussion_category_name"].some(
    (key) => key in value
  );
}

export async function handleGitHubApiRequest(
  request: Request,
  context: GitHubApiContext
): Promise<Response> {
  const url = new URL(request.url);
  const logger = createLogger(undefined, { service: "gateway-github-api" });
  if (url.pathname === "/api/graphql") return unsupported("GraphQL is not supported.");
  if (url.pathname === "/api/v3" || url.pathname === "/api/v3/") {
    if (request.method !== "GET")
      return githubApiError(405, "method_not_allowed", "Method not allowed");
    const invalid = queryError(url, []);
    if (invalid) return invalid;
    return json(200, {
      current_user_url: `${url.origin}/api/v3/user`,
      repository_url: `${url.origin}/api/v3/repos/{owner}/{repo}`,
      capabilities_url: `${url.origin}/api/v3/gitedge/capabilities`,
    });
  }
  const parts = routeParts(url.pathname);
  if (parts.length === 2 && parts[0] === "gitedge" && parts[1] === "capabilities") {
    if (request.method !== "GET")
      return githubApiError(405, "method_not_allowed", "Method not allowed");
    const invalid = queryError(url, []);
    if (invalid) return invalid;
    return json(200, {
      operations: [
        "GET /user",
        "GET /repos/{owner}/{repo}",
        "GET, POST /repos/{owner}/{repo}/releases",
        "GET /repos/{owner}/{repo}/releases/latest",
        "GET /repos/{owner}/{repo}/releases/tags/{tag}",
        "GET, PATCH, DELETE /repos/{owner}/{repo}/releases/{release_id}",
        "POST /repos/{owner}/{repo}/releases/{release_id}/assets",
        "GET, DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}",
      ],
    });
  }
  if (parts.length === 1 && parts[0] === "user") {
    if (request.method !== "GET")
      return githubApiError(405, "method_not_allowed", "Method not allowed");
    const invalid = queryError(url, []);
    if (invalid) return invalid;
    if (!context.user) return githubApiError(401, "unauthorized", "Requires authentication");
    try {
      const id = await mapId(context, "user", context.user.id, null);
      return json(200, {
        id,
        login: context.user.identifier,
        type: context.user.agentSession ? "Bot" : "User",
      });
    } catch {
      logger.error("github-api:user-id-map-failed", { method: request.method, path: url.pathname });
      return githubApiError(500, "mapping_failed", "User compatibility ID could not be resolved");
    }
  }
  if (parts.length < 3 || parts[0] !== "repos" || !parts[1] || !parts[2])
    return unsupported("This REST endpoint is not supported.");
  if (!context.user && request.method !== "GET")
    return githubApiError(401, "unauthorized", "Requires authentication");
  const resolved = await resolveRepository(request, context, parts[1], parts[2]);
  if (resolved.response) return resolved.response;
  const repository = resolved.repository;
  try {
    if (parts.length === 3) {
      if (request.method !== "GET")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      const id = await mapId(context, "repository", repository.id, null);
      return json(200, repositoryObject(repository, id, url.origin));
    }
    if (parts[3] !== "releases") return unsupported("This repository endpoint is not supported.");
    if (parts.length === 4) {
      if (request.method === "GET") return getReleaseList(request, context, repository, url.origin);
      if (request.method !== "POST")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      const parsedBody = await readJsonLimited(request);
      const bodyObject = UserBodySchema.safeParse(parsedBody);
      if (!bodyObject.success) return badRequest("Request body must be a JSON object.");
      const unsupportedFields = hasUnsupportedReleaseFeatures(bodyObject.data);
      if (unsupportedFields) return unsupported("The requested release feature is not supported.");
      const parsed = CreateInput.safeParse(parsedBody);
      if (!parsed.success) return badRequest("Invalid or unsupported release fields.");
      const body = parsed.data;
      const payload = CreateReleaseInputSchema.safeParse({
        tagName: body.tag_name,
        target: body.target_commitish ?? repository.defaultBranch,
        source: repository.defaultBranch,
        title: body.name ?? body.tag_name,
        body: body.body ?? "",
        draft: body.draft ?? false,
        prerelease: body.prerelease ?? false,
      });
      if (!payload.success) return badRequest("Release fields are invalid.");
      const native = await context.dispatch(
        internalRequest(
          request,
          `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases`,
          "POST",
          JSON.stringify(payload.data)
        )
      );
      if (!native.ok) return errorFromNative(native);
      const release = await data(native, NativeReleaseSchema);
      if (!release) return githubApiError(502, "native_error", "Release data was unavailable");
      return json(201, await releaseObject(context, repository, release, url.origin));
    }
    if (parts[4] === "latest" && parts.length === 5) {
      if (request.method !== "GET")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      const native = await context.dispatch(
        internalRequest(
          request,
          `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/latest`
        )
      );
      if (!native.ok) return errorFromNative(native);
      const release = await data(native, NativeReleaseSchema);
      return release
        ? json(200, await releaseObject(context, repository, release, url.origin))
        : githubApiError(502, "native_error", "Release data was unavailable");
    }
    if (parts[4] === "tags" && parts[5] && parts.length === 6) {
      if (request.method !== "GET")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      const release = await findRelease(context, request, repository, parts[5]);
      if (release instanceof Response) return release;
      return release
        ? json(200, await releaseObject(context, repository, release, url.origin))
        : githubApiError(404, "not_found", "Not Found");
    }
    if (parts[4] === "assets" && parts[5] && parts.length === 6) {
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      if (request.method !== "DELETE" && request.method !== "GET")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const found = await findAsset(context, request, repository, parts[5]);
      if (found instanceof Response) return found;
      if (!found) return githubApiError(404, "not_found", "Not Found");
      if (request.method === "DELETE") {
        const native = await context.dispatch(
          internalRequest(
            request,
            `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(found.release.id)}/assets/${encodeURIComponent(found.asset.id)}`,
            "DELETE"
          )
        );
        if (!native.ok) return errorFromNative(native);
        return new Response(null, { status: 204 });
      }
      const accept = request.headers.get("Accept") ?? "";
      if (accept.includes("application/octet-stream"))
        return context.dispatch(
          internalRequest(
            request,
            `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(found.release.id)}/assets/${encodeURIComponent(found.asset.id)}`
          )
        );
      const assetId = await mapId(context, "asset", found.asset.id, repository.id);
      const assetUrl = new URL(
        `/api/v3/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/assets/${assetId}`,
        url.origin
      ).toString();
      return json(200, {
        id: assetId,
        name: found.asset.name,
        size: found.asset.size,
        content_type: found.asset.contentType,
        state: "uploaded",
        browser_download_url: assetUrl,
        url: assetUrl,
      });
    }
    const releaseSelector = parts[4];
    if (releaseSelector && parts.length === 5) {
      if (request.method !== "GET" && request.method !== "PATCH" && request.method !== "DELETE")
        return githubApiError(405, "method_not_allowed", "Method not allowed");
      const invalid = queryError(url, []);
      if (invalid) return invalid;
      const nativeReleaseId = await nativeId(context, "release", releaseSelector, repository.id);
      if (!nativeReleaseId) return githubApiError(404, "not_found", "Not Found");
      if (request.method === "GET") {
        const native = await context.dispatch(
          internalRequest(
            request,
            `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(nativeReleaseId)}`
          )
        );
        if (!native.ok) return errorFromNative(native);
        const release = await data(native, NativeReleaseSchema);
        return release
          ? json(200, await releaseObject(context, repository, release, url.origin))
          : githubApiError(502, "native_error", "Release data was unavailable");
      }
      if (request.method === "DELETE") {
        const native = await context.dispatch(
          internalRequest(
            request,
            `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(nativeReleaseId)}`,
            "DELETE"
          )
        );
        if (!native.ok) return errorFromNative(native);
        return new Response(null, { status: 204 });
      }
      const bodyObject = UserBodySchema.safeParse(await readJsonLimited(request));
      if (!bodyObject.success) return badRequest("Request body must be a JSON object.");
      if (hasUnsupportedReleaseFeatures(bodyObject.data))
        return unsupported("The requested release feature is not supported.");
      const parsed = UpdateInput.safeParse(bodyObject.data);
      if (!parsed.success || Object.keys(parsed.data).length === 0)
        return badRequest("Invalid or unsupported release fields.");
      const nativeBody = UpdateReleaseInputSchema.safeParse({
        title: parsed.data.name,
        body: parsed.data.body,
        draft: parsed.data.draft,
        prerelease: parsed.data.prerelease,
      });
      if (!nativeBody.success) return badRequest("Invalid release fields.");
      const native = await context.dispatch(
        internalRequest(
          request,
          `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(nativeReleaseId)}`,
          "PATCH",
          JSON.stringify(nativeBody.data)
        )
      );
      if (!native.ok) return errorFromNative(native);
      const release = await data(native, NativeReleaseSchema);
      return release
        ? json(200, await releaseObject(context, repository, release, url.origin))
        : githubApiError(502, "native_error", "Release data was unavailable");
    }
    if (parts[4] && parts[5] === "assets" && parts.length === 6 && request.method === "POST") {
      const invalid = queryError(url, ["name", "label"]);
      if (invalid) return invalid;
      const name = url.searchParams.get("name");
      const label = url.searchParams.get("label");
      if (!name || !ReleaseAssetNameSchema.safeParse(name).success)
        return badRequest("A valid name query parameter is required.");
      if (label) return unsupported("Asset labels are not supported.");
      if (!request.body || !request.headers.has("Content-Length"))
        return badRequest("A streaming request body with Content-Length is required.");
      const releaseId = await nativeId(context, "release", parts[4], repository.id);
      if (!releaseId) return githubApiError(404, "not_found", "Not Found");
      const nativeUrl = new URL(
        `/api/forge/repositories/${encodeURIComponent(repository.id)}/releases/${encodeURIComponent(releaseId)}/assets`,
        request.url
      );
      nativeUrl.searchParams.set("name", name);
      const uploadHeaders = new Headers();
      const contentLength = request.headers.get("Content-Length");
      const contentType = request.headers.get("Content-Type");
      if (contentLength) uploadHeaders.set("Content-Length", contentLength);
      if (contentType) uploadHeaders.set("Content-Type", contentType);
      const native = await context.dispatch(
        new Request(nativeUrl, { method: "PUT", headers: uploadHeaders, body: request.body })
      );
      if (!native.ok) return errorFromNative(native);
      const asset = await data(native, NativeAssetSchema);
      if (!asset) return githubApiError(502, "native_error", "Asset data was unavailable");
      const mappedId = await mapId(context, "asset", asset.id, repository.id);
      const assetUrl = new URL(
        `/api/v3/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/releases/assets/${mappedId}`,
        url.origin
      ).toString();
      return json(201, {
        id: mappedId,
        name: asset.name,
        size: asset.size,
        content_type: asset.contentType,
        state: "uploaded",
        browser_download_url: assetUrl,
        url: assetUrl,
      });
    }
    return unsupported("This release endpoint or method is not supported.");
  } catch (cause) {
    logger.error("github-api-request-failed", { method: request.method, path: url.pathname });
    return githubApiError(
      500,
      "internal_error",
      "The compatibility API could not complete the request."
    );
  }
}
