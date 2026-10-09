import { runSqlScript } from "../support/database";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import git from "../../workers/git/src/index";
import { resolveGitAccess, resolveWorkspace } from "../../workers/git/src/access";
import forge from "../../workers/forge/src/index";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

async function applyForgeMigrations(): Promise<void> {
  const paths = Object.keys(migrations).sort();
  for (const path of paths) {
    if ((path.split("/").at(-1) ?? "") >= "0005_") continue;
    await runSqlScript(env.DB, migrations[path]);
  }
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1), ('u3','eve','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES ('r1','n1','u1','demo','repo:r1','public','',1,1);
INSERT INTO forge_issues (id,repository_id,number,author_id,title,body,state,created_at,updated_at) VALUES ('legacy-issue','r1',6,'u1','Legacy issue','', 'open',1,1);
INSERT INTO forge_pull_requests (id,repository_id,number,author_id,title,body,base_ref,head_ref,state,created_at,updated_at) VALUES ('legacy-pr','r1',8,'u1','Legacy PR','', 'main','topic','open',1,1);`
  );
  for (const path of paths) {
    if ((path.split("/").at(-1) ?? "") < "0005_") continue;
    await runSqlScript(env.DB, migrations[path]);
  }
}

const artifacts = new FixtureArtifacts();
const gitCalls: Array<Record<string, unknown>> = [];
const gitRequests: Array<{ method: string; url: string }> = [];
let compareHead: string | null = "d".repeat(40);
let compareFails = false;
let mergeGate: Promise<void> | null = null;
let onMergeStarted: (() => void) | null = null;
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    async fetch(request: Request) {
      gitRequests.push({ method: request.method, url: request.url });
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/pull-head"))
        return compareHead
          ? Response.json({ data: { oid: compareHead } })
          : Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/compare"))
        return compareFails
          ? Response.json({ error: { code: "resource_limit" } }, { status: 413 })
          : Response.json({ data: { headOid: compareHead } });
      const body =
        request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : {};
      gitCalls.push(body);
      if (request.method === "POST" && mergeGate) {
        onMergeStarted?.();
        await mergeGate;
      }
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
  const sourceArtifact = await artifacts.create("repo-r1", { setDefaultBranch: "main" });
  using source = await artifacts.get(sourceArtifact.name);
  await source.revokeToken(sourceArtifact.token);
  await applyForgeMigrations();
  const counter = await env.DB.prepare(
    "SELECT conversation_number FROM forge_counters WHERE repository_id = 'r1'"
  ).first<{ conversation_number: number }>();
  expect(counter?.conversation_number).toBe(8);
  await env.DB.prepare(
    "UPDATE repositories SET artifact_name = ?, remote = ?, default_branch = 'main' WHERE id = 'r1'"
  )
    .bind(sourceArtifact.name, sourceArtifact.remote)
    .run();
  expect(artifacts.snapshot(sourceArtifact.name).tokens[0]?.state).toBe("revoked");
  await runSqlScript(
    env.DB,
    `INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u2','reviewer','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','test','git-hash','read',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','session-hash','gt1','review','artifact://repo-r1','main',NULL,'read','active',1,9999999999999);`
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
    const pullRequest = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Shared number",
      baseRef: "main",
      headRef: "topic",
    });
    expect(((await pullRequest.json()) as { data: { number: number } }).data.number).toBe(21);
    const nextIssue = await call("/repositories/r1/issues", "POST", "u2", "bob", {
      title: "Next shared number",
    });
    expect(((await nextIssue.json()) as { data: { number: number } }).data.number).toBe(22);
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
    const wikiIndex = await call("/repositories/r1/wiki", "GET", "u2", "bob");
    const indexBody = (await wikiIndex.json()) as {
      data: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(indexBody).toMatchObject({ data: [{ slug: "home", revision: 2 }], truncated: false });
    expect(indexBody.data[0]).not.toHaveProperty("content");
    const history = await call("/repositories/r1/wiki/home/history", "GET", "u2", "bob");
    const historyPages = ((await history.json()) as { data: Array<Record<string, unknown>> }).data;
    expect(historyPages).toHaveLength(2);
    expect(historyPages.every((page) => !("content" in page))).toBe(true);
    const revision = await call("/repositories/r1/wiki/home/revisions/1", "GET", "u2", "bob");
    expect(await revision.json()).toMatchObject({ data: { content: "one" } });
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
      (
        await call(`/repositories/r1/issues/${number}`, "PATCH", "u2", "bob", {
          title: "Edited by author",
          state: "closed",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call(`/repositories/r1/issues/${number}`, "PATCH", "u2", "bob", {
          labels: ["triaged"],
        })
      ).status
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
    const comments = await call(
      `/repositories/r1/discussions/${discussion.number}/comments`,
      "GET",
      "u2",
      "bob"
    );
    expect(await comments.json()).toMatchObject({
      data: [
        { actor: { kind: "user" }, createdAt: expect.any(Number), updatedAt: expect.any(Number) },
      ],
    });
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
      data: { number: number; actor: { kind: string; id: string; sessionId: string } };
    };
    expect(record.data.actor).toMatchObject({ kind: "agent", id: "a1", sessionId: "s1" });
    const patch = await call(
      `/repositories/r1/pull-requests/${record.data.number}`,
      "PATCH",
      "u2",
      "bob",
      { title: "Agent PR edited" }
    );
    expect(patch.status).toBe(200);
    gitRequests.length = 0;
    const diff = await call(
      `/repositories/r1/pull-requests/${record.data.number}/diff`,
      "GET",
      "u2",
      "bob",
      undefined,
      { ...session, permission: "write" }
    );
    expect(diff.status).toBe(200);
    const gitDiffRequest = gitRequests.at(-1);
    expect(gitDiffRequest?.method).toBe("GET");
    const diffUrl = new URL(gitDiffRequest?.url ?? "https://example.invalid");
    expect(diffUrl.pathname).toBe("/repositories/r1/compare");
    expect(diffUrl.searchParams.get("headSessionId")).toBe("s1");
    const detail = await call(
      `/repositories/r1/pull-requests/${record.data.number}`,
      "GET",
      "u2",
      "bob",
      undefined,
      { ...session, permission: "write" }
    );
    expect(await detail.json()).toMatchObject({
      data: { author: "bob", actor: { name: "reviewer" } },
    });
  });

  it("preserves the verified agent reviewer identity without inventing a human approval", async () => {
    const session = {
      id: "s1",
      agentId: "a1",
      agentName: "reviewer",
      repositoryId: "r1",
      workspaceName: "review",
      permission: "write",
    };
    const created = await call(
      "/repositories/r1/pull-requests",
      "POST",
      "u2",
      "bob",
      { title: "Agent authored", baseRef: "main", headRef: "agents/review", headSessionId: "s1" },
      session
    );
    const body = await created.json();
    const head = "d".repeat(40);
    compareHead = head;
    const review = await call(
      `/repositories/r1/pull-requests/${body.data.number}/reviews`,
      "POST",
      "u2",
      "bob",
      { state: "approved", commitOid: head, actor: { kind: "user", name: "forged" } },
      session
    );
    expect(review.status).toBe(201);
    const reviewed = await review.json();
    expect(reviewed.data.actor).toEqual({
      kind: "agent",
      id: "a1",
      name: "reviewer",
      sessionId: "s1",
    });
    const merged = await call(
      `/repositories/r1/pull-requests/${body.data.number}/merge`,
      "POST",
      "u2",
      "bob",
      { expectedBaseOid: "e".repeat(40), expectedHeadOid: head }
    );
    expect(merged.status).toBe(200);
  });

  it("leases a merge so concurrent PR edits cannot race Git", async () => {
    const created = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Lease",
      baseRef: "main",
      headRef: "lease",
    });
    const pr = ((await created.json()) as { data: { number: number } }).data;
    const head = "f".repeat(40),
      base = "1".repeat(40);
    compareHead = head;
    await call(`/repositories/r1/pull-requests/${pr.number}/checks`, "POST", "u1", "alice", {
      name: "CI",
      commitOid: head,
      status: "completed",
      conclusion: "success",
    });
    await call(`/repositories/r1/pull-requests/${pr.number}/reviews`, "POST", "u2", "bob", {
      state: "approved",
      commitOid: head,
    });
    let signalStarted: () => void = () => {};
    let releaseMerge: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    mergeGate = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    onMergeStarted = signalStarted;
    try {
      const merge = call(
        `/repositories/r1/pull-requests/${pr.number}/merge`,
        "POST",
        "u1",
        "alice",
        { expectedBaseOid: base, expectedHeadOid: head }
      );
      await started;
      const patch = await call(
        `/repositories/r1/pull-requests/${pr.number}`,
        "PATCH",
        "u1",
        "alice",
        { title: "Raced edit" }
      );
      expect(patch.status).toBe(409);
      const lateCheck = await call(
        `/repositories/r1/pull-requests/${pr.number}/checks`,
        "POST",
        "u1",
        "alice",
        { name: "CI", commitOid: head, status: "completed", conclusion: "failure" }
      );
      expect(lateCheck.status).toBe(409);
      const lateReview = await call(
        `/repositories/r1/pull-requests/${pr.number}/reviews`,
        "POST",
        "u2",
        "bob",
        { state: "changes_requested", commitOid: head }
      );
      expect(lateReview.status).toBe(409);
      const concurrentMerge = await call(
        `/repositories/r1/pull-requests/${pr.number}/merge`,
        "POST",
        "u1",
        "alice",
        { expectedBaseOid: base, expectedHeadOid: head }
      );
      expect(concurrentMerge.status).toBe(409);
      releaseMerge();
      expect((await merge).status).toBe(200);
    } finally {
      releaseMerge();
      mergeGate = null;
      onMergeStarted = null;
    }
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
    compareHead = head;
    await call(`/repositories/r1/pull-requests/${pr.number}/checks`, "POST", "u1", "alice", {
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
    const queued = await call(
      `/repositories/r1/pull-requests/${readyPr.number}/checks`,
      "POST",
      "u1",
      "alice",
      { name: "CI", commitOid: head, status: "queued" }
    );
    const queuedData = ((await queued.json()) as { data: { id: string } }).data;
    const running = await call(
      `/repositories/r1/pull-requests/${readyPr.number}/checks`,
      "POST",
      "u1",
      "alice",
      { name: "CI", commitOid: head, status: "in_progress" }
    );
    expect(running.status).toBe(200);
    expect(((await running.json()) as { data: { id: string } }).data.id).toBe(queuedData.id);
    const completed = await call(
      `/repositories/r1/pull-requests/${readyPr.number}/checks`,
      "POST",
      "u1",
      "alice",
      { name: "CI", commitOid: head, status: "completed", conclusion: "success" }
    );
    expect(completed.status).toBe(200);
    const checkCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM forge_check_runs WHERE pull_request_id = (SELECT id FROM forge_pull_requests WHERE repository_id = 'r1' AND number = ?)"
    )
      .bind(readyPr.number)
      .first<{ count: number }>();
    expect(checkCount?.count).toBe(1);
    await call(`/repositories/r1/pull-requests/${readyPr.number}/reviews`, "POST", "u3", "eve", {
      state: "changes_requested",
      body: "External advisory feedback",
      commitOid: head,
    });
    await call(`/repositories/r1/pull-requests/${readyPr.number}/reviews`, "POST", "u2", "bob", {
      state: "changes_requested",
      body: "Needs one edit",
      commitOid: head,
    });
    await call(`/repositories/r1/pull-requests/${readyPr.number}/reviews`, "POST", "u2", "bob", {
      state: "approved",
      body: "Fixed and approved",
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
    expect(await merged.json()).toMatchObject({
      data: { state: "merged", author: "alice", mergedOid: "c".repeat(40) },
    });
    expect(gitCalls.at(-1)).toMatchObject({
      expectedBaseOid: base,
      expectedHeadOid: head,
      baseRef: "main",
      headRef: "topic",
    });
    const audit = await env.DB.prepare(
      "SELECT actor_name AS actor, metadata_json AS metadata FROM audit_events WHERE action = 'pull_request.merged' AND repository_id = 'r1'"
    ).first<{ actor: string; metadata: string }>();
    expect(audit?.actor).toBe("alice");
    expect(JSON.parse(audit?.metadata ?? "{}")).toMatchObject({
      oid: "c".repeat(40),
      method: "merge",
    });
  });
});

describe("Repository viewer role", () => {
  it("reports the effective role without granting write to read collaborators", async () => {
    await env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES ('r1','u3','read',1)"
    ).run();
    try {
      const read = await call("/repositories/r1", "GET", "u3", "eve");
      expect(await read.json()).toMatchObject({ data: { viewerRole: "read", canWrite: false } });
      const byName = await call("/repositories/by-name/alice/demo", "GET", "u3", "eve");
      expect(await byName.json()).toMatchObject({ data: { viewerRole: "read", canWrite: false } });
      const owner = await call("/repositories/r1", "GET", "u1", "alice");
      expect(await owner.json()).toMatchObject({ data: { viewerRole: "admin", canWrite: true } });
    } finally {
      await env.DB.prepare("DELETE FROM repository_collaborators WHERE user_id = 'u3'").run();
    }
  });
});

describe("Public repository boundaries", () => {
  const read = (path: string) => forge.fetch(new Request(`https://forge.test${path}`), forgeEnv);

  it("serves canonical anonymous pages, reviews and wiki history without write access", async () => {
    for (const path of [
      "/repositories/by-name/alice/demo",
      "/repositories/r1",
      "/repositories/r1/issues",
      "/repositories/r1/issues/6",
      "/repositories/r1/issues/6/comments",
      "/repositories/r1/pull-requests",
      "/repositories/r1/pull-requests/8",
      "/repositories/r1/pull-requests/8/reviews",
      "/repositories/r1/pull-requests/8/checks",
      "/repositories/r1/pull-requests/8/diff",
      "/repositories/r1/discussions",
      "/repositories/r1/wiki",
      "/repositories/r1/wiki/home/history",
    ])
      expect((await read(path)).status, path).toBe(200);
    expect(await (await read("/repositories/r1")).json()).toMatchObject({
      data: { canWrite: false },
    });
    expect(
      (
        await forge.fetch(
          new Request("https://forge.test/repositories/r1/issues", { method: "POST" }),
          forgeEnv
        )
      ).status
    ).toBe(401);
    await env.DB.prepare("UPDATE repositories SET visibility = 'private' WHERE id = 'r1'").run();
    try {
      for (const path of [
        "/repositories/by-name/alice/demo",
        "/repositories/r1/issues",
        "/repositories/r1/wiki",
      ])
        expect((await read(path)).status).toBe(404);
    } finally {
      await env.DB.prepare("UPDATE repositories SET visibility = 'public' WHERE id = 'r1'").run();
    }
  });

  it("grants public access only to a published fork head and cannot mint untracked tokens", async () => {
    const request = new Request("https://git.test/repositories/r1/tree");
    const access = await resolveGitAccess(request, forgeEnv, "r1");
    expect(access).not.toBeNull();
    if (!access || access instanceof Response) throw new Error("Missing public fixture");
    expect(await resolveWorkspace(forgeEnv, access, "s1")).toBeNull();
    expect(await resolveWorkspace(forgeEnv, access, "s1", "unpublished")).toBeNull();
    const pull = await env.DB.prepare(
      "SELECT head_ref FROM forge_pull_requests WHERE head_session_id = 's1' LIMIT 1"
    ).first<{ head_ref: string }>();
    expect(pull).not.toBeNull();
    if (!pull) throw new Error("Missing published fixture");
    expect(await resolveWorkspace(forgeEnv, access, "s1", pull.head_ref)).toMatchObject({
      id: "s1",
    });
    expect(
      (
        await git.fetch(
          new Request(
            "https://git.test/repositories/r1/raw?sessionId=s1&ref=unpublished&path=secret.txt"
          ),
          forgeEnv
        )
      ).status
    ).toBe(404);
    const before = artifacts.snapshot("repo-r1").tokens.length;
    const tokenRequest = new Request("https://git.test/repositories/r1/tokens", {
      method: "POST",
      headers: auth("u1", "alice"),
      body: JSON.stringify({ scope: "write" }),
    });
    expect((await git.fetch(tokenRequest, forgeEnv)).status).toBe(405);
    expect(artifacts.snapshot("repo-r1").tokens).toHaveLength(before);
  });
});

it("keeps merged pull request diffs bound to the reviewed commits", async () => {
  const merged = await env.DB.prepare(
    "SELECT number, merge_base_oid AS base, merge_head_oid AS head FROM forge_pull_requests WHERE state = 'merged' LIMIT 1"
  ).first<{ number: number; base: string; head: string }>();
  expect(merged).not.toBeNull();
  if (!merged) throw new Error("Missing merged fixture");
  expect(merged.base).toMatch(/^[a-f0-9]{40}$/);
  expect(merged.head).toMatch(/^[a-f0-9]{40}$/);
  const path = `/repositories/r1/pull-requests/${merged.number}/diff`;
  for (const request of [
    new Request(`https://forge.test${path}`),
    new Request(`https://forge.test${path}`, { headers: auth("u1", "alice") }),
  ]) {
    expect((await forge.fetch(request, forgeEnv)).status).toBe(200);
    const url = new URL(gitRequests.at(-1)?.url ?? "https://invalid.test");
    expect(url.searchParams.get("base")).toBe(merged.base);
    expect(url.searchParams.get("head")).toBe(merged.head);
  }
});

describe("Forge list bounds, answers and head pinning", () => {
  const session = {
    id: "s1",
    agentId: "a1",
    agentName: "reviewer",
    repositoryId: "r1",
    workspaceName: "review",
    permission: "write",
  };

  it("rejects reviews and checks recorded against a commit that is not the pull request head", async () => {
    const created = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Pinned head",
      baseRef: "main",
      headRef: "pinned",
    });
    const pr = ((await created.json()) as { data: { number: number } }).data;
    const head = "9".repeat(40);
    const stale = "8".repeat(40);
    compareHead = head;
    const base = `/repositories/r1/pull-requests/${pr.number}`;
    for (const [route, payload] of [
      ["reviews", { state: "approved" }],
      ["checks", { name: "CI", status: "completed", conclusion: "success" }],
    ] as const) {
      const rejected = await call(`${base}/${route}`, "POST", "u2", "bob", {
        ...payload,
        commitOid: stale,
      });
      expect(rejected.status, route).toBe(409);
      expect(await rejected.json()).toMatchObject({ error: { code: "stale_commit" } });
      const accepted = await call(`${base}/${route}`, "POST", "u2", "bob", {
        ...payload,
        commitOid: head,
      });
      expect(accepted.status, route).toBe(201);
    }
  });

  it("resolves the head without a full comparison and reports a missing head as stale", async () => {
    const created = await call("/repositories/r1/pull-requests", "POST", "u1", "alice", {
      title: "Large history",
      baseRef: "main",
      headRef: "large",
    });
    const pr = ((await created.json()) as { data: { number: number } }).data;
    const head = "7".repeat(40);
    const base = `/repositories/r1/pull-requests/${pr.number}`;
    compareHead = head;
    compareFails = true;
    try {
      const approved = await call(`${base}/reviews`, "POST", "u2", "bob", {
        state: "approved",
        commitOid: head,
      });
      expect(approved.status).toBe(201);
      compareHead = null;
      const missing = await call(`${base}/checks`, "POST", "u2", "bob", {
        name: "CI",
        status: "completed",
        conclusion: "success",
        commitOid: head,
      });
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ error: { code: "stale_commit" } });
    } finally {
      compareFails = false;
      compareHead = "d".repeat(40);
    }
  });

  it("clears the accepted answer when its comment is deleted", async () => {
    const created = await call("/repositories/r1/discussions", "POST", "u1", "alice", {
      title: "Question",
      category: "q-and-a",
    });
    const number = ((await created.json()) as { data: { number: number } }).data.number;
    const path = `/repositories/r1/discussions/${number}`;
    const comment = await call(`${path}/comments`, "POST", "u2", "bob", { body: "Try this" });
    const commentId = ((await comment.json()) as { data: { id: string } }).data.id;
    const marked = await call(path, "PATCH", "u1", "alice", { answerCommentId: commentId });
    expect(await marked.json()).toMatchObject({ data: { answerCommentId: commentId } });
    expect((await call(`${path}/comments/${commentId}`, "DELETE", "u2", "bob")).status).toBe(204);
    const detail = await call(path, "GET", "u1", "alice");
    expect(await detail.json()).toMatchObject({ data: { answerCommentId: null } });
  });

  it("bounds repository-wide lists and reports truncation", async () => {
    await runSqlScript(
      env.DB,
      `INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES ('r9','n1','u1','bulk','repo:r9','public','',1,1,'repo-r9','artifact://repo-r9');
INSERT INTO forge_counters (repository_id, conversation_number) VALUES ('r9', 0);
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
INSERT INTO forge_issues (id,repository_id,number,author_id,title,body,state,created_at,updated_at) SELECT 'bulk-' || n,'r9',n,'u1','Bulk ' || n,'','open',n,n FROM seq;`
    );
    const bulk = (await (await call("/repositories/r9/issues", "GET", "u1", "alice")).json()) as {
      data: Array<{ number: number }>;
      truncated: boolean;
    };
    expect(bulk.truncated).toBe(true);
    expect(bulk.data).toHaveLength(500);
    expect(bulk.data[0]?.number).toBe(501);
    const small = (await (await call("/repositories/r1/issues", "GET", "u1", "alice")).json()) as {
      truncated: boolean;
    };
    expect(small.truncated).toBe(false);
  });

  it("keeps the newest comments in chronological order when a thread is truncated", async () => {
    await runSqlScript(
      env.DB,
      `INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES ('r8','n1','u1','thread','repo:r8','public','',1,1,'repo-r8','artifact://repo-r8');
INSERT INTO forge_counters (repository_id, conversation_number) VALUES ('r8', 1);
INSERT INTO forge_issues (id,repository_id,number,author_id,title,body,state,created_at,updated_at) VALUES ('thread-issue','r8',1,'u1','Thread','','open',1,1);
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
INSERT INTO forge_comments (id,repository_id,target_kind,target_id,actor_json,author_id,body,created_at,updated_at) SELECT 'tc-' || n,'r8','issue','thread-issue','{"kind":"user","id":"u1","name":"alice"}','u1','Comment ' || n,n,n FROM seq;`
    );
    for (const [userId, name] of [
      ["u1", "alice"],
      ["u3", "carol"],
    ]) {
      const page = (await (
        await call("/repositories/r8/issues/1/comments", "GET", userId, name)
      ).json()) as {
        data: Array<{ body: string }>;
        truncated: boolean;
      };
      expect(page.truncated).toBe(true);
      expect(page.data).toHaveLength(500);
      expect(page.data[0]?.body).toBe("Comment 2");
      expect(page.data.at(-1)?.body).toBe("Comment 501");
    }
  });

  it("hides repository existence from agent sessions outside their repository", async () => {
    await runSqlScript(
      env.DB,
      `INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n2','team','u2',1,'personal','Team','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n2','u2',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES ('r2','n2','u2','hidden','repo:r2','private','',1,1,'repo-r2','artifact://repo-r2'), ('r3','n2','u2','open','repo:r3','public','',1,1,'repo-r3','artifact://repo-r3');`
    );
    const probe = async (owner: string, slug: string) => {
      const response = await call(
        `/repositories/by-name/${owner}/${slug}`,
        "GET",
        "u2",
        "bob",
        undefined,
        session
      );
      return { status: response.status, body: await response.text() };
    };
    const privateMember = await probe("team", "hidden");
    const publicOther = await probe("team", "open");
    const missing = await probe("team", "missing");
    expect(missing.status).toBe(404);
    expect(privateMember).toEqual(missing);
    expect(publicOther).toEqual(missing);
    expect((await probe("alice", "demo")).status).toBe(200);
  });

  it("manages organization members with owner-only mutation and a last-owner guard", async () => {
    const created = await call("/organizations", "POST", "u1", "alice", {
      slug: "acme",
      displayName: "Acme",
    });
    expect(created.status).toBe(201);
    const members = (user: string, name: string) =>
      call("/organizations/acme/members", "GET", user, name);
    const listed = (await (await members("u1", "alice")).json()) as {
      data: Array<{ identifier: string; role: string }>;
    };
    expect(listed.data).toEqual([expect.objectContaining({ identifier: "alice", role: "owner" })]);
    expect((await members("u3", "eve")).status).toBe(403);
    const add = (user: string, name: string, identifier: string) =>
      call("/organizations/acme/invitations", "POST", user, name, { identifier });
    const invited = await add("u1", "alice", "bob");
    expect(invited.status).toBe(201);
    expect((await add("u1", "alice", "bob")).status).toBe(409);
    expect((await add("u2", "bob", "eve")).status).toBe(403);
    const invitation = (await invited.json()) as { data: { id: string } };
    expect(
      (await call(`/invitations/${invitation.data.id}/accept`, "POST", "u2", "bob")).status
    ).toBe(200);
    expect((await members("u2", "bob")).status).toBe(200);
    expect((await call("/organizations/acme/members/alice", "DELETE", "u1", "alice")).status).toBe(
      409
    );
    expect((await call("/organizations/acme/members/bob", "DELETE", "u2", "bob")).status).toBe(403);
    expect((await call("/organizations/acme/members/bob", "DELETE", "u1", "alice")).status).toBe(
      204
    );
  });

  it("serves public profiles without exposing internal storage fields", async () => {
    const response = await forge.fetch(new Request("https://forge.test/profiles/alice"), forgeEnv);
    expect(response.status).toBe(200);
    const profile = (await response.json()) as {
      data: { owner: string; repositories: Array<Record<string, unknown>> };
    };
    expect(profile.data.owner).toBe("alice");
    expect(profile.data.repositories.length).toBeGreaterThan(0);
    for (const repository of profile.data.repositories) {
      expect(repository).not.toHaveProperty("artifactName");
      expect(repository).not.toHaveProperty("remote");
    }
    const missing = await forge.fetch(new Request("https://forge.test/profiles/nobody"), forgeEnv);
    expect(missing.status).toBe(404);
    const repository = await call("/repositories/by-name/alice/demo", "GET", "u1", "alice");
    const body = (await repository.json()) as { data: Record<string, unknown> };
    expect(body.data).not.toHaveProperty("artifactName");
    expect(body.data).not.toHaveProperty("remote");
  });
});

describe("Merge authorization binding and closed pull request heads", () => {
  const baseOid = "1".repeat(40);
  const headOid = "2".repeat(40);
  const leaseAt = Date.now();

  async function seedPull(id: string, number: number, state: string, sessionId: string | null) {
    await env.DB.prepare(
      "INSERT INTO forge_pull_requests (id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,state,merge_started_at,merge_base_oid,merge_head_oid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
      .bind(
        id,
        "r1",
        number,
        "u1",
        "{}",
        id,
        "",
        "main",
        `topic-${id}`,
        sessionId,
        state,
        leaseAt,
        baseOid,
        headOid,
        1,
        1
      )
      .run();
  }

  function authorize(overrides: Record<string, unknown>): Promise<Response> {
    return forge.fetch(
      new Request("https://forge.internal/internal/merge-authorization", {
        method: "POST",
        headers: auth("u1", "alice"),
        body: JSON.stringify({
          pullRequestId: "auth-pr",
          repositoryId: "r1",
          leaseAt,
          method: "merge",
          baseRef: "main",
          headRef: "topic-auth-pr",
          headSessionId: null,
          expectedBaseOid: baseOid,
          expectedHeadOid: headOid,
          author: { name: "alice", email: "alice@users.gitedge.invalid" },
          message: "Merge",
          ...overrides,
        }),
      }),
      forgeEnv
    );
  }

  it("rejects a callback whose refs, head session or repository differ from the pull request", async () => {
    await seedPull("auth-pr", 900, "open", null);
    expect((await authorize({})).status).toBe(200);
    for (const override of [
      { baseRef: "release" },
      { headRef: "other" },
      { headSessionId: "s1" },
      { repositoryId: "r2" },
    ]) {
      const response = await authorize(override);
      expect(response.status, JSON.stringify(override)).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "merge_changed" } });
    }
    expect((await authorize({ pullRequestId: undefined })).status).toBe(400);
    expect((await authorize({ repositoryId: undefined })).status).toBe(400);
    expect((await authorize({ leaseAt: undefined })).status).toBe(400);
  });

  it("answers anonymous diff reads of closed session pull requests with 404 and no Git call", async () => {
    await seedPull("closed-pr", 901, "closed", "s1");
    const before = gitRequests.length;
    const response = await forge.fetch(
      new Request("https://forge.test/repositories/r1/pull-requests/901/diff"),
      forgeEnv
    );
    expect(response.status).toBe(404);
    expect(gitRequests).toHaveLength(before);
  });

  it("marks Forge API responses as non-cacheable", async () => {
    const response = await forge.fetch(new Request("https://forge.test/repositories/r1"), forgeEnv);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("reports repository usage against the caller's group quota", async () => {
    const created = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repositories WHERE created_by = 'u1'"
    ).first<{ count: number }>();
    const response = await call("/usage", "GET", "u1", "alice");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        groupKey: "free",
        repositories: { used: created?.count, limit: 10 },
        storage: { usedBytes: null, limitBytes: 5_368_709_120 },
        rpm: 120,
      },
    });
    const anonymous = await forge.fetch(new Request("https://forge.test/usage"), forgeEnv);
    expect(anonymous.status).toBe(401);
  });

  it("rejects repository creation with structured quota details at the limit", async () => {
    const created = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repositories WHERE created_by = 'u1'"
    ).first<{ count: number }>();
    const limited: typeof forgeEnv = {
      ...forgeEnv,
      USER_GROUP_LIMITS_JSON: JSON.stringify({ free: { maxRepositories: created?.count } }),
    };
    const response = await forge.fetch(
      new Request("https://forge.test/repositories", {
        method: "POST",
        headers: auth("u1", "alice"),
        body: JSON.stringify({ owner: "alice", slug: "another", visibility: "public" }),
      }),
      limited
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: "quota_exceeded",
        quota: { resource: "repositories", used: created?.count, limit: created?.count },
      },
    });
  });

  it("answers the internal health probes without a user context", async () => {
    for (const path of ["/internal/health", "/internal/health/d1"]) {
      const response = await forge.fetch(new Request(`https://forge.test${path}`), forgeEnv);
      expect(response.status, path).toBe(200);
    }
  });
});
