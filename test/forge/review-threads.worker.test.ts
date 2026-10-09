import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const artifacts = new FixtureArtifacts();
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "e".repeat(40);
let head = HEAD_A;
let commitMessages: string[] = [];
const mergeBodies: Array<Record<string, unknown>> = [];
const compareRanges: Array<{ base: string | null; head: string | null }> = [];

const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "GET" && path.endsWith("/pull-head"))
        return Response.json({ data: { oid: head } });
      if (request.method === "GET" && path.endsWith("/compare")) {
        compareRanges.push({
          base: url.searchParams.get("base"),
          head: url.searchParams.get("head"),
        });
        return Response.json({
          data: { headOid: head, commits: commitMessages.map((message) => ({ message })) },
        });
      }
      mergeBodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ data: { oid: "c".repeat(40) } });
    },
  },
};

function headers(userId: string, name: string, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "X-GitEdge-User-Id": userId,
    "X-GitEdge-User-Name": name,
    "X-GitEdge-User-Group": "free",
    "Content-Type": "application/json",
    ...extra,
  });
}

async function call(
  path: string,
  method: string,
  who: [string, string] | null,
  body?: unknown,
  extra: Record<string, string> = {}
): Promise<Response> {
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: who ? headers(who[0], who[1], extra) : undefined,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

const alice: [string, string] = ["u1", "alice"];
const bob: [string, string] = ["u2", "bob"];
const eve: [string, string] = ["u3", "eve"];

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

interface Thread {
  id: string;
  outdated: boolean;
  pending: boolean;
  resolvedAt: number | null;
  inReplyTo: string | null;
  reviewId: string | null;
  body: string;
}

async function openPull(
  fields: { title?: string; body?: string; baseRef?: string } = {}
): Promise<number> {
  const response = await call("/repositories/r1/pull-requests", "POST", alice, {
    title: fields.title ?? "Change",
    body: fields.body ?? "",
    baseRef: fields.baseRef ?? "main",
    headRef: "topic",
  });
  expect(response.status).toBe(201);
  return (await data<{ number: number }>(response)).number;
}

function threadInput(overrides: Record<string, unknown> = {}) {
  return {
    body: "Consider renaming",
    commitOid: head,
    path: "src/app.ts",
    side: "RIGHT",
    line: 12,
    ...overrides,
  };
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  const source = await artifacts.create("repo-r1", { setDefaultBranch: "main" });
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1), ('u3','eve','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote,default_branch) VALUES ('r1','n1','u1','demo','repo:r1','public','',1,1,'${source.name}','${source.remote}','main'), ('r2','n1','u1','secret','repo:r2','private','',1,1,'${source.name}','${source.remote}','main');
INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES ('r1','u2','write',1);
INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u2','reviewer','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','test','git-hash','read',9999999999999,1), ('gt2','u2','r1','test2','git-hash2','write',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','session-hash','gt1','review','artifact://repo-r1','main',NULL,'read','active',1,9999999999999), ('s2','a1','u2','r1','session-hash2','gt2','review2','artifact://repo-r1','main',NULL,'write','active',1,9999999999999);`
  );
});

describe("Review comment threads", () => {
  it("runs a thread from comment through reply, edit, resolve and delete", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;

    const created = await call(base, "POST", bob, threadInput());
    expect(created.status).toBe(201);
    const root = await data<Thread>(created);
    expect(root).toMatchObject({ pending: false, outdated: false, inReplyTo: null });

    const reply = await call(base, "POST", alice, { body: "Done", inReplyTo: root.id });
    expect(reply.status).toBe(201);
    const replyData = await data<Thread>(reply);
    expect(replyData.inReplyTo).toBe(root.id);

    const nested = await call(base, "POST", bob, { body: "Thanks", inReplyTo: replyData.id });
    expect((await data<Thread>(nested)).inReplyTo).toBe(root.id);

    const listed = await data<Thread[]>(await call(base, "GET", alice));
    expect(listed.map((row) => row.body)).toEqual(["Consider renaming", "Done", "Thanks"]);

    expect((await call(`${base}/${root.id}`, "PATCH", alice, { body: "Hijack" })).status).toBe(403);
    const edited = await call(`${base}/${root.id}`, "PATCH", bob, { body: "Consider renaming it" });
    expect((await data<Thread>(edited)).body).toBe("Consider renaming it");

    expect((await call(`${base}/${root.id}/resolve`, "POST", eve)).status).toBe(403);
    const resolved = await call(`${base}/${replyData.id}/resolve`, "POST", bob);
    expect(resolved.status).toBe(200);
    const resolvedData = await data<Thread & { resolvedBy: { name: string } }>(resolved);
    expect(resolvedData.id).toBe(root.id);
    expect(resolvedData.resolvedAt).not.toBeNull();
    expect(resolvedData.resolvedBy.name).toBe("bob");

    const reopened = await call(`${base}/${root.id}/unresolve`, "POST", alice);
    expect((await data<Thread>(reopened)).resolvedAt).toBeNull();

    expect((await call(`${base}/${replyData.id}`, "DELETE", eve)).status).toBe(403);
    expect((await call(`${base}/${replyData.id}`, "DELETE", alice)).status).toBe(204);
    expect((await call(`${base}/${root.id}`, "DELETE", bob)).status).toBe(204);
    const remaining = await data<Thread[]>(await call(base, "GET", alice));
    expect(remaining).toHaveLength(0);
  });

  it("keeps replies by others when a non-member deletes the thread root", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;
    const root = await data<Thread>(await call(base, "POST", eve, threadInput()));
    const own = await data<Thread>(await call(base, "POST", eve, threadInput({ line: 20 })));
    await call(base, "POST", eve, { body: "Self reply", inReplyTo: own.id });
    await call(base, "POST", bob, { body: "Member reply", inReplyTo: root.id });

    const refused = await call(`${base}/${root.id}`, "DELETE", eve);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "thread_has_replies" } });
    expect((await call(`${base}/${own.id}`, "DELETE", eve)).status).toBe(204);
    expect((await call(`${base}/${root.id}`, "DELETE", bob)).status).toBe(204);
    expect(await data<Thread[]>(await call(base, "GET", alice))).toHaveLength(0);
  });

  it("validates thread positions and the reviewed commit", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;
    expect((await call(base, "POST", bob, threadInput({ line: 0 }))).status).toBe(400);
    expect((await call(base, "POST", bob, threadInput({ side: "MIDDLE" }))).status).toBe(400);
    expect((await call(base, "POST", bob, threadInput({ startLine: 20 }))).status).toBe(400);
    expect((await call(base, "POST", bob, threadInput({ commitOid: HEAD_B }))).status).toBe(409);
    const range = await call(base, "POST", bob, threadInput({ startLine: 10, line: 12 }));
    expect(range.status).toBe(201);
    expect(await range.json()).toMatchObject({ data: { startLine: 10, line: 12 } });
  });

  it("marks comments on an earlier commit as outdated once the head moves", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;
    const old = await data<Thread>(await call(base, "POST", bob, threadInput()));
    head = HEAD_B;
    try {
      const listed = await data<Thread[]>(await call(base, "GET", alice));
      expect(listed.find((row) => row.id === old.id)?.outdated).toBe(true);
      const fresh = await data<Thread>(
        await call(base, "POST", bob, threadInput({ commitOid: HEAD_B }))
      );
      expect(fresh.outdated).toBe(false);
      const reply = await data<Thread>(
        await call(base, "POST", alice, { body: "Still relevant?", inReplyTo: old.id })
      );
      expect(reply.outdated).toBe(true);
    } finally {
      head = HEAD_A;
    }
  });

  it("keeps pending comments private until the review is submitted", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;
    const pending = await data<Thread>(
      await call(base, "POST", bob, threadInput({ pending: true }))
    );
    expect(pending.pending).toBe(true);
    expect(await data<Thread[]>(await call(base, "GET", alice))).toHaveLength(0);
    expect(await data<Thread[]>(await call(base, "GET", null))).toHaveLength(0);
    expect(await data<Thread[]>(await call(base, "GET", bob))).toHaveLength(1);
    expect((await call(base, "POST", alice, { body: "Peek", inReplyTo: pending.id })).status).toBe(
      404
    );
    expect((await call(`${base}/${pending.id}/resolve`, "POST", bob)).status).toBe(409);

    const review = await call(`/repositories/r1/pull-requests/${number}/reviews`, "POST", bob, {
      state: "changes_requested",
      body: "See inline",
      commitOid: head,
    });
    expect(review.status).toBe(201);
    const reviewId = (await data<{ id: string }>(review)).id;
    const published = await data<Thread[]>(await call(base, "GET", alice));
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ pending: false, reviewId });
  });

  it("applies repository privacy, token scopes and agent session limits", async () => {
    const number = await openPull();
    const base = `/repositories/r1/pull-requests/${number}/review-comments`;
    const created = await data<Thread>(await call(base, "POST", bob, threadInput()));

    const anonymous = await call(
      `/repositories/r1/pull-requests/${number}/review-comments`,
      "GET",
      null
    );
    expect(anonymous.status).toBe(200);
    expect((await call(base, "POST", null, threadInput())).status).toBe(401);

    const issuesOnly = {
      "X-GitEdge-Access-Token": JSON.stringify({ id: "t1", scopes: ["issues:write"] }),
    };
    const pullsScope = {
      "X-GitEdge-Access-Token": JSON.stringify({ id: "t2", scopes: ["pulls:write"] }),
    };
    const denied = await call(base, "POST", bob, threadInput(), issuesOnly);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect((await call(base, "POST", bob, threadInput(), pullsScope)).status).toBe(201);
    expect(
      (await call(base, "POST", bob, { body: "x", inReplyTo: created.id }, issuesOnly)).status
    ).toBe(403);

    const readOnlyAgent = {
      "X-GitEdge-Agent-Session": JSON.stringify({
        id: "s1",
        agentId: "a1",
        agentName: "reviewer",
        repositoryId: "r1",
        workspaceName: "review",
        permission: "read",
      }),
    };
    expect((await call(base, "POST", bob, threadInput(), readOnlyAgent)).status).toBe(403);

    const writeAgent = {
      "X-GitEdge-Agent-Session": JSON.stringify({
        id: "s2",
        agentId: "a1",
        agentName: "reviewer",
        repositoryId: "r1",
        workspaceName: "review2",
        permission: "write",
      }),
    };
    const agentThread = await call(base, "POST", bob, threadInput(), writeAgent);
    expect(agentThread.status).toBe(201);
    expect(await agentThread.json()).toMatchObject({
      data: { actor: { kind: "agent", id: "a1", name: "reviewer" } },
    });
    expect(
      (await call(`${base}/${created.id}/resolve`, "POST", bob, undefined, writeAgent)).status
    ).toBe(403);

    await env.DB.prepare(
      "INSERT INTO forge_pull_requests (id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,state,created_at,updated_at) VALUES ('p-secret','r2',1,'u1','{}','Hidden','','main','topic','open',1,1)"
    ).run();
    const secret = "/repositories/r2/pull-requests/1/review-comments";
    expect((await call(secret, "GET", eve)).status).toBe(404);
    expect((await call(secret, "POST", eve, threadInput())).status).toBe(404);
    expect((await call(secret, "GET", null)).status).toBe(404);
    expect((await call(secret, "GET", alice)).status).toBe(200);
  });
});

describe("Issue linking on merge", () => {
  async function issue(title: string): Promise<number> {
    const response = await call("/repositories/r1/issues", "POST", eve, { title });
    return (await data<{ number: number }>(response)).number;
  }
  async function state(number: number): Promise<string> {
    const row = await env.DB.prepare(
      "SELECT state FROM forge_issues WHERE repository_id = 'r1' AND number = ?"
    )
      .bind(number)
      .first<{ state: string }>();
    return row?.state ?? "missing";
  }
  const merge = (number: number) =>
    call(`/repositories/r1/pull-requests/${number}/merge`, "POST", alice, {
      expectedBaseOid: BASE,
      expectedHeadOid: head,
    });

  it("closes issues named by closing keywords in the title, body and commits", async () => {
    const fromBody = await issue("From body");
    const fromTitle = await issue("From title");
    const fromCommit = await issue("From commit");
    const mentioned = await issue("Only mentioned");
    const foreign = await issue("Foreign reference");
    const pull = await openPull({
      title: `Fixes alice/demo#${fromTitle}`,
      body: `closes #${fromBody}\nSee #${mentioned}. Resolves other/repo#${foreign}`,
    });
    commitMessages = [`Update\n\nresolved #${fromCommit}`];
    compareRanges.length = 0;
    try {
      const merged = await merge(pull);
      expect(merged.status).toBe(200);
    } finally {
      commitMessages = [];
    }
    expect(compareRanges).toEqual([{ base: BASE, head }]);
    expect(await state(fromBody)).toBe("closed");
    expect(await state(fromTitle)).toBe("closed");
    expect(await state(fromCommit)).toBe("closed");
    expect(await state(mentioned)).toBe("open");
    expect(await state(foreign)).toBe("open");

    const references = await data<{
      pullRequests: Array<{ number: number; closes: boolean }>;
      events: Array<{ kind: string; pullRequestNumber: number; actor: { name: string } }>;
    }>(await call(`/repositories/r1/issues/${fromBody}/references`, "GET", null));
    expect(references.pullRequests).toEqual([
      expect.objectContaining({ number: pull, closes: true, state: "merged" }),
    ]);
    expect(references.events).toEqual([
      expect.objectContaining({
        kind: "closed_by_pull_request",
        pullRequestNumber: pull,
        actor: expect.objectContaining({ name: "alice" }),
      }),
    ]);
    const linked = await data<{ pullRequests: Array<{ closes: boolean }> }>(
      await call(`/repositories/r1/issues/${mentioned}/references`, "GET", null)
    );
    expect(linked.pullRequests).toEqual([expect.objectContaining({ closes: false })]);
  });

  it("keeps links in step with pull request edits and ignores non-default targets", async () => {
    const target = await issue("Edited");
    const pull = await openPull({ title: "Plain", baseRef: "release" });
    const references = async () =>
      data<{ pullRequests: unknown[] }>(
        await call(`/repositories/r1/issues/${target}/references`, "GET", null)
      );
    expect((await references()).pullRequests).toHaveLength(0);
    await call(`/repositories/r1/pull-requests/${pull}`, "PATCH", alice, {
      body: `Fixes #${target}`,
    });
    expect((await references()).pullRequests).toHaveLength(1);
    compareRanges.length = 0;
    expect((await merge(pull)).status).toBe(200);
    expect(compareRanges).toHaveLength(0);
    expect(await state(target)).toBe("open");
  });
});

describe("Conversation resolution rule", () => {
  it("blocks merging while a thread is unresolved when the branch rule is enabled", async () => {
    await env.DB.prepare(
      "INSERT INTO repository_branch_rules (id,repository_id,pattern,enabled,locked,required_approvals,require_passing_checks,required_status_checks,require_linear_history,require_signed_commits,require_conversation_resolution,created_at,updated_at) VALUES ('rule1','r1','main',1,0,0,0,'[]',0,0,1,1,1)"
    ).run();
    try {
      const number = await openPull();
      const base = `/repositories/r1/pull-requests/${number}/review-comments`;
      const thread = await data<Thread>(await call(base, "POST", bob, threadInput()));
      const attempt = () =>
        call(`/repositories/r1/pull-requests/${number}/merge`, "POST", alice, {
          expectedBaseOid: BASE,
          expectedHeadOid: head,
        });
      const blocked = await attempt();
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: { code: "threads_unresolved" } });

      await call(`${base}/${thread.id}/resolve`, "POST", alice);
      expect((await attempt()).status).toBe(200);
    } finally {
      await env.DB.prepare("DELETE FROM repository_branch_rules WHERE id = 'rule1'").run();
    }
  });

  it("does not block merging without the rule", async () => {
    const number = await openPull();
    await call(
      `/repositories/r1/pull-requests/${number}/review-comments`,
      "POST",
      bob,
      threadInput()
    );
    const merged = await call(`/repositories/r1/pull-requests/${number}/merge`, "POST", alice, {
      expectedBaseOid: BASE,
      expectedHeadOid: head,
    });
    expect(merged.status).toBe(200);
  });
});

describe("Review comment mentions", () => {
  async function mentionedIn(who: [string, string]): Promise<number[]> {
    const page = await data<{
      items: Array<{ reason: string; subjectKind: string; subjectNumber: number }>;
    }>(await call("/notifications?reason=mentioned&limit=50", "GET", who));
    return page.items
      .filter((item) => item.subjectKind === "pull_request")
      .map((item) => item.subjectNumber);
  }

  it("notifies users mentioned in published, edited and review-published comments", async () => {
    const published = await openPull();
    const base = `/repositories/r1/pull-requests/${published}/review-comments`;
    const comment = await data<Thread>(
      await call(base, "POST", bob, threadInput({ body: "cc @eve" }))
    );
    expect(await mentionedIn(eve)).toContain(published);
    expect(await mentionedIn(bob)).not.toContain(published);

    await call(`${base}/${comment.id}`, "PATCH", bob, { body: "cc @eve and @alice" });
    expect(await mentionedIn(alice)).toContain(published);

    const pendingPull = await openPull();
    const pendingBase = `/repositories/r1/pull-requests/${pendingPull}/review-comments`;
    await call(pendingBase, "POST", bob, threadInput({ body: "later @eve", pending: true }));
    expect(await mentionedIn(eve)).not.toContain(pendingPull);
    const review = await call(
      `/repositories/r1/pull-requests/${pendingPull}/reviews`,
      "POST",
      bob,
      {
        state: "commented",
        body: "Inline notes",
        commitOid: head,
      }
    );
    expect(review.status).toBe(201);
    expect(await mentionedIn(eve)).toContain(pendingPull);
  });
});
