import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { resolveWorkspace, type GitRepositoryAccess } from "../../workers/git/src/access";
import { createRepositoryBranch } from "../../workers/git/src/write";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const users = {
  owner: { id: "owner-id", identifier: "owner", groupKey: "free" },
  writer: { id: "writer-id", identifier: "writer", groupKey: "free" },
};
const ZERO = "0".repeat(40);
let repositoryId = "";
let artifactName = "";

async function forgeCall(path: string, method: string, body?: unknown) {
  const headers = trustedHeaders(users.owner);
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request("https://forge.test" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts, GIT: { fetch: async () => Response.json({ data: [] }) } }
  );
}
async function gitCall(
  resource: string,
  method: string,
  body: unknown,
  user: keyof typeof users = "owner"
) {
  const headers = trustedHeaders(users[user]);
  headers.set("Content-Type", "application/json");
  return gitWorker.fetch(
    new Request(`https://forge.test/repositories/${repositoryId}/${resource}`, {
      method,
      headers,
      body: JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts }
  );
}
function receivePack(commands: string[]): Request {
  const headers = trustedHeaders(users.owner);
  headers.set("X-GitEdge-Git-Grant", JSON.stringify({ repositoryId, permission: "write" }));
  const encoder = new TextEncoder();
  const lines = commands.map((command, index) => {
    const text = index === 0 ? `${command}\0report-status\n` : `${command}\n`;
    return (encoder.encode(text).length + 4).toString(16).padStart(4, "0") + text;
  });
  return new Request("https://forge.test/owner/mutations.git/git-receive-pack", {
    method: "POST",
    headers,
    body: lines.join("") + "0000PACK",
  });
}
const tokenCount = () => artifacts.snapshot(artifactName).tokens.length;
const oid = (char: string) => char.repeat(40);

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of Object.values(users))
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'salt','hash',1)"
    )
      .bind(user.id, user.identifier)
      .run();
  await env.DB.prepare(
    "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('ns','owner','owner-id',1,'personal')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('ns','owner-id','owner',1)"
  ).run();
  const created = await forgeCall("/repositories", "POST", {
    owner: "owner",
    slug: "mutations",
    visibility: "private",
  });
  expect(created.status).toBe(201);
  repositoryId = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json())
    .data.id;
  expect(
    (
      await forgeCall(`/repositories/${repositoryId}/collaborators`, "PUT", {
        identifier: "writer",
        role: "write",
      })
    ).status
  ).toBe(200);
  const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id=?")
    .bind(repositoryId)
    .first<{ name: string }>();
  artifactName = z.string().parse(row?.name);
});
afterEach(() => vi.unstubAllGlobals());

describe("Git mutation guards", () => {
  it("refuses to delete the default branch through the web API", async () => {
    const response = await gitCall("branches", "DELETE", { name: "main", expectedOid: oid("a") });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "default_branch" } });
  });

  it("refuses a new branch that already exists without minting a write token", async () => {
    const before = tokenCount();
    const response = await gitCall("edit", "POST", {
      branch: "main",
      newBranch: "main",
      expectedOid: null,
      path: "README.md",
      content: "x",
      message: "x",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
    expect(tokenCount()).toBe(before);
  });

  it("refuses an edit whose expected OID is stale without minting a write token", async () => {
    const before = tokenCount();
    const response = await gitCall("edit", "POST", {
      branch: "main",
      expectedOid: oid("f"),
      path: "README.md",
      content: "x",
      message: "x",
    });
    expect(response.status).toBe(409);
    expect(tokenCount()).toBe(before);
  });

  it("rejects merges with stale head or base OIDs before minting tokens", async () => {
    const repo = await artifacts.get(artifactName);
    const [current] = await repo.log({ ref: "main", limit: 1 });
    repo[Symbol.dispose]();
    const before = tokenCount();
    for (const stale of [
      { expectedBaseOid: current.hash, expectedHeadOid: oid("e") },
      { expectedBaseOid: oid("e"), expectedHeadOid: current.hash },
    ]) {
      const response = await gitCall("merge", "POST", {
        pullRequestId: "pr",
        leaseAt: 1,
        baseRef: "main",
        headRef: "topic",
        author: { name: "owner", email: "owner@example.invalid" },
        message: "merge",
        ...stale,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
    }
    expect(tokenCount()).toBe(before);
  });

  it("rejects merges that omit the pull request lease", async () => {
    const response = await gitCall("merge", "POST", {
      baseRef: "main",
      headRef: "topic",
      expectedBaseOid: oid("a"),
      expectedHeadOid: oid("b"),
      author: { name: "owner", email: "owner@example.invalid" },
      message: "merge",
    });
    expect(response.status).toBe(400);
  });
});

describe("Native receive-pack default branch protection", () => {
  it("rejects deleting the default branch even without branch rules", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await gitWorker.fetch(receivePack([`${oid("a")} ${ZERO} refs/heads/main`]), {
      DB: env.DB,
      ARTIFACTS: artifacts,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "default_branch" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still forwards deletion of other branches", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await gitWorker.fetch(receivePack([`${oid("a")} ${ZERO} refs/heads/topic`]), {
      DB: env.DB,
      ARTIFACTS: artifacts,
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Agent session workspace access", () => {
  const sessionId = "session-one";
  const forkName = "mutations-fork";
  beforeAll(async () => {
    const source = await artifacts.get(artifactName);
    await source.fork(forkName);
    source[Symbol.dispose]();
    await env.DB.prepare(
      "INSERT INTO auth_agents(id,user_id,name,created_at) VALUES('agent-one','owner-id','Agent',1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES(?,?,?,?,'hash','tok',?,'https://artifacts.example.test/fork.git','main',NULL,'write','active',1,?)"
    )
      .bind(sessionId, "agent-one", "owner-id", repositoryId, forkName, Date.now() + 3_600_000)
      .run();
  });

  it("denies another writer mutations in a session fork", async () => {
    const forkBefore = artifacts.snapshot(forkName).tokens.length;
    const response = await gitCall(
      `branches?sessionId=${sessionId}`,
      "POST",
      { name: "topic", source: "main", expectedOid: oid("a") },
      "writer"
    );
    expect(response.status).toBe(404);
    expect(artifacts.snapshot(forkName).tokens.length).toBe(forkBefore);
  });

  describe("published pull request heads", () => {
    const reader: GitRepositoryAccess = {
      user: null,
      repository: {
        id: "",
        namespaceId: "ns",
        artifactName: "x",
        remote: null,
        defaultBranch: "main",
        visibility: "public",
        owner: "owner",
        slug: "mutations",
        canWrite: 0,
        archived: 0,
        agentsEnabled: 1,
        graphEnabled: 1,
        onlineEditingEnabled: 1,
      },
    };
    async function pull(state: "open" | "closed" | "merged", number: number) {
      await env.DB.prepare(
        "INSERT INTO forge_pull_requests(id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,state,merge_head_oid,created_at,updated_at) VALUES(?,?,?,?,'{}','t','','main','agent-branch',?,?,?,1,1)"
      )
        .bind(
          `pr-${state}`,
          repositoryId,
          number,
          "owner-id",
          sessionId,
          state,
          state === "merged" ? oid("c") : null
        )
        .run();
    }
    it("grants readers the head of open and merged pull requests only", async () => {
      reader.repository.id = repositoryId;
      expect(await resolveWorkspace(env, reader, sessionId, "agent-branch")).toBeNull();
      await pull("closed", 1);
      expect(await resolveWorkspace(env, reader, sessionId, "agent-branch")).toBeNull();
      await pull("open", 2);
      expect(await resolveWorkspace(env, reader, sessionId, "agent-branch")).toMatchObject({
        id: sessionId,
      });
      await env.DB.prepare(
        "UPDATE forge_pull_requests SET state='closed' WHERE id='pr-open'"
      ).run();
      expect(await resolveWorkspace(env, reader, sessionId, "agent-branch")).toBeNull();
      await pull("merged", 3);
      expect(await resolveWorkspace(env, reader, sessionId, oid("c"))).toMatchObject({
        id: sessionId,
      });
      expect(await resolveWorkspace(env, reader, sessionId, "agent-branch")).toBeNull();
    });
  });
});

describe("Write token revocation", () => {
  it("keeps the original failure when token revocation also fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream unavailable");
      })
    );
    artifacts.repositories.get(artifactName)?.branchCommits.set("fresh", []);
    const inner = await artifacts.get(artifactName);
    const repo: ArtifactsRepo = new Proxy(inner, {
      get(target, property) {
        if (property === "revokeToken")
          return async () => {
            throw new Error("revoke failed");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      createRepositoryBranch(
        repo,
        "fresh",
        "main",
        (await inner.log({ limit: 1 }))[0].hash,
        async () => {}
      )
    ).rejects.not.toThrow("revoke failed");
  });
});
