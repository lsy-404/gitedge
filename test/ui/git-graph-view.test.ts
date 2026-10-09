import { describe, expect, it } from "vitest";
import type { AgentSession, GitCommit, GitGraph } from "../../packages/contracts/src/forge";
import {
  agentSessionDisplayStatus,
  findGraphCommit,
  layoutGitGraph,
  projectGitGraph,
  repositoryCodeLocation,
} from "../../apps/web/src/lib/gitGraphView";
import {
  clearAgentSessionSecrets,
  isCredentialExpired,
} from "../../apps/web/src/lib/credentialSecurity";
import {
  cloneCommand,
  credentialHelperHints,
  existingRepositoryCommands,
  gatewayCloneUrl,
  newRepositoryCommands,
} from "../../apps/web/src/lib/gitClone";

function session(
  id: string,
  baseOid: string | null,
  permission: AgentSession["permission"] = "read",
  status: AgentSession["status"] = "active"
): AgentSession {
  return {
    id,
    agentId: `agent-${id}`,
    agentName: `Agent ${id}`,
    repositoryId: "repo-1",
    workspaceName: `workspace-${id}`,
    remote: "https://git.example/repo.git",
    baseRef: "main",
    baseOid,
    permission,
    status,
    createdAt: 1,
    expiresAt: 10_000,
  };
}

function commit(oid: string, parents: string[] = []): GitCommit {
  return {
    oid,
    tree: `tree-${oid}`,
    parents,
    message: `Commit ${oid}`,
    author: { name: "Example author", email: "author@example.invalid", timestamp: 1 },
  };
}

describe("Git graph view projection", () => {
  it("preserves shared bases and associates graph-provided session refs with fork tips", () => {
    const graph: GitGraph = {
      commits: [commit("base"), commit("tip-a", ["base"]), commit("tip-b", ["base"])],
      refs: [
        { name: "refs/heads/main", oid: "base" },
        { name: "session/a/main", oid: "tip-a" },
        { name: "session/b/feature/deep", oid: "tip-b" },
      ],
      sessions: [session("a", "base"), session("b", "base", "write")],
      truncated: false,
    };

    const view = projectGitGraph(graph);

    expect(view.refsByOid.get("base")).toEqual(["main"]);
    expect(view.refsByOid.get("tip-b")).toEqual(["workspace-b:feature/deep"]);
    expect(view.sessionsByOid.get("base")?.map((marker) => marker.session.id)).toEqual(["a", "b"]);
    expect(view.sessionsByOid.get("tip-a")?.[0]).toMatchObject({
      kind: "fork",
      branchName: "main",
    });
    expect(view.sessionsByOid.get("tip-b")?.[0]).toMatchObject({
      kind: "fork",
      branchName: "feature/deep",
    });
    expect(view.sessionForkRefCount).toBe(2);
    expect(view.sessionsWithForkRefs).toBe(2);
    expect(view.sessionsWithoutForkRefs).toBe(0);
  });

  it("counts omitted session refs while preserving revoked sessions as historical base markers", () => {
    const revoked = session("revoked", "stale", "read", "revoked");
    const graph: GitGraph = {
      commits: [],
      refs: [],
      sessions: [session("no-ref", "base"), revoked],
      truncated: false,
    };

    const view = projectGitGraph(graph);

    expect(view.visibleSessionCount).toBe(1);
    expect(view.sessionsWithForkRefs).toBe(0);
    expect(view.sessionsWithoutForkRefs).toBe(1);
    expect(view.sessionsByOid.get("base")).toHaveLength(1);
    expect(view.sessionsByOid.get("stale")?.[0]?.session.status).toBe("revoked");
  });

  it("finds graph commits outside the current page and keeps slash refs in query state", () => {
    const older = commit("older-commit");
    const graph: GitGraph = { commits: [older], refs: [], sessions: [], truncated: true };

    expect(findGraphCommit("older-commit", graph, [commit("page-commit")])).toEqual(older);
    expect(
      repositoryCodeLocation("owner", "repo", "blob", "src/lib/file.ts", "feature/with/slashes")
    ).toEqual({
      path: "/owner/repo/blob/src/lib/file.ts",
      query: { ref: "feature/with/slashes" },
    });
  });

  it("builds the gateway clone URL and a credential-free clone command", () => {
    const remote = gatewayCloneUrl("https://forge.example", "team", "repo name");
    expect(remote).toBe("https://forge.example/team/repo%20name.git");
    expect(cloneCommand("https://forge.example/team/repo.git")).toBe(
      "git clone https://forge.example/team/repo.git"
    );
    expect(cloneCommand(remote)).toBe("git clone https://forge.example/team/repo%20name.git");
    expect(cloneCommand("https://forge.example/team/$(touch-pwned).git")).toContain(
      "'https://forge.example/team/$(touch-pwned).git'"
    );
  });

  it("offers credential helpers per platform and flags the plain-text store", () => {
    expect(credentialHelperHints.map((hint) => hint.id)).toEqual([
      "osxkeychain",
      "manager",
      "libsecret",
      "store",
    ]);
    expect(credentialHelperHints.filter((hint) => hint.plaintext).map((hint) => hint.id)).toEqual([
      "store",
    ]);
    for (const hint of credentialHelperHints)
      expect(hint.command).toBe(`git config --global credential.helper ${hint.id}`);
  });

  it("builds copy-paste quickstart commands", () => {
    const remote = "https://forge.example/team/repo.git";
    const fresh = newRepositoryCommands(remote, "repo", "main").split("\n");
    expect(fresh).toContain(`git remote add origin ${remote}`);
    expect(fresh).toContain("git push -u origin main");
    expect(existingRepositoryCommands(remote)).toContain(`git remote add gitedge ${remote}`);
    expect(fresh.join("\n")).not.toContain("gep_");
  });

  it("clears expired one-time Git and agent credentials and detects expiry at the deadline", () => {
    const gitCredential = {
      remote: "https://git.example/repo.git",
      token: "git-secret",
      expiresAt: 10_000,
    };
    const agentCredential = {
      ...session("created", "base"),
      token: "api-secret",
      gitToken: "session-git-secret",
      instructions: null,
    };

    expect(isCredentialExpired(gitCredential.expiresAt, 9_999)).toBe(false);
    expect(isCredentialExpired(gitCredential.expiresAt, 10_000)).toBe(true);
    expect(clearAgentSessionSecrets(agentCredential)).toMatchObject({ token: "", gitToken: "" });
  });

  it("marks an elapsed active session as expired without changing terminal states", () => {
    expect(agentSessionDisplayStatus(session("elapsed", null), 10_000)).toBe("expired");
    expect(agentSessionDisplayStatus(session("done", null, "read", "completed"), 20_000)).toBe(
      "completed"
    );
    expect(agentSessionDisplayStatus(session("revoked", null, "read", "revoked"), 20_000)).toBe(
      "revoked"
    );
  });
});

it("connects every merge edge to the displayed parent lane", () => {
  const commits = [
    commit("merge", ["left", "right"]),
    commit("right", ["base"]),
    commit("left", ["base"]),
    commit("base"),
  ];
  const graph = layoutGitGraph(commits);
  expect(graph.edges).toHaveLength(4);
  for (const edge of graph.edges) {
    const source = graph.points[edge.fromRow];
    const target = graph.points[edge.toRow];
    expect(source.lane).toBe(edge.fromLane);
    expect(target.lane).toBe(edge.toLane);
    expect(source.commit.parents).toContain(target.commit.oid);
  }
  expect(graph.points.map((point) => point.commit.oid)).toEqual(commits.map((item) => item.oid));
});
