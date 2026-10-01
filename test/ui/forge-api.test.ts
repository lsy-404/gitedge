import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/lib/api";

afterEach(() => vi.unstubAllGlobals());

describe("GitEdge forge API client", () => {
  it("loads a repository directly by namespace and slug, including the server permission result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "repo-1",
            namespaceId: "ns-1",
            owner: "example-owner",
            name: "project",
            slug: "project",
            artifactName: "example-owner/project",
            remote: "https://git.example/example-owner/project.git",
            description: "",
            visibility: "public",
            defaultBranch: "main",
            createdAt: 1,
            updatedAt: 2,
            canWrite: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const repository = await api.repository("example-owner", "project");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/forge/repositories/by-name/example-owner/project",
      expect.objectContaining({ credentials: "include" })
    );
    expect(repository.canWrite).toBe(false);
  });

  it("encodes tree paths in the query and returns only the canonical tree payload", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: { ref: "main", oid: "tree-1", path: "src/lib", entries: [] } }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const tree = await api.tree("repo /1", "main", "src/lib & docs");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/git/repositories/repo%20%2F1/tree?ref=main&path=src%2Flib+%26+docs"
    );
    expect(tree.path).toBe("src/lib");
  });

  it("never puts one-time repository tokens in request URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { remote: "https://git.example/o/r.git", token: "secret-once", expiresAt: 123 },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.repositoryToken("repo-1", { scope: "write", ttlSeconds: 3600 });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/git/repositories/repo-1/tokens");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ scope: "write", ttlSeconds: 3600 }),
    });
    expect(result.token).toBe("secret-once");
  });
});

it("requests a bounded parent graph and preserves all parent links", async () => {
  const graphPayload = {
    commits: [
      {
        oid: "head",
        tree: "tree-head",
        parents: ["main-parent", "side-parent"],
        message: "Merge",
        author: { name: "Test author", email: "author@example.invalid", timestamp: 1 },
      },
      {
        oid: "main-parent",
        tree: "tree-main",
        parents: [],
        message: "Main",
        author: { name: "Test author", email: "author@example.invalid", timestamp: 1 },
      },
      {
        oid: "side-parent",
        tree: "tree-side",
        parents: [],
        message: "Side",
        author: { name: "Test author", email: "author@example.invalid", timestamp: 1 },
      },
    ],
    refs: [],
    sessions: [],
    truncated: false,
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ data: graphPayload }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const graph = await api.graph("repo-1", "main", 100);

  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/git/repositories/repo-1/graph?ref=main&limit=100"
  );
  expect(graph.commits[0]?.parents).toEqual(["main-parent", "side-parent"]);
});
