import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";

const migrations = import.meta.glob("../../migrations/000*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

async function runSqlScript(sql: string): Promise<void> {
  let statement = "";
  let inTrigger = false;
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (!statement && (!trimmed || trimmed.startsWith("--") || /^PRAGMA\b/i.test(trimmed)))
      continue;
    if (/^CREATE TRIGGER\b/i.test(trimmed)) inTrigger = true;
    statement += `${line}\n`;
    if (inTrigger && /^END;?$/i.test(trimmed)) {
      await env.DB.prepare(statement).run();
      statement = "";
      inTrigger = false;
    } else if (!inTrigger && trimmed.endsWith(";")) {
      await env.DB.prepare(statement).run();
      statement = "";
    }
  }
  if (statement.trim()) await env.DB.prepare(statement).run();
}

async function applyForgeMigrations(): Promise<void> {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(migrations[path]);
}

const gitCalls: Array<Record<string, unknown>> = [];
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: {
    async create(name: string) {
      return { name, token: "initial" };
    },
    async get(name: string) {
      return {
        remote: `artifact://${name}`,
        async revokeToken() {
          return true;
        },
      };
    },
  },
  GIT: {
    async fetch(request: Request) {
      const body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      gitCalls.push(body);
      return Response.json({ data: { oid: "c".repeat(40) } });
    },
  },
};

function auth(userId: string, name: string, session?: unknown): Headers {
  const headers = new Headers({
    "X-GitEdge-User-Id": userId,
    "X-GitEdge-User-Name": name,
    "X-GitEdge-User-Group": "free",
    "Content-Type": "application/json",
  });
  if (session) headers.set("X-GitEdge-Agent-Session", JSON.stringify(session));
  return headers;
}

async function call(
  path: string,
  method: string,
  userId: string,
  name: string,
  body?: unknown,
  session?: unknown
): Promise<Response> {
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: auth(userId, name, session),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

beforeAll(async () => {
  await applyForgeMigrations();
  await runSqlScript(
    "CREATE TABLE auth_agents (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, disabled_at INTEGER); CREATE TABLE auth_agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, user_id TEXT NOT NULL, repository_id TEXT NOT NULL, workspace_name TEXT NOT NULL, remote TEXT NOT NULL, base_ref TEXT NOT NULL, base_oid TEXT, permission TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL); INSERT INTO auth_agents (id,user_id,name) VALUES ('a1','u2','reviewer'); INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','review','artifact://repo-r1','main',NULL,'read','active',1,9999999999999); INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1); INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice',''); INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner'); INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,artifact_name,remote,default_branch,visibility,description,created_at,updated_at) VALUES ('r1','n1','u1','demo','repo:r1','repo-r1','artifact://repo-r1','main','public','',1,1); INSERT INTO forge_counters (repository_id) VALUES ('r1');"
  );
});

describe("Forge collaboration", () => {
  it("allocates unique issue numbers under concurrent public creation", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call("/repositories/r1/issues", "POST", "u2", "bob", { title: `Issue ${i}` })
      )
    );
    expect(results.every((result) => result.status === 201)).toBe(true);
    const numbers = await Promise.all(
      results.map(
        async (result) => ((await result.json()) as { data: { number: number } }).data.number
      )
    );
    expect(new Set(numbers).size).toBe(12);
  });

  it("uses atomic wiki revision compare-and-swap", async () => {
    const created = await call("/repositories/r1/wiki/home", "PUT", "u1", "alice", {
      title: "Home",
      content: "one",
      expectedRevision: 0,
    });
    expect(created.status).toBe(201);
    const edits = await Promise.all([
      call("/repositories/r1/wiki/home", "PUT", "u1", "alice", {
        title: "Home",
        content: "two",
        expectedRevision: 1,
      }),
      call("/repositories/r1/wiki/home", "PUT", "u1", "alice", {
        title: "Home",
        content: "three",
        expectedRevision: 1,
      }),
    ]);
    expect(edits.map((result) => result.status).sort()).toEqual([200, 409]);
    const history = await call("/repositories/r1/wiki/home/history", "GET", "u2", "bob");
    expect(((await history.json()) as { data: unknown[] }).data).toHaveLength(2);
    const restored = await call("/repositories/r1/wiki/home/restore/1", "POST", "u1", "alice", {
      expectedRevision: 2,
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ data: { content: "one", revision: 3 } });
  });

  it("allows public issue creation but restricts metadata edits and read-only agent writes", async () => {
    const issue = await call("/repositories/r1/issues", "POST", "u2", "bob", {
      title: "Public contribution",
    });
    expect(issue.status).toBe(201);
    const number = ((await issue.json()) as { data: { number: number } }).data.number;
    expect(
      (await call(`/repositories/r1/issues/${number}`, "PATCH", "u2", "bob", { state: "closed" }))
        .status
    ).toBe(403);
    const session = {
      id: "s1",
      agentId: "a1",
      agentName: "reviewer",
      repositoryId: "r1",
      workspaceName: "review",
      permission: "read",
    };
    expect(
      (
        await call(
          "/repositories/r1/issues",
          "POST",
          "u2",
          "bob",
          { title: "Agent write" },
          session
        )
      ).status
    ).toBe(401);
  });

  it("supports public discussions, comments, answers, and member moderation", async () => {
    const created = await call("/repositories/r1/discussions", "POST", "u2", "bob", {
      title: "Question",
      body: "How does this work?",
      category: "q-and-a",
    });
    expect(created.status).toBe(201);
    const discussion = ((await created.json()) as { data: { number: number } }).data;
    const commentResponse = await call(
      `/repositories/r1/discussions/${discussion.number}/comments`,
      "POST",
      "u2",
      "bob",
      { body: "Here is an answer." }
    );
    expect(commentResponse.status).toBe(201);
    const comment = (
      (await commentResponse.json()) as { data: { id: string; actor: { kind: string } } }
    ).data;
    expect(comment.actor.kind).toBe("user");
    const edit = await call(
      `/repositories/r1/discussions/${discussion.number}/comments/${comment.id}`,
      "PATCH",
      "u2",
      "bob",
      { body: "Edited answer." }
    );
    expect(edit.status).toBe(200);
    const marked = await call(
      `/repositories/r1/discussions/${discussion.number}`,
      "PATCH",
      "u1",
      "alice",
      { answerCommentId: comment.id, state: "closed" }
    );
    expect(marked.status).toBe(200);
    expect(await marked.json()).toMatchObject({
      data: { state: "closed", answerCommentId: comment.id },
    });
    expect(
      (
        await call(`/repositories/r1/discussions/${discussion.number}`, "PATCH", "u2", "bob", {
          state: "open",
        })
      ).status
    ).toBe(403);
  });

  it("validates agent sessions against their database owner, repository, and permission", async () => {
    await env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u2',2,'member')"
    ).run();
    const session = {
      id: "s1",
      agentId: "a1",
      agentName: "reviewer",
      repositoryId: "r1",
      workspaceName: "review",
      permission: "read",
    };
    const created = await call(
      "/repositories/r1/pull-requests",
      "POST",
      "u2",
      "bob",
      { title: "Agent PR", baseRef: "main", headRef: "agents/review", headSessionId: "s1" },
      { ...session, permission: "write" }
    );
    expect(created.status).toBe(401);
    await env.DB.prepare(
      "UPDATE auth_agent_sessions SET permission = 'write' WHERE id = 's1'"
    ).run();
    const valid = await call(
      "/repositories/r1/pull-requests",
      "POST",
      "u2",
      "bob",
      { title: "Agent PR", baseRef: "main", headRef: "agents/review", headSessionId: "s1" },
      { ...session, permission: "write" }
    );
    expect(valid.status).toBe(201);
    const record = (await valid.json()) as {
      data: { actor: { kind: string; id: string; sessionId: string } };
    };
    expect(record.data.actor).toMatchObject({ kind: "agent", id: "a1", sessionId: "s1" });
  });

  it("blocks merge for changes requested and forwards the reviewed SHA pair", async () => {
    const created = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Review me",
      baseRef: "main",
      headRef: "topic",
    });
    const pr = ((await created.json()) as { data: { number: number } }).data;
    const head = "a".repeat(40),
      base = "b".repeat(40);
    await call(`/repositories/r1/pull-requests/${pr.number}/checks`, "PUT", "u1", "alice", {
      name: "CI",
      commitOid: head,
      status: "completed",
      conclusion: "success",
    });
    await call(`/repositories/r1/pull-requests/${pr.number}/reviews`, "POST", "u1", "alice", {
      state: "changes_requested",
      body: "Fix it",
      commitOid: head,
    });
    gitCalls.length = 0;
    const blocked = await call(
      `/repositories/r1/pull-requests/${pr.number}/merge`,
      "POST",
      "u1",
      "alice",
      { expectedBaseOid: base, expectedHeadOid: head }
    );
    expect(blocked.status).toBe(409);
    expect(gitCalls).toHaveLength(0);

    const ready = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Ready",
      baseRef: "main",
      headRef: "topic",
    });
    const readyPr = ((await ready.json()) as { data: { number: number } }).data;
    await call(`/repositories/r1/pull-requests/${readyPr.number}/checks`, "PUT", "u1", "alice", {
      name: "CI",
      commitOid: head,
      status: "completed",
      conclusion: "success",
    });
    await call(`/repositories/r1/pull-requests/${readyPr.number}/reviews`, "POST", "u1", "alice", {
      state: "approved",
      body: "Looks good",
      commitOid: head,
    });
    const merged = await call(
      `/repositories/r1/pull-requests/${readyPr.number}/merge`,
      "POST",
      "u1",
      "alice",
      { expectedBaseOid: base, expectedHeadOid: head }
    );
    expect(merged.status).toBe(200);
    expect(gitCalls.at(-1)).toMatchObject({
      expectedBaseOid: base,
      expectedHeadOid: head,
      baseRef: "main",
      headRef: "topic",
    });
  });
});
