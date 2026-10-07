import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../apps/web/src/lib/api";
import { i18n } from "../../apps/web/src/i18n";

describe("GitEdge API client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("unwraps the auth response envelope and sends the service payload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "u1", identifier: "example-owner" } }), {
        status: 200,
      })
    );

    const user = await api.login({ identifier: "example-owner", password: "a".repeat(12) });

    expect(user.identifier).toBe("example-owner");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ identifier: "example-owner", password: "a".repeat(12) }),
      })
    );
  });

  it("uses repository ids and unwraps Forge list responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    await api.issues("repo-7");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/forge/repositories/repo-7/issues",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("resolves public and private repositories directly with server-provided permissions", async () => {
    const repository = {
      id: "repo-7",
      namespaceId: "ns-1",
      owner: "example-owner",
      name: "edge",
      slug: "edge",
      artifactName: "example-owner/edge",
      remote: "https://git.example/example-owner/edge.git",
      description: "",
      visibility: "public",
      defaultBranch: "main",
      createdAt: 1,
      updatedAt: 1,
      canWrite: false,
      archived: false,
      issuesEnabled: true,
      pullsEnabled: true,
      discussionsEnabled: true,
      wikiEnabled: true,
      requiredApprovals: 0,
      requirePassingChecks: false,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ data: repository }), { status: 200 }));

    const result = await api.repository("example-owner", "edge");

    expect(result.canWrite).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/forge/repositories/by-name/example-owner/edge",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("translates UI fields into the Forge repository contract", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "repo-7" } }), { status: 201 })
    );

    await api.createRepository({
      owner: "example-owner",
      name: "edge",
      description: "At the edge",
      visibility: "public",
      initializeReadme: true,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/forge/repositories",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          slug: "edge",
          owner: "example-owner",
          description: "At the edge",
          visibility: "public",
          initializeReadme: true,
        }),
      })
    );
  });

  it("uses the repository control endpoints and methods", async () => {
    const responseBody = { data: { id: "rule-1" } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = init?.method === "DELETE" ? { data: { deleted: true } } : responseBody;
      return new Response(JSON.stringify(data), { status: 200 });
    });
    const rule = {
      pattern: "main",
      enabled: true,
      locked: false,
      requiredApprovals: 1,
      requirePassingChecks: true,
      requiredStatusChecks: ["unit"],
      requireLinearHistory: false,
      requireSignedCommits: false,
    };

    await api.branchRules("repo-7");
    await api.createBranchRule("repo-7", rule);
    await api.updateBranchRule("repo-7", "rule-1", rule);
    await api.deleteBranchRule("repo-7", "rule-1");
    await api.repositoryCollaborators("repo-7");
    await api.putRepositoryCollaborator("repo-7", { identifier: "octocat", role: "write" });
    await api.deleteRepositoryCollaborator("repo-7", "user / 1");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/forge/repositories/repo-7/branch-rules", undefined],
      ["/api/forge/repositories/repo-7/branch-rules", "POST"],
      ["/api/forge/repositories/repo-7/branch-rules/rule-1", "PATCH"],
      ["/api/forge/repositories/repo-7/branch-rules/rule-1", "DELETE"],
      ["/api/forge/repositories/repo-7/collaborators", undefined],
      ["/api/forge/repositories/repo-7/collaborators", "PUT"],
      ["/api/forge/repositories/repo-7/collaborators/user%20%2F%201", "DELETE"],
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(rule));
    expect(fetchMock.mock.calls[5]?.[1]?.body).toBe(
      JSON.stringify({ identifier: "octocat", role: "write" })
    );
  });

  it("loads public profiles and repository community files from their public endpoints", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await api.publicProfile("org / person");
    await api.repositoryCommunity("repo / 1", "feature/topic");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/forge/profiles/org%20%2F%20person",
      "/api/git/repositories/repo%20%2F%201/community?ref=feature%2Ftopic",
    ]);
  });

  it("exposes organization endpoints and preserves the owner namespace", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await api.organizations();
    await api.organizationMembers("acme");
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/forge/organizations", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/forge/organizations/acme/members",
      expect.anything()
    );
  });

  it("sends organization creation and member role payloads", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 201 }));
    await api.createOrganization({ slug: "acme", displayName: "Acme", description: "Team" });
    await api.addOrganizationMember("acme", { identifier: "dev", role: "member" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/forge/organizations",
      expect.objectContaining({
        body: JSON.stringify({ slug: "acme", displayName: "Acme", description: "Team" }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/forge/organizations/acme/members",
      expect.objectContaining({ body: JSON.stringify({ identifier: "dev", role: "member" }) })
    );
  });

  it("uses Forge field names and a slug-addressed wiki endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: {} }), { status: 201 }));

    await api.createPullRequest("repo-7", {
      title: "Ship it",
      body: "Ready",
      headRef: "feature",
      baseRef: "main",
    });
    await api.updateWikiPage("repo-7", "home", { title: "Home", content: "Welcome" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/forge/repositories/repo-7/pull-requests",
      expect.objectContaining({
        body: JSON.stringify({
          title: "Ship it",
          body: "Ready",
          headRef: "feature",
          baseRef: "main",
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/forge/repositories/repo-7/wiki/home",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ title: "Home", content: "Welcome" }),
      })
    );
  });

  it("exposes the status when the API rejects a request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));

    await expect(api.session()).rejects.toMatchObject<ApiError>({ status: 401 });
  });
});

describe("GitEdge product shell", () => {
  it("ships Chinese and English product language keys", () => {
    expect(i18n.global.t("brand")).toBe("GitEdge");
    i18n.global.locale.value = "en";
    expect(i18n.global.t("signIn")).toBe("Sign in");
    i18n.global.locale.value = "zh-CN";
  });

  it("keeps both locales in step and has dropped the GitHub access-level copy", () => {
    const messages = i18n.global.messages.value;
    const keys = (tree: object, prefix = ""): string[] =>
      Object.entries(tree).flatMap(([name, value]) =>
        typeof value === "object" && value !== null
          ? keys(value, `${prefix}${name}.`)
          : [`${prefix}${name}`]
      );
    const chinese = keys(messages["zh-CN"]).sort();
    const english = keys(messages.en).sort();
    expect(chinese).toEqual(english);

    const retired = [
      "githubIdentity",
      "githubRead",
      "identityTitle",
      "identityText",
      "readTitle",
      "readText",
      "noWriteScope",
      "identityAccess",
      "readAccess",
      "accessLevel",
      "emails",
      "noConnectedData",
      "oauthError",
    ];
    for (const key of retired) expect(english).not.toContain(key);
  });

  it("labels external sign-in providers neutrally", () => {
    i18n.global.locale.value = "en";
    expect(i18n.global.t("providerGithub")).toBe("GitHub");
    expect(i18n.global.t("providerOidc")).toBe("SSO");
    expect(i18n.global.t("continueWith", { provider: "Acme" })).toBe("Continue with Acme");
    i18n.global.locale.value = "zh-CN";
  });
});
