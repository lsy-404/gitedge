import { sha256Hex } from "../../../packages/contracts/src/index";
import type { Logger } from "../../../src/worker/common/logger";

export const EDGE_CACHE_HEADER = "X-GitEdge-Cache";

/** Responses are only stored below this size; larger ones are served uncached. */
export const EDGE_CACHE_MAX_BYTES = 1024 * 1024;

const KEY_VERSION = "v1";
const STORE_TTL_CONTENT = 86_400;
const STORE_TTL_LISTING = 30;
const SHARED_TTL_REF = 30;
const IMMUTABLE_BROWSER_TTL = 86_400;
const IMMUTABLE_SHARED_TTL = 3_600;
const PRIVATE_IMMUTABLE_TTL = 3_600;
const VARY_CREDENTIALS = "Cookie, Authorization";

export type EdgeCacheStatus = "hit" | "miss" | "revalidated" | "bypass";

/**
 * How a response is addressed. Immutable content is named by a commit or blob id in the request,
 * ref content is resolved to an id on every request, and listings have no id to key on.
 */
export type EdgeAddress =
  | { readonly kind: "immutable"; readonly oid: string }
  | { readonly kind: "ref"; readonly oid: string }
  | { readonly kind: "listing" };

export interface EdgeAudience {
  /** The repository is public and the response does not depend on a private workspace. */
  readonly shared: boolean;
  /** The caller carried no identity. */
  readonly anonymous: boolean;
}

export interface RepositoryCacheScope {
  readonly repositoryId: string;
  readonly namespaceId: string;
  readonly artifactName: string;
}

/**
 * Cache keys embed the repository, its owning namespace and its storage name, so a transfer or a
 * re-import starts a fresh generation. Visibility and deletion are re-read from D1 before every
 * lookup, which keeps entries unreachable while a repository is private or deleted.
 */
export function repositoryCacheScope(repository: {
  readonly id: string;
  readonly namespaceId: string;
  readonly artifactName: string | null;
}): RepositoryCacheScope | null {
  return repository.artifactName
    ? {
        repositoryId: repository.id,
        namespaceId: repository.namespaceId,
        artifactName: repository.artifactName,
      }
    : null;
}

export function edgeCacheKey(
  scope: RepositoryCacheScope,
  resource: string,
  address: EdgeAddress,
  params: Readonly<Record<string, string>>
): Request {
  const segments = [
    KEY_VERSION,
    "public",
    scope.repositoryId,
    scope.namespaceId,
    scope.artifactName,
    resource,
    address.kind === "listing" ? "listing" : address.oid,
  ];
  const url = new URL(
    `https://edge-cache.gitedge.internal/${segments.map(encodeURIComponent).join("/")}`
  );
  for (const name of Object.keys(params).sort()) url.searchParams.set(name, params[name]);
  return new Request(url);
}

/** Cache-Control and Vary for a response, never advertising shared storage for private data. */
export function edgeCacheHeaders(
  address: EdgeAddress,
  audience: EdgeAudience
): Record<string, string> {
  const publicAnonymous = audience.shared && audience.anonymous;
  if (address.kind === "immutable")
    return audience.shared
      ? {
          "Cache-Control": `public, max-age=${IMMUTABLE_BROWSER_TTL}, s-maxage=${IMMUTABLE_SHARED_TTL}, immutable`,
        }
      : {
          "Cache-Control": `private, max-age=${PRIVATE_IMMUTABLE_TTL}`,
          Vary: VARY_CREDENTIALS,
        };
  if (publicAnonymous)
    return { "Cache-Control": `public, max-age=0, s-maxage=${SHARED_TTL_REF}, must-revalidate` };
  return address.kind === "ref"
    ? { "Cache-Control": "private, no-cache", Vary: VARY_CREDENTIALS }
    : { "Cache-Control": "private, no-store" };
}

/** Streamed downloads are never stored by the Worker; private ones are not kept by any cache. */
export function edgeDownloadHeaders(
  address: EdgeAddress,
  audience: EdgeAudience
): Record<string, string> {
  return {
    ...(audience.shared
      ? edgeCacheHeaders(address, audience)
      : { "Cache-Control": "private, no-store" }),
    [EDGE_CACHE_HEADER]: "bypass",
  };
}

export function matchesEtag(header: string | null, etag: string): boolean {
  return (
    header?.split(",").some((value) => {
      const candidate = value.trim();
      return candidate === "*" || candidate === etag || candidate === `W/${etag}`;
    }) ?? false
  );
}

export function etagFor(oid: string): string {
  return `"${oid}"`;
}

function statusHeaders(status: EdgeCacheStatus, started: number): Record<string, string> {
  return {
    [EDGE_CACHE_HEADER]: status,
    "Server-Timing": `edge-cache;desc="${status}";dur=${Date.now() - started}`,
  };
}

export interface EdgeReadInput {
  readonly request: Request;
  readonly cache: Cache;
  /** Background scheduler; without one the cache write is awaited. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  readonly logger: Logger;
  readonly scope: RepositoryCacheScope;
  readonly resource: string;
  /** Null when the ref cannot be resolved to an id; the read is then served uncached. */
  readonly address: EdgeAddress | null;
  readonly audience: EdgeAudience;
  /** Request parameters that change the response body. */
  readonly params: Readonly<Record<string, string>>;
  readonly compute: () => Promise<Response>;
}

function jsonResponse(
  body: string,
  head: boolean,
  headers: Record<string, string>,
  contentType: string
): Response {
  return new Response(head ? null : body, {
    status: 200,
    headers: { "Content-Type": contentType, ...headers },
  });
}

/**
 * Serves a JSON read through the Cache API. Only public, non-workspace reads are stored or
 * served from the cache; every other read is computed and only labelled. The caller has already
 * authorised the request against current repository state.
 */
export async function serveEdgeRead(input: EdgeReadInput): Promise<Response> {
  const { request, address, audience, logger } = input;
  const started = Date.now();
  const head = request.method === "HEAD";
  const conditional = request.headers.get("If-None-Match");
  const known = address && address.kind !== "listing" ? etagFor(address.oid) : null;
  const headers = address ? edgeCacheHeaders(address, audience) : { "Cache-Control": "no-store" };
  const notModified = (etag: string, status: EdgeCacheStatus) =>
    new Response(null, {
      status: 304,
      headers: { ETag: etag, ...headers, ...statusHeaders(status, started) },
    });

  if (known && matchesEtag(conditional, known)) return notModified(known, "revalidated");

  if (!address || !audience.shared || (address.kind === "listing" && !audience.anonymous)) {
    const response = await input.compute();
    if (!response.ok) return response;
    const text = await response.text();
    return jsonResponse(
      text,
      head,
      {
        ETag: known ?? `"${await sha256Hex(text)}"`,
        ...headers,
        ...statusHeaders("bypass", started),
      },
      response.headers.get("Content-Type") ?? "application/json"
    );
  }

  const key = edgeCacheKey(input.scope, input.resource, address, input.params);
  try {
    const stored = await input.cache.match(key);
    if (stored) {
      const etag = stored.headers.get("ETag") ?? known;
      if (etag && matchesEtag(conditional, etag)) {
        void stored.body?.cancel().catch(() => undefined);
        return notModified(etag, "hit");
      }
      return new Response(head ? null : stored.body, {
        status: 200,
        headers: {
          "Content-Type": stored.headers.get("Content-Type") ?? "application/json",
          ...(etag ? { ETag: etag } : {}),
          ...headers,
          ...statusHeaders("hit", started),
        },
      });
    }
  } catch (cause) {
    logger.warn("git:edge-cache-read-failed", {
      resource: input.resource,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }

  const response = await input.compute();
  if (!response.ok) return response;
  const text = await response.text();
  const etag = known ?? `"${await sha256Hex(text)}"`;
  const contentType = response.headers.get("Content-Type") ?? "application/json";
  if (text.length <= EDGE_CACHE_MAX_BYTES) {
    const ttl = address.kind === "listing" ? STORE_TTL_LISTING : STORE_TTL_CONTENT;
    const write = input.cache
      .put(
        key,
        new Response(text, {
          headers: {
            "Content-Type": contentType,
            ETag: etag,
            "Cache-Control": `public, max-age=${ttl}`,
          },
        })
      )
      .catch((cause: unknown) =>
        logger.warn("git:edge-cache-write-failed", {
          resource: input.resource,
          error: cause instanceof Error ? cause.message : "unknown",
        })
      );
    if (input.waitUntil) input.waitUntil(write);
    else await write;
  } else {
    logger.warn("git:edge-cache-skipped", { resource: input.resource, bytes: text.length });
  }
  if (matchesEtag(conditional, etag)) return notModified(etag, "miss");
  return jsonResponse(
    text,
    head,
    { ETag: etag, ...headers, ...statusHeaders("miss", started) },
    contentType
  );
}
