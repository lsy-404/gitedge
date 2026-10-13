import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { resolveWorkspace, type GitRepositoryAccess } from "../../workers/git/src/access";
import { createRepositoryBranch } from "../../workers/git/src/write";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { PushEventRefHeadsSchema } from "../../packages/contracts/src/webhooks";
import { runSqlScript } from "../support/database";
import { grantCollaborator } from "../support/membership";
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
async function commitCall(
  manifest: unknown,
  files: Record<string, Uint8Array> = {},
  user: keyof typeof users = "owner",
  search = ""
) {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) form.set(name, new File([content], name));
  return gitWorker.fetch(
    new Request(`https://forge.test/repositories/${repositoryId}/commit${search}`, {
      method: "POST",
      headers: trustedHeaders(users[user]),
      body: form,
    }),
    { DB: env.DB, ARTIFACTS: artifacts }
  );
}
const upload = {
  branch: "main",
  expectedOid: null as string | null,
  message: "Upload files",
  changes: [{ op: "put", path: "assets/logo.bin", part: "f0" }],
};
const bytes = { f0: new Uint8Array([0, 1, 2, 3]) };
function receivePack(
  commands: string[],
  capabilities = "report-status",
  sessionId?: string
): Request {
  const headers = trustedHeaders(users.owner);
  headers.set("X-GitEdge-Git-Grant", JSON.stringify({ repositoryId, permission: "write" }));
  const encoder = new TextEncoder();
  const lines = commands.map((command, index) => {
    const text = index === 0 ? `${command}\0${capabilities}\n` : `${command}\n`;
    return (encoder.encode(text).length + 4).toString(16).padStart(4, "0") + text;
  });
  const url = new URL("https://forge.test/owner/mutations.git/git-receive-pack");
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  return new Request(url, {
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
  await grantCollaborator(env.DB, repositoryId, users.writer.id, "write");
  const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id=?")
    .bind(repositoryId)
    .first<{ name: string }>();
  artifactName = z.string().parse(row?.name);
});
afterEach(() => vi.unstubAllGlobals());

describe("Git mutation guards", () => {
  it("reads actual refs for Forge push verification", async () => {
    const response = await gitWorker.fetch(
      new Request("https://git.internal/internal/ref-heads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId,
          pusherId: users.owner.id,
          updates: [{ ref: "refs/heads/main", after: oid("b") }],
        }),
      }),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    const result = z.object({ data: PushEventRefHeadsSchema }).parse(await response.json());
    expect(response.status).toBe(200);
    expect(result.data.heads).toEqual([{ ref: "refs/heads/main", oid: oid("a") }]);
  });

  it("uses the annotated tag object OID instead of its peeled commit OID", async () => {
    const tagOid = oid("c");
    const commitOid = oid("a");
    const pktLine = (line: string) => {
      const payload = new TextEncoder().encode(line);
      const length = (payload.byteLength + 4).toString(16).padStart(4, "0");
      return length + line;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            pktLine(`${tagOid} refs/tags/release peeled:${commitOid}\n`) + "0000",
            { headers: { "Content-Type": "application/x-git-upload-pack-result" } }
          );
        }
        return new Response(
          pktLine("version 2\n") +
            pktLine("ls-refs=unborn\n") +
            pktLine("fetch=shallow\n") +
            "0000",
          { headers: { "Content-Type": "application/x-git-upload-pack-advertisement" } }
        );
      })
    );

    const response = await gitWorker.fetch(
      new Request("https://git.internal/internal/ref-heads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId,
          pusherId: users.owner.id,
          updates: [{ ref: "refs/tags/release", after: tagOid }],
        }),
      }),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    const result = z.object({ data: PushEventRefHeadsSchema }).parse(await response.json());
    expect(response.status).toBe(200);
    expect(result.data.heads).toEqual([{ ref: "refs/tags/release", oid: tagOid }]);
    expect(tagOid).not.toBe(commitOid);
  });

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
    expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
    expect(tokenCount()).toBe(before);
  });

  it("rejects a multi-file commit whose parent is stale without minting a write token", async () => {
    const before = tokenCount();
    const response = await commitCall({ ...upload, expectedOid: oid("f") }, bytes);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
    expect(tokenCount()).toBe(before);
  });

  it("refuses a multi-file commit onto an existing new branch name", async () => {
    const response = await commitCall({ ...upload, newBranch: "main" }, bytes);
    expect(response.status).toBe(409);
  });

  it("validates commit paths, parts and sizes before any storage access", async () => {
    const before = tokenCount();
    for (const path of ["../escape.txt", ".git/hooks/pre-commit", "/abs.txt", "a//b.txt"]) {
      const response = await commitCall(
        { ...upload, changes: [{ op: "put", path, part: "f0" }] },
        bytes
      );
      expect(response.status, path).toBe(400);
    }
    expect((await commitCall(upload)).status).toBe(400);
    const oversized = await commitCall(upload, { f0: new Uint8Array(5 * 1024 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: "file_too_large" } });
    expect(tokenCount()).toBe(before);
  });

  it("rejects JSON bodies on the commit endpoint and admits write collaborators", async () => {
    const json = await gitCall("commit", "POST", upload);
    expect(json.status).toBe(415);
    expect((await commitCall(upload, bytes, "writer")).status).not.toBe(403);
  });

  it("blocks commits that target protected branches or branch names", async () => {
    const rule = await forgeCall(`/repositories/${repositoryId}/branch-rules`, "POST", {
      pattern: "release/*",
      requireSignedCommits: true,
    });
    expect(rule.status).toBe(201);
    const before = tokenCount();
    const response = await commitCall({ ...upload, newBranch: "release/1" }, bytes);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "protected_branch" } });
    expect(tokenCount()).toBe(before);
  });

  it("honors the online editing switch for multi-file commits", async () => {
    const toggle = (enabled: boolean) =>
      forgeCall(`/repositories/${repositoryId}/settings`, "PATCH", {
        onlineEditingEnabled: enabled,
      });
    expect((await toggle(false)).status).toBe(200);
    const response = await commitCall(upload, bytes);
    expect((await toggle(true)).status).toBe(200);
    expect(response.status).toBe(404);
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

  it("reports reserved refs before a default-branch denial and rejects the whole push", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream must not be called"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await gitWorker.fetch(
      receivePack([
        `${oid("a")} ${ZERO} refs/heads/main`,
        `${ZERO} ${oid("b")} refs/gitedge/sessions/one`,
      ]),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    expect(response.status).toBe(200);
    const report = new TextDecoder().decode(await response.arrayBuffer());
    expect(report).toContain(`ng refs/heads/main push rejected: another ref was denied\n`);
    expect(report).toContain(`ng refs/gitedge/sessions/one reserved namespace\n`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks updates and deletion for matching protected tags", async () => {
    const rule = await forgeCall(`/repositories/${repositoryId}/branch-rules`, "POST", {
      target: "tag",
      pattern: "release/*",
      forbidTagUpdate: true,
      forbidTagDeletion: true,
    });
    expect(rule.status).toBe(201);
    const ruleId = z.object({ data: z.object({ id: z.string() }) }).parse(await rule.json())
      .data.id;
    try {
      const fetchMock = vi.fn(async () => new Response("upstream must not be called"));
      vi.stubGlobal("fetch", fetchMock);
      for (const command of [
        `${oid("a")} ${oid("b")} refs/tags/release/v1`,
        `${oid("a")} ${ZERO} refs/tags/release/v1`,
      ]) {
        const response = await gitWorker.fetch(receivePack([command]), {
          DB: env.DB,
          ARTIFACTS: artifacts,
        });
        expect(response.status).toBe(200);
        expect(new TextDecoder().decode(await response.arrayBuffer())).toContain(
          `ng refs/tags/release/v1`
        );
      }
      expect(fetchMock).not.toHaveBeenCalled();

      const tokenCountBeforeDelete = tokenCount();
      const deleted = await gitCall("tags", "DELETE", {
        name: "release/v1",
        expectedOid: oid("a"),
      });
      expect(deleted.status).toBe(403);
      expect(await deleted.json()).toMatchObject({ error: { code: "protected_tag" } });
      expect(tokenCount()).toBe(tokenCountBeforeDelete);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await forgeCall(`/repositories/${repositoryId}/branch-rules/${ruleId}`, "DELETE");
    }
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
    await env.DB.prepare("UPDATE repositories SET agents_enabled=1 WHERE id=?")
      .bind(repositoryId)
      .run();
    await env.DB.prepare(
      "INSERT INTO auth_git_tokens(id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES('tok','owner-id',?,'Session token','token-hash','write',?,1)"
    )
      .bind(repositoryId, Date.now() + 3_600_000)
      .run();
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

  it("lets the session owner past the ownership guard", async () => {
    const response = await gitCall(
      `branches?sessionId=${sessionId}`,
      "POST",
      { name: "topic", source: "main", expectedOid: oid("a") },
      "owner"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "refs_changed" } });
  });

  it("reads the session workspace only while its owner and session remain active", async () => {
    const makeRequest = () =>
      gitWorker.fetch(
        new Request("https://git.internal/internal/ref-heads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repositoryId,
            pusherId: "owner-id",
            agentSessionId: sessionId,
            updates: [{ ref: "refs/heads/main", after: oid("b") }],
          }),
        }),
        { DB: env.DB, ARTIFACTS: artifacts }
      );
    const response = await makeRequest();
    expect(response.status).toBe(200);
    expect(
      z.object({ data: PushEventRefHeadsSchema }).parse(await response.json()).data.heads
    ).toEqual([{ ref: "refs/heads/main", oid: oid("a") }]);
    await env.DB.prepare("UPDATE auth_agent_sessions SET status='revoked' WHERE id=?")
      .bind(sessionId)
      .run();
    expect((await makeRequest()).status).toBe(403);
    await env.DB.prepare("UPDATE auth_agent_sessions SET status='active' WHERE id=?")
      .bind(sessionId)
      .run();
  });

  it("commits multi-file changes into the session workspace, not the repository", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("clone unavailable");
      })
    );
    const fork = artifacts.repositories.get(forkName);
    const [head] = fork?.commits ?? [];
    fork?.branchCommits.set("agent-work", [{ ...head, hash: oid("9") }]);
    const forkBefore = artifacts.snapshot(forkName).tokens.length;
    const repositoryBefore = tokenCount();
    const response = await commitCall(
      { ...upload, branch: "agent-work", expectedOid: oid("9") },
      bytes,
      "owner",
      `?sessionId=${sessionId}`
    );
    expect(response.status).not.toBe(409);
    expect(artifacts.snapshot(forkName).tokens.length).toBe(forkBefore + 1);
    expect(tokenCount()).toBe(repositoryBefore);
  });

  it("rejects reserved refs in an agent session workspace", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream must not be called"));
    vi.stubGlobal("fetch", fetchMock);
    const response = await gitWorker.fetch(
      receivePack(
        [`${ZERO} ${oid("b")} refs/gitedge/agent/session-one`],
        "report-status",
        sessionId
      ),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain(
      "ng refs/gitedge/agent/session-one reserved namespace"
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
    ).rejects.toThrow("upstream unavailable");
  });
});
