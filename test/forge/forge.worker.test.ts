import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import git from "../../workers/git/src/index";
import { resolveGitAccess, resolveWorkspace } from "../../workers/git/src/access";
import forge from "../../workers/forge/src/index";
import { FixtureArtifacts } from "../support/artifacts";

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
  const paths = Object.keys(migrations).sort();
  for (const path of paths) {
    if ((path.split("/").at(-1) ?? "") >= "0005_") continue;
    await runSqlScript(migrations[path]);
  }
  await runSqlScript(`INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1), ('u3','eve','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES ('r1','n1','u1','demo','repo:r1','public','',1,1);
INSERT INTO forge_issues (id,repository_id,number,author_id,title,body,state,created_at,updated_at) VALUES ('legacy-issue','r1',6,'u1','Legacy issue','', 'open',1,1);
INSERT INTO forge_pull_requests (id,repository_id,number,author_id,title,body,base_ref,head_ref,state,created_at,updated_at) VALUES ('legacy-pr','r1',8,'u1','Legacy PR','', 'main','topic','open',1,1);`);
  for (const path of paths) {
    if ((path.split("/").at(-1) ?? "") < "0005_") continue;
    await runSqlScript(migrations[path]);
  }
}

const artifacts = new FixtureArtifacts();
const gitCalls: Array<Record<string, unknown>> = [];
const gitRequests: Array<{ method: string; url: string }> = [];
let mergeGate: Promise<void> | null = null;
let onMergeStarted: (() => void) | null = null;
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    async fetch(request: Request) {
      gitRequests.push({ method: request.method, url: request.url });
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
  await runSqlScript(`INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u2','reviewer','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','test','git-hash','read',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','session-hash','gt1','review','artifact://repo-r1','main',NULL,'read','active',1,9999999999999);`);
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
    expect(await wikiIndex.json()).toMatchObject({
      data: [{ slug: "home", content: expect.any(String) }],
    });
    const history = await call("/repositories/r1/wiki/home/history", "GET", "u2", "bob");
    const historyPages = ((await history.json()) as { data: Array<{ content: string }> }).data;
    expect(historyPages).toHaveLength(2);
    expect(historyPages.every((page) => typeof page.content === "string")).toBe(true);
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
    if (!access) throw new Error("Missing public fixture");
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
