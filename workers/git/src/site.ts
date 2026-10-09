import mime from "mime";
import {
  GitOidSchema,
  PAGES_CHECK_ACTOR_KEY,
  PAGES_CHECK_NAME,
  PAGES_MAX_PATH_SEGMENTS,
  PAGES_SITE_MAX_BYTES,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import type { GitEnv } from "./access";
import { memoryLimit } from "./archive";
import { resolveCommit } from "./read";

export type SiteMode = "path" | "host";

/** Strict sandbox without allow-same-origin: site scripts get an opaque origin and cannot reach GitEdge cookies or credentialed API calls. */
export const SITE_SANDBOX_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
const BRANCH_MAX_AGE = 60;
const PREVIEW_MAX_AGE = 300;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_ORIGIN = "https://pages.cache.internal";

export interface SitePath {
  segments: string[];
  /** True for the site root and any path that ends in a slash. */
  directory: boolean;
}

/** Decodes a raw URL path and rejects traversal, separators and control characters. */
export function parseSitePath(raw: string): SitePath | null {
  if (raw.length > 2000) return null;
  const directory = raw === "" || raw.endsWith("/");
  const parts = raw.split("/");
  if (parts[0] !== "") return null;
  const segments: string[] = [];
  for (const [index, part] of parts.slice(1).entries()) {
    if (part === "") {
      if (index === parts.length - 2) continue;
      return null;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(decoded)
    )
      return null;
    segments.push(decoded);
  }
  return segments.length > PAGES_MAX_PATH_SEGMENTS ? null : { segments, directory };
}

export function siteContentType(name: string): string {
  const type = mime.getType(name) ?? "application/octet-stream";
  return /^text\/|javascript|json|xml/.test(type) ? `${type}; charset=utf-8` : type;
}

export interface SiteConfig {
  branch: string;
  folder: string;
  notFoundPath: string | null;
  spaFallback: boolean;
}

/**
 * Edge cache key: an immutable commit OID plus everything else that changes how a path resolves.
 * The repository cache generation starts a new keyspace after visibility, owner, name, deletion or
 * storage changes, matching the Git API edge cache.
 */
export function siteCacheKey(
  repositoryId: string,
  generation: number,
  commitOid: string,
  path: SitePath,
  config: SiteConfig,
  mode: SiteMode,
  preview: boolean
): string {
  const url = new URL(
    `${CACHE_ORIGIN}/${encodeURIComponent(repositoryId)}/g${generation}/${commitOid}/${path.segments.map(encodeURIComponent).join("/")}${path.directory ? "/" : ""}`
  );
  url.searchParams.set("f", config.folder);
  url.searchParams.set("n", config.notFoundPath ?? "");
  url.searchParams.set("s", config.spaFallback ? "1" : "0");
  url.searchParams.set("m", mode);
  url.searchParams.set("p", preview ? "1" : "0");
  return url.toString();
}

type SiteResolution =
  | { kind: "file"; hash: string; name: string; status: 200 | 404 }
  | { kind: "redirect"; segment: string }
  | { kind: "missing" };

type SiteTree = Pick<ArtifactsRepo, "readTree">;

class TreeReader {
  private readonly trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
  constructor(private readonly repo: SiteTree) {}
  read(hash: string): Promise<ArtifactsTreeEntry[] | null> {
    let entries = this.trees.get(hash);
    if (!entries) {
      entries = this.repo.readTree(hash);
      this.trees.set(hash, entries);
    }
    return entries;
  }
  async lookup(
    root: string,
    segments: readonly string[]
  ): Promise<{ type: "tree" | "file"; hash: string } | null> {
    let current = root;
    for (const [index, segment] of segments.entries()) {
      const entry = (await this.read(current))?.find((item) => item.name === segment);
      if (!entry) return null;
      const last = index === segments.length - 1;
      if (entry.type === "tree") {
        if (last) return { type: "tree", hash: entry.hash };
        current = entry.hash;
        continue;
      }
      // Symlinks and submodules are never followed.
      if (last && (entry.type === "blob" || entry.type === "exec"))
        return { type: "file", hash: entry.hash };
      return null;
    }
    return { type: "tree", hash: current };
  }
}

function hasExtension(segment: string | undefined): boolean {
  return segment !== undefined && segment.includes(".");
}

/** Maps a request path inside the configured folder to a blob, a redirect or a miss. */
export async function resolveSiteEntry(
  repo: SiteTree,
  commitTree: string,
  config: SiteConfig,
  path: SitePath
): Promise<SiteResolution> {
  const reader = new TreeReader(repo);
  const folder = config.folder.split("/").filter(Boolean);
  const root = await reader.lookup(commitTree, folder);
  if (root?.type !== "tree") return { kind: "missing" };
  const index = async (segments: readonly string[]): Promise<SiteResolution | null> => {
    const found = await reader.lookup(root.hash, [...segments, "index.html"]);
    return found?.type === "file"
      ? { kind: "file", hash: found.hash, name: "index.html", status: 200 }
      : null;
  };
  const request = path.segments;
  const last = request.at(-1);
  let hit: SiteResolution | null = null;
  if (request.length === 0 || path.directory) hit = await index(request);
  else {
    const found = await reader.lookup(root.hash, request);
    if (found?.type === "file")
      hit = { kind: "file", hash: found.hash, name: last ?? "", status: 200 };
    else if (found?.type === "tree") return { kind: "redirect", segment: last ?? "" };
    else if (last && !hasExtension(last)) {
      const clean = await reader.lookup(root.hash, [...request.slice(0, -1), `${last}.html`]);
      if (clean?.type === "file")
        hit = { kind: "file", hash: clean.hash, name: `${last}.html`, status: 200 };
    }
  }
  if (hit) return hit;
  if (config.spaFallback && !hasExtension(last)) {
    const fallback = await index([]);
    if (fallback) return fallback;
  }
  if (config.notFoundPath) {
    const page = await reader.lookup(root.hash, config.notFoundPath.split("/"));
    if (page?.type === "file")
      return { kind: "file", hash: page.hash, name: config.notFoundPath, status: 404 };
  }
  return { kind: "missing" };
}

interface SiteRepositoryRow {
  id: string;
  artifact_name: string | null;
  cache_generation: number;
  default_branch: string;
  source_branch: string | null;
  folder: string | null;
  not_found_path: string | null;
  spa_fallback: number | null;
  has_config: number;
}

function notFound(): Response {
  return new Response("Site not found\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function tooLarge(): Response {
  return new Response("File is too large to serve from Pages.\n", {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function siteHeaders(mode: SiteMode, cacheControl: string, preview: boolean): Headers {
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  // Previews run pull request content, so they stay sandboxed even on an owner's sites origin.
  if (mode === "path" || preview) headers.set("Content-Security-Policy", SITE_SANDBOX_CSP);
  if (preview) headers.set("X-Robots-Tag", "noindex");
  return headers;
}

function notModified(ifNoneMatch: string | null, etag: string): boolean {
  return ifNoneMatch?.split(",").some((value) => value.trim() === etag) ?? false;
}

interface SiteSource {
  workspace: string;
  commitOid: string;
  treeHash: string;
}

async function previewSource(
  env: GitEnv,
  repository: SiteRepositoryRow,
  oid: string
): Promise<SiteSource | null> {
  // Heads in agent session forks and user forks are served only while their pull request is not closed.
  const published = await env.DB.prepare(
    "SELECT p.head_session_id AS sessionId, s.workspace_name AS workspace, p.head_repository_id AS forkId, h.artifact_name AS forkArtifact FROM forge_check_runs c JOIN forge_pull_requests p ON p.id = c.pull_request_id LEFT JOIN auth_agent_sessions s ON s.id = p.head_session_id LEFT JOIN repositories h ON h.id = p.head_repository_id AND h.deleted_at IS NULL AND h.fork_of = p.repository_id WHERE c.repository_id = ? AND c.commit_oid = ? AND c.name = ? AND c.actor_key = ? AND (p.head_session_id IS NULL OR (p.state != 'closed' AND s.workspace_name IS NOT NULL)) AND (p.head_repository_id IS NULL OR (p.state != 'closed' AND h.artifact_name IS NOT NULL)) ORDER BY (p.head_session_id IS NULL AND p.head_repository_id IS NULL) DESC LIMIT 1"
  )
    .bind(repository.id, oid, PAGES_CHECK_NAME, PAGES_CHECK_ACTOR_KEY)
    .first<{
      sessionId: string | null;
      workspace: string | null;
      forkId: string | null;
      forkArtifact: string | null;
    }>();
  if (!published) return null;
  const workspace = published.sessionId
    ? published.workspace
    : published.forkId
      ? published.forkArtifact
      : repository.artifact_name;
  if (!workspace) return null;
  using repo = await env.ARTIFACTS.get(workspace);
  const commit = await repo.readCommit(oid);
  return commit?.hash === oid ? { workspace, commitOid: oid, treeHash: commit.treeHash } : null;
}

/**
 * Internal site endpoint. Visitors are always anonymous: only public repositories with Pages enabled
 * resolve, and every other case answers the same 404 so nothing about private repositories leaks.
 */
export async function serveSite(
  request: Request,
  env: GitEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner") ?? "";
  const slug = url.searchParams.get("repo") ?? "";
  const mode: SiteMode = url.searchParams.get("mode") === "host" ? "host" : "path";
  const previewParam = url.searchParams.get("preview");
  const search = url.searchParams.get("search") ?? "";
  const path = parseSitePath(url.searchParams.get("path") ?? "");
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  if (
    !path ||
    !owner ||
    !slug ||
    (previewParam !== null && !GitOidSchema.safeParse(previewParam).success)
  )
    return notFound();
  const logger = createLogger(env.LOG_LEVEL, { service: "git-site" });
  const repository = await env.DB.prepare(
    "SELECT r.id, r.artifact_name, r.cache_generation, r.default_branch, p.source_branch, p.folder, p.not_found_path, p.spa_fallback, p.repository_id IS NOT NULL AS has_config FROM repositories r JOIN namespaces n ON n.id = r.namespace_id LEFT JOIN repository_pages p ON p.repository_id = r.id WHERE n.slug = ? AND r.slug = ? AND r.deleted_at IS NULL AND r.visibility = 'public' AND r.pages_enabled = 1 AND r.artifact_name IS NOT NULL"
  )
    .bind(owner, slug)
    .first<SiteRepositoryRow>();
  if (!repository?.artifact_name) return notFound();
  const config: SiteConfig = {
    branch: repository.source_branch ?? repository.default_branch,
    folder: repository.folder ?? "/",
    notFoundPath: repository.has_config ? repository.not_found_path : "404.html",
    spaFallback: repository.spa_fallback === 1,
  };

  let source: SiteSource | null;
  if (previewParam) source = await previewSource(env, repository, previewParam);
  else {
    using repo = await env.ARTIFACTS.get(repository.artifact_name);
    const commit = await resolveCommit(repo, config.branch);
    source = commit
      ? { workspace: repository.artifact_name, commitOid: commit.hash, treeHash: commit.treeHash }
      : null;
  }
  if (!source) return notFound();

  const cacheControl = `public, max-age=${previewParam ? PREVIEW_MAX_AGE : BRANCH_MAX_AGE}`;
  const cache = typeof caches === "undefined" ? null : caches.default;
  const cacheKey = new Request(
    siteCacheKey(
      repository.id,
      repository.cache_generation,
      source.commitOid,
      path,
      config,
      mode,
      previewParam !== null
    )
  );
  const ifNoneMatch = request.headers.get("If-None-Match");
  const head = request.method === "HEAD";
  const cached = await cache?.match(cacheKey);
  if (cached) {
    const etag = cached.headers.get("ETag");
    if (etag && notModified(ifNoneMatch, etag)) {
      await cached.body?.cancel();
      return new Response(null, { status: 304, headers: cached.headers });
    }
    if (!head) return cached;
    await cached.body?.cancel();
    return new Response(null, { status: cached.status, headers: cached.headers });
  }

  using repo = await env.ARTIFACTS.get(source.workspace);
  const resolution = await resolveSiteEntry(repo, source.treeHash, config, path);
  if (resolution.kind === "missing") return notFound();
  if (resolution.kind === "redirect")
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${encodeURIComponent(resolution.segment)}/${search}`,
        "Cache-Control": "no-store",
      },
    });

  const etag = `"${resolution.hash}"`;
  const headers = siteHeaders(
    mode,
    resolution.status === 200 ? cacheControl : "no-cache",
    previewParam !== null
  );
  headers.set("ETag", etag);
  headers.set("Content-Type", siteContentType(resolution.name));
  if (resolution.status === 200 && notModified(ifNoneMatch, etag))
    return new Response(null, { status: 304, headers });
  let blob: Blob | null;
  try {
    blob = await repo.readBlob(resolution.hash);
  } catch (cause) {
    if (!memoryLimit(cause)) throw cause;
    logger.warn("site:file-too-large", { repoId: repository.id, size: null });
    return tooLarge();
  }
  if (!blob) return notFound();
  if (blob.size > PAGES_SITE_MAX_BYTES) {
    logger.warn("site:file-too-large", { repoId: repository.id, size: blob.size });
    return tooLarge();
  }
  headers.set("Content-Length", String(blob.size));
  const response = new Response(head ? null : blob.stream(), {
    status: resolution.status,
    headers,
  });
  if (cache && resolution.status === 200 && !head && blob.size <= CACHE_MAX_BYTES) {
    const [forCache, forClient] = response.body?.tee() ?? [null, null];
    ctx.waitUntil(
      cache.put(cacheKey, new Response(forCache, { status: 200, headers })).catch(() => {
        logger.warn("site:cache-put-failed", { repoId: repository.id });
      })
    );
    return new Response(forClient, { status: 200, headers });
  }
  return response;
}
