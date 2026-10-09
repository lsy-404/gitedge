import { describe, expect, it, vi } from "vitest";
import {
  EDGE_CACHE_MAX_BYTES,
  edgeCacheHeaders,
  edgeCacheKey,
  matchesEtag,
  repositoryCacheScope,
  serveEdgeRead,
  type EdgeAddress,
  type EdgeAudience,
  type RepositoryCacheScope,
} from "../../workers/git/src/edge-cache";
import { edgeAddress, edgeReference } from "../../workers/git/src/edge-reference";
import { createLogger } from "../../src/worker/common/logger";
import { MemoryCache } from "../support/memory-cache";

const oid = "a".repeat(40);
const other = "b".repeat(40);
const scope: RepositoryCacheScope = {
  repositoryId: "repo-1",
  namespaceId: "ns-1",
  artifactName: "artifact-1",
};
const publicAnonymous: EdgeAudience = { shared: true, anonymous: true };
const publicSignedIn: EdgeAudience = { shared: true, anonymous: false };
const privateReader: EdgeAudience = { shared: false, anonymous: false };
const logger = createLogger("error", { service: "test" });

function read(
  cache: MemoryCache,
  overrides: Partial<Parameters<typeof serveEdgeRead>[0]> & {
    compute?: () => Promise<Response>;
  } = {}
) {
  const compute = overrides.compute ?? (async () => Response.json({ data: { value: 1 } }));
  return serveEdgeRead({
    request: new Request("https://git.test/repositories/repo-1/tree?ref=main"),
    cache,
    logger,
    scope,
    resource: "tree",
    address: { kind: "ref", oid },
    audience: publicAnonymous,
    params: { ref: "main", path: "" },
    compute,
    ...overrides,
  });
}

describe("edge cache keys", () => {
  const address: EdgeAddress = { kind: "ref", oid };

  it("is built from repository generation, resource, id and parameters", () => {
    const key = new URL(edgeCacheKey(scope, "tree", address, { path: "src", ref: "main" }).url);
    expect(key.pathname).toBe(`/v1/public/repo-1/ns-1/artifact-1/tree/${oid}`);
    expect(key.search).toBe("?path=src&ref=main");
  });

  it("ignores parameter order and never carries credentials", () => {
    const a = edgeCacheKey(scope, "tree", address, { path: "src", ref: "main" });
    const b = edgeCacheKey(scope, "tree", address, { ref: "main", path: "src" });
    expect(a.url).toBe(b.url);
    expect(JSON.stringify([...a.headers])).toBe("[]");
  });

  it("changes with the commit, resource, path and repository generation", () => {
    const base = edgeCacheKey(scope, "tree", address, { path: "" }).url;
    const variants = [
      edgeCacheKey(scope, "tree", { kind: "ref", oid: other }, { path: "" }),
      edgeCacheKey(scope, "file", address, { path: "" }),
      edgeCacheKey(scope, "tree", address, { path: "docs" }),
      edgeCacheKey({ ...scope, namespaceId: "ns-2" }, "tree", address, { path: "" }),
      edgeCacheKey({ ...scope, artifactName: "artifact-2" }, "tree", address, { path: "" }),
      edgeCacheKey({ ...scope, repositoryId: "repo-2" }, "tree", address, { path: "" }),
      edgeCacheKey(scope, "tree", { kind: "listing" }, { path: "" }),
    ].map((request) => request.url);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("is absent for repositories without Artifacts storage", () => {
    expect(repositoryCacheScope({ id: "r", namespaceId: "n", artifactName: null })).toBeNull();
    expect(repositoryCacheScope({ id: "r", namespaceId: "n", artifactName: "a" })).toEqual({
      repositoryId: "r",
      namespaceId: "n",
      artifactName: "a",
    });
  });
});

describe("edge cache headers", () => {
  it("makes commit-addressed public content immutable and shareable", () => {
    expect(edgeCacheHeaders({ kind: "immutable", oid }, publicAnonymous)).toEqual({
      "Cache-Control": "public, max-age=86400, s-maxage=3600, immutable",
    });
    expect(edgeCacheHeaders({ kind: "immutable", oid }, publicSignedIn)["Cache-Control"]).toContain(
      "immutable"
    );
  });

  it("keeps private commit-addressed content out of shared caches", () => {
    expect(edgeCacheHeaders({ kind: "immutable", oid }, privateReader)).toEqual({
      "Cache-Control": "private, max-age=3600",
      Vary: "Cookie, Authorization",
    });
  });

  it("gives ref-addressed public reads a short shared lifetime", () => {
    expect(edgeCacheHeaders({ kind: "ref", oid }, publicAnonymous)).toEqual({
      "Cache-Control": "public, max-age=0, s-maxage=30, must-revalidate",
    });
  });

  it("never shares ref-addressed reads for signed-in or private callers", () => {
    for (const audience of [publicSignedIn, privateReader])
      expect(edgeCacheHeaders({ kind: "ref", oid }, audience)).toEqual({
        "Cache-Control": "private, no-cache",
        Vary: "Cookie, Authorization",
      });
  });

  it("shares listings only with anonymous readers of public repositories", () => {
    expect(edgeCacheHeaders({ kind: "listing" }, publicAnonymous)["Cache-Control"]).toContain(
      "s-maxage=30"
    );
    expect(edgeCacheHeaders({ kind: "listing" }, publicSignedIn)["Cache-Control"]).toBe(
      "private, no-store"
    );
    expect(edgeCacheHeaders({ kind: "listing" }, privateReader)["Cache-Control"]).toBe(
      "private, no-store"
    );
  });
});

describe("conditional requests", () => {
  it("matches strong, weak, listed and wildcard validators", () => {
    expect(matchesEtag(`"${oid}"`, `"${oid}"`)).toBe(true);
    expect(matchesEtag(`W/"${oid}"`, `"${oid}"`)).toBe(true);
    expect(matchesEtag(`"x", "${oid}"`, `"${oid}"`)).toBe(true);
    expect(matchesEtag("*", `"${oid}"`)).toBe(true);
    expect(matchesEtag(`"${other}"`, `"${oid}"`)).toBe(false);
    expect(matchesEtag(null, `"${oid}"`)).toBe(false);
  });
});

describe("edge reads", () => {
  it("computes once, then serves hits from the cache", async () => {
    const cache = new MemoryCache();
    const compute = vi.fn(async () => Response.json({ data: { value: 1 } }));
    const miss = await read(cache, { compute });
    expect(miss.headers.get("X-GitEdge-Cache")).toBe("miss");
    expect(miss.headers.get("ETag")).toBe(`"${oid}"`);
    expect(miss.headers.get("Server-Timing")).toContain('desc="miss"');
    const hit = await read(cache, { compute });
    expect(hit.headers.get("X-GitEdge-Cache")).toBe("hit");
    expect(await hit.json()).toEqual({ data: { value: 1 } });
    expect(hit.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=30, must-revalidate"
    );
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("stores the entry under a key with the resolved commit so a moved ref misses", async () => {
    const cache = new MemoryCache();
    const compute = vi.fn(async () => Response.json({ data: 1 }));
    await read(cache, { compute });
    const moved = await read(cache, { compute, address: { kind: "ref", oid: other } });
    expect(moved.headers.get("X-GitEdge-Cache")).toBe("miss");
    expect(moved.headers.get("ETag")).toBe(`"${other}"`);
    expect(cache.entries.size).toBe(2);
  });

  it("serves signed-in readers of a public repository from the shared entry", async () => {
    const cache = new MemoryCache();
    await read(cache);
    const hit = await read(cache, { audience: publicSignedIn });
    expect(hit.headers.get("X-GitEdge-Cache")).toBe("hit");
    expect(hit.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("never reads or stores private reads, even when an entry exists", async () => {
    const cache = new MemoryCache();
    await read(cache);
    cache.reads = 0;
    cache.writes = 0;
    const compute = vi.fn(async () => Response.json({ data: { secret: true } }));
    const response = await read(cache, { compute, audience: privateReader });
    expect(response.headers.get("X-GitEdge-Cache")).toBe("bypass");
    expect(await response.json()).toEqual({ data: { secret: true } });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.reads).toBe(0);
    expect(cache.writes).toBe(0);
  });

  it("does not share listings with signed-in readers", async () => {
    const cache = new MemoryCache();
    const response = await read(cache, {
      address: { kind: "listing" },
      audience: publicSignedIn,
    });
    expect(response.headers.get("X-GitEdge-Cache")).toBe("bypass");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(cache.writes).toBe(0);
  });

  it("caches listings for anonymous readers and validates them by body", async () => {
    const cache = new MemoryCache();
    const first = await read(cache, { address: { kind: "listing" }, resource: "refs" });
    const etag = first.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const stored = [...cache.entries.values()][0];
    expect(stored.headers.get("Cache-Control")).toBe("public, max-age=30");
    const conditional = await read(cache, {
      address: { kind: "listing" },
      resource: "refs",
      request: new Request("https://git.test/repositories/repo-1/refs", {
        headers: { "If-None-Match": etag ?? "" },
      }),
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get("X-GitEdge-Cache")).toBe("hit");
  });

  it("answers If-None-Match with 304 before computing", async () => {
    const cache = new MemoryCache();
    const compute = vi.fn(async () => Response.json({ data: 1 }));
    const response = await read(cache, {
      compute,
      request: new Request("https://git.test/repositories/repo-1/tree", {
        headers: { "If-None-Match": `"${oid}"` },
      }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(`"${oid}"`);
    expect(response.headers.get("X-GitEdge-Cache")).toBe("revalidated");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=30");
    expect(await response.text()).toBe("");
    expect(compute).not.toHaveBeenCalled();
  });

  it("answers 304 for private readers without exposing a shared policy", async () => {
    const response = await read(new MemoryCache(), {
      audience: privateReader,
      request: new Request("https://git.test/repositories/repo-1/tree", {
        headers: { "If-None-Match": `"${oid}"` },
      }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
  });

  it("returns no body for HEAD and still fills the cache", async () => {
    const cache = new MemoryCache();
    const response = await read(cache, {
      request: new Request("https://git.test/repositories/repo-1/tree", { method: "HEAD" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(cache.writes).toBe(1);
  });

  it("passes errors through without storing them", async () => {
    const cache = new MemoryCache();
    const response = await read(cache, {
      compute: async () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
    });
    expect(response.status).toBe(404);
    expect(cache.writes).toBe(0);
  });

  it("serves oversized responses without storing them", async () => {
    const cache = new MemoryCache();
    const response = await read(cache, {
      compute: async () => Response.json({ data: "x".repeat(EDGE_CACHE_MAX_BYTES + 1) }),
    });
    expect(response.status).toBe(200);
    expect(cache.writes).toBe(0);
  });

  it("falls back to computing when the cache fails", async () => {
    const cache = new MemoryCache();
    cache.match = async () => {
      throw new Error("cache unavailable");
    };
    const response = await read(cache);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-GitEdge-Cache")).toBe("miss");
  });

  it("serves unresolved refs uncached with no-store", async () => {
    const cache = new MemoryCache();
    const response = await read(cache, { address: null });
    expect(response.headers.get("X-GitEdge-Cache")).toBe("bypass");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(cache.writes).toBe(0);
  });

  it("schedules the write in the background when a scheduler exists", async () => {
    const cache = new MemoryCache();
    const pending: Promise<unknown>[] = [];
    await read(cache, { waitUntil: (promise) => pending.push(promise) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(cache.writes).toBe(1);
  });
});

describe("edge references", () => {
  const url = (query: string) => new URL(`https://git.test/repositories/r/x?${query}`);

  it("classifies cacheable resources and skips the rest", () => {
    expect(edgeReference("tree", url("ref=main&path=src"), "main", "src")).toEqual({
      ref: "main",
      params: { ref: "main", path: "src" },
    });
    expect(edgeReference("refs", url(""), "main", "")).toEqual({ ref: null, params: {} });
    expect(edgeReference("commits", url("limit=5&offset=10"), "main", "")?.params).toEqual({
      ref: "main",
      limit: "5",
      offset: "10",
    });
    expect(edgeReference("commit-diff", url(`oid=${oid}`), "main", "")?.ref).toBe(oid);
    expect(edgeReference("commit-diff", url("oid=bad"), "main", "")).toBeNull();
    expect(edgeReference("history", url(`cursor=${other}&path=a`), "main", "a")?.ref).toBe(other);
    for (const resource of ["graph", "compare", "community", "snapshot", "signature", "raw"])
      expect(edgeReference(resource, url(""), "main", "")).toBeNull();
  });

  it("resolves branches to commits and keeps full ids immutable", async () => {
    const commit: ArtifactsCommitMetadata = {
      hash: other,
      treeHash: oid,
      message: "m",
      author: { name: "a", email: "a@example.test" },
      committer: { name: "a", email: "a@example.test" },
      parents: [],
      authoredAt: 1,
      committedAt: 1,
    };
    const repo = { log: vi.fn(async () => [commit]) };
    const reference = { ref: "main", params: {} };
    expect(await edgeAddress(repo, reference, true)).toEqual({ kind: "ref", oid: other });
    expect(await edgeAddress(repo, { ref: oid, params: {} }, true)).toEqual({
      kind: "immutable",
      oid,
    });
    expect(await edgeAddress(repo, { ref: null, params: {} }, true)).toEqual({
      kind: "listing",
    });
    repo.log.mockClear();
    expect(await edgeAddress(repo, reference, false)).toBeNull();
    expect(repo.log).not.toHaveBeenCalled();
  });
});
