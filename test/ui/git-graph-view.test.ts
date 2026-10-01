import { describe, expect, it } from "vitest";
import type { AgentSession, GitCommit, GitGraph } from "../../packages/contracts/src/forge";
import {
  agentSessionDisplayStatus,
  findGraphCommit,
  projectGitGraph,
  repositoryCodeLocation,
} from "../../apps/web/src/lib/gitGraphView";
import {
  clearAgentSessionSecrets,
  clearOneTimeToken,
  isCredentialExpired,
} from "../../apps/web/src/lib/credentialSecurity";
import { authenticatedCloneCommand, gatewayCloneUrl } from "../../apps/web/src/lib/gitClone";

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

  it("builds the gateway clone URL and keeps its Auth credential in the header command", () => {
    const remote = gatewayCloneUrl("https://forge.example", "team", "repo name");
    const command = authenticatedCloneCommand(remote, "ge_token_secret");

    expect(remote).toBe("https://forge.example/team/repo%20name.git");
    expect(command).toBe(
      'git -c http.extraHeader="Authorization: Bearer ge_token_secret" clone https://forge.example/team/repo%20name.git'
    );
    expect(remote).not.toContain("ge_token_secret");
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
    expect(clearOneTimeToken(gitCredential)).toMatchObject({
      token: "",
      remote: gitCredential.remote,
    });
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
