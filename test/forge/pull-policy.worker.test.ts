import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AutoMergeStatusSchema,
  MERGE_REVIEW_LIMIT,
  MergeRequirementsSchema,
  PullRequestSchema,
  type Actor,
  type AgentSessionIdentity,
} from "../../packages/contracts/src/index";
import forge from "../../workers/forge/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const BASE = "b".repeat(40);
const heads = new Map<string, string>();
const gitReads: string[] = [];
let merges = 0;
let sequence = 0;
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  MERGE_QUEUE: env.MERGE_QUEUE,
  GIT: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/internal/ref-heads") {
        const report = z
          .object({ updates: z.array(z.object({ ref: z.string() })) })
          .parse(await request.json());
        return Response.json({
          data: {
            heads: report.updates.map(({ ref }) => ({
              ref,
              oid: heads.get(ref.replace(/^refs\/heads\//, "")) ?? null,
            })),
          },
        });
      }

      if (request.method === "GET" && url.pathname.endsWith("/pull-head")) {
        gitReads.push(request.url);
        const oid = heads.get(url.searchParams.get("head") ?? "");
        return oid
          ? Response.json({ data: { oid } })
          : Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (request.method === "GET")
        return Response.json({
          data: { baseOid: BASE, headOid: BASE, commits: [], files: [], truncated: false },
        });
      merges++;
      return Response.json({ data: { oid: "c".repeat(40) } });
    },
  },
};

function actor(id: string): Actor {
  return { kind: "user", id, name: `member-${id}` };
}
async function call(
  path: string,
  method = "GET",
  who: string | null = "u1",
  body?: unknown,
  agentSession?: AgentSessionIdentity
) {
  if (path === "/internal/push-event" && body && typeof body === "object")
    body = { eventId: crypto.randomUUID(), occurredAt: Date.now(), ...body };
  return forge.fetch(
    new Request(
      `https://${path.startsWith("/internal/") ? "forge.internal" : "forge.test"}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(agentSession ? { "X-GitEdge-Agent-Session": JSON.stringify(agentSession) } : {}),
          ...(who
            ? {
                "X-GitEdge-User-Id": who,
                "X-GitEdge-User-Name": `member-${who}`,
                "X-GitEdge-User-Group": "free",
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }
    ),
    forgeEnv
  );
}
async function data<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  expect(response.status).toBeLessThan(300);
  return z.object({ data: schema }).parse(await response.json()).data;
}
interface PullFixture {
  id: string;
  number: number;
  head: string;
  base: string;
  oid: string;
}
async function pull(
  options: { author?: string; actor?: Actor; session?: string; draft?: boolean } = {}
): Promise<PullFixture> {
  const number = ++sequence;
  const value = {
    id: `policy-${number}`,
    number,
    head: `topic-${number}`,
    base: `base-${number}`,
    oid: number.toString(16).padStart(40, "a"),
  };
  heads.set(value.head, value.oid);
  heads.set(value.base, BASE);
  await env.DB.prepare(
    "INSERT INTO forge_pull_requests (id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,draft,state,created_at,updated_at) VALUES (?,'r1',?,?,?,'Proposal','',?,?,?,?,'open',1,1)"
  )
    .bind(
      value.id,
      number,
      options.author ?? "u1",
      JSON.stringify(options.actor ?? actor(options.author ?? "u1")),
      value.base,
      value.head,
      options.session ?? null,
      Number(options.draft ?? false)
    )
    .run();
  return value;
}
async function rule(value: PullFixture, fields: Record<string, unknown>) {
  const response = await call("/repositories/r1/branch-rules", "POST", "u1", {
    pattern: value.base,
    ...fields,
  });
  expect(response.status).toBe(201);
}
async function pusher(value: PullFixture, id: string, session = "", oid = value.oid) {
  await env.DB.prepare(
    "INSERT INTO forge_ref_pushers (repository_id,session_id,ref,oid,pusher_id,actor_json,updated_at,pusher_verified) VALUES ('r1',?,?,?,?,?,1,1) ON CONFLICT(repository_id,session_id,ref) DO UPDATE SET oid=excluded.oid,pusher_id=excluded.pusher_id,actor_json=excluded.actor_json,updated_at=excluded.updated_at,pusher_verified=1"
  )
    .bind(session, `refs/heads/${value.head}`, oid, id, JSON.stringify(actor(id)))
    .run();
}
async function review(value: PullFixture, id: string, state = "approved") {
  const response = await call(
    `/repositories/r1/pull-requests/${value.number}/reviews`,
    "POST",
    id,
    { state, body: "Review", commitOid: heads.get(value.head) }
  );
  expect(response.status).toBe(201);
}
function requirements(value: PullFixture, suffix = "") {
  return call(`/repositories/r1/pull-requests/${value.number}/merge-requirements${suffix}`).then(
    (response) => data(response, MergeRequirementsSchema)
  );
}
async function requestReview(value: PullFixture, includeAgent = false) {
  const response = await call(
    `/repositories/r1/pull-requests/${value.number}/assignees`,
    "PUT",
    "u1",
    {
      role: "reviewer",
      assignees: [
        { kind: "user", id: "u5" },
        ...(includeAgent ? [{ kind: "agent", id: "a1" }] : []),
      ],
    }
  );
  expect(response.status).toBe(200);
}
function detail(value: PullFixture) {
  return call(`/repositories/r1/pull-requests/${value.number}`).then((response) =>
    data(response, PullRequestSchema)
  );
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  const source = await artifacts.create("policy-repo", { setDefaultBranch: "main" });
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id,identifier,password_salt,password_hash,created_at) VALUES ('u1','member-u1','x','x',1),('u2','member-u2','x','x',1),('u3','member-u3','x','x',1),('u4','member-u4','x','x',1),('u5','member-u5','x','x',1);
INSERT INTO namespaces (id,slug,created_by,created_at,kind,display_name,description) VALUES ('n1','policy','u1',1,'personal','Policy','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote,default_branch,agent_assignment_policy) VALUES ('r1','n1','u1','demo','policy:r1','public','',1,1,'${source.name}','${source.remote}','main','members');
INSERT INTO repository_collaborators (repository_id,user_id,role,created_at) VALUES ('r1','u2','write',1),('r1','u3','write',1),('r1','u4','write',1),('r1','u5','write',1);
INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u2','builder','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','test','hash','write',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','hash','gt1','workspace','artifact://workspace','main',NULL,'write','active',1,9999999999999);`
  );
});

describe("Published pull request policy", () => {
  it("lists simultaneous blockers while preserving direct merge's first blocker", async () => {
    const value = await pull();
    await rule(value, {
      requiredApprovals: 1,
      requirePassingChecks: true,
      requiredStatusChecks: ["CI"],
      requireLinearHistory: true,
      requireSignedCommits: true,
      requireMergeQueue: false,
    });
    await review(value, "u2", "changes_requested");
    expect(
      (
        await call(`/repositories/r1/pull-requests/${value.number}/checks`, "POST", "u3", {
          name: "CI",
          commitOid: value.oid,
          status: "completed",
          conclusion: "failure",
        })
      ).status
    ).toBe(201);
    const result = await requirements(value);
    expect(result.ready).toBe(false);
    expect(
      result.requirements.filter((entry) => entry.status === "unsatisfied").map((entry) => entry.id)
    ).toEqual([
      "no_changes_requested",
      "approvals",
      "checks_complete",
      "passing_check",
      "required_checks",
    ]);
    for (const id of ["linear_history", "signed_commits", "no_conflicts", "current_head"])
      expect(result.requirements.find((entry) => entry.id === id)?.status).toBe("checked_at_merge");
    const count = merges;
    const merged = await call(
      `/repositories/r1/pull-requests/${value.number}/merge`,
      "POST",
      "u1",
      { method: "squash", expectedBaseOid: BASE, expectedHeadOid: value.oid }
    );
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ error: { code: "changes_requested" } });
    expect(merges).toBe(count);
    await env.DB.prepare(
      "UPDATE repository_branch_rules SET require_merge_queue=1 WHERE repository_id='r1' AND pattern=?"
    )
      .bind(value.base)
      .run();
    expect(
      (await requirements(value)).requirements.find((entry) => entry.id === "merge_queue")?.status
    ).toBe("checked_at_merge");
    const auto = await data(
      await call(`/repositories/r1/pull-requests/${value.number}/auto-merge`, "PUT", "u1", {
        method: "squash",
        expectedHeadOid: value.oid,
      }),
      AutoMergeStatusSchema
    );
    expect(auto.waitingOn).toMatchObject({
      code: "changes_requested",
      unmet: [
        "no_changes_requested",
        "approvals",
        "checks_complete",
        "passing_check",
        "required_checks",
      ],
    });
  });

  it("excludes the session owner, linked requester and last pusher only at the exact current head", async () => {
    const value = await pull({
      author: "u2",
      actor: { kind: "agent", id: "a1", name: "builder", sessionId: "s1" },
      session: "s1",
    });
    await rule(value, { requiredApprovals: 1, requireIndependentApproval: true });
    await pusher(value, "u4", "s1");
    await env.DB.prepare(
      "INSERT INTO forge_tasks (id,repository_id,number,type,title,motivation,description,status,created_by,actor_json,created_at,updated_at) VALUES (?,'r1',?,'Feature','Task','','','pending','u3',?,1,1)"
    )
      .bind(`task-${value.id}`, value.number, JSON.stringify(actor("u3")))
      .run();
    await env.DB.prepare(
      "INSERT INTO forge_task_links (id,repository_id,task_id,target_kind,target_id,actor_json,created_at) VALUES (?,'r1',?,'pull_request',?,?,1)"
    )
      .bind(`link-${value.id}`, `task-${value.id}`, value.id, JSON.stringify(actor("u3")))
      .run();
    for (const id of ["u2", "u3", "u4"]) await review(value, id);
    await env.DB.prepare(
      "INSERT INTO forge_reviews (id,repository_id,pull_request_id,actor_json,author_id,actor_key,state,body,commit_oid,created_at) VALUES (?,'r1',?,?,'u5','user:u5:','approved','',?,2)"
    )
      .bind(`old-${value.id}`, value.id, JSON.stringify(actor("u5")), "d".repeat(40))
      .run();
    const blocked = await requirements(value);
    expect(blocked.requirements.find((entry) => entry.id === "approvals")).toMatchObject({
      status: "unsatisfied",
      actualCount: 0,
      requiredCount: 1,
    });
    expect(blocked.excludedApprovals).toEqual(
      expect.arrayContaining([
        { name: "member-u2", reason: "agent_owner" },
        { name: "member-u3", reason: "task_requester" },
        { name: "member-u4", reason: "last_pusher" },
      ])
    );
    await review(value, "u5");
    expect(
      (await requirements(value)).requirements.find((entry) => entry.id === "approvals")
    ).toMatchObject({ status: "satisfied", actualCount: 1 });
  });

  it("keeps the author excluded and the optional independence rule's old behavior", async () => {
    const value = await pull();
    await rule(value, { requiredApprovals: 3 });
    for (const id of ["u1", "u2", "u3", "u4"]) await review(value, id);
    const result = await requirements(value);
    expect(result.requirements.find((entry) => entry.id === "approvals")).toMatchObject({
      status: "satisfied",
      actualCount: 3,
    });
    expect(result.excludedApprovals).toEqual([{ name: "member-u1", reason: "author" }]);
    await env.DB.prepare(
      "UPDATE repository_branch_rules SET require_independent_approval=1 WHERE repository_id='r1' AND pattern=?"
    )
      .bind(value.base)
      .run();
    expect(
      (await requirements(value)).requirements.find((entry) => entry.id === "approvals")
    ).toMatchObject({ status: "unsatisfied", blockerCode: "independent_approval_unverified" });
  });

  it("resolves only the published head and applies anonymous and private read permissions", async () => {
    const value = await pull({ author: "u2", session: "s1" });
    gitReads.length = 0;
    const result = await data(
      await call(`/repositories/r1/pull-requests/${value.number}/merge-requirements`, "GET", null),
      MergeRequirementsSchema
    );
    expect(result.headOid).toBe(value.oid);
    expect(new URL(gitReads[0]).searchParams.get("headSessionId")).toBe("s1");
    expect(new URL(gitReads[0]).searchParams.get("head")).toBe(value.head);
    const readCount = gitReads.length;
    await requirements(value, `?headOid=${value.oid}&method=squash`);
    expect(gitReads).toHaveLength(readCount);
    expect(
      (await call(`/repositories/r1/pull-requests/${value.number}/merge-requirements?headOid=no`))
        .status
    ).toBe(400);
    await env.DB.prepare("UPDATE repositories SET visibility='private' WHERE id='r1'").run();
    expect(
      (
        await call(
          `/repositories/r1/pull-requests/${value.number}/merge-requirements?headOid=${value.oid}`,
          "GET",
          null
        )
      ).status
    ).toBe(404);
    await env.DB.prepare("UPDATE repositories SET visibility='public' WHERE id='r1'").run();
  });
  it("reports unsupported review history without pretending unchecked conditions passed", async () => {
    const value = await pull();
    await pusher(value, "u1");
    await rule(value, { requiredApprovals: 1 });
    await env.DB.prepare(
      "INSERT INTO forge_reviews (id,repository_id,pull_request_id,actor_json,author_id,actor_key,state,body,commit_oid,created_at) SELECT ?||value,'r1',?,?,'u5','user:u5:','approved','',?,value FROM json_each(?)"
    )
      .bind(
        `history-${value.id}-`,
        value.id,
        JSON.stringify(actor("u5")),
        value.oid,
        JSON.stringify(Array.from({ length: MERGE_REVIEW_LIMIT + 1 }, (_, index) => index))
      )
      .run();
    const result = await requirements(value);
    expect(result.ready).toBe(false);
    expect(result.requirements.find((entry) => entry.id === "approvals")).toMatchObject({
      status: "unsatisfied",
      blockerCode: "review_limit",
    });
    expect(result.requirements.find((entry) => entry.id === "signed_commits")?.status).toBe(
      "unavailable"
    );
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u1", name: "member-u1", reason: "history_unavailable" },
    ]);
  });
});

describe("Review attention", () => {
  it("updates only pull requests whose published head changed", async () => {
    const value = await pull();
    const unrelated = await pull();
    await pusher(value, "u1");
    const next = "f".repeat(40);
    heads.set(value.head, next);
    const occurredAt = Date.now();
    expect(
      (
        await call("/internal/push-event", "POST", null, {
          eventId: crypto.randomUUID(),
          occurredAt,
          repositoryId: "r1",
          pusherId: "u1",
          updates: [{ ref: `refs/heads/${value.head}`, before: value.oid, after: next }],
        })
      ).status
    ).toBe(200);
    expect((await detail(value)).updatedAt).toBe(occurredAt);
    expect((await detail(unrelated)).updatedAt).toBe(1);
  });

  it("hands requests to human and agent reviewers, then changes, replies and approvals to the right identity", async () => {
    const value = await pull();
    await pusher(value, "u1");
    await requestReview(value, true);
    expect((await detail(value)).attention).toEqual(
      expect.arrayContaining([
        { kind: "user", id: "u5", name: "member-u5", reason: "review_requested" },
        { kind: "agent", id: "a1", name: "builder", reason: "review_requested" },
      ])
    );
    const list = z
      .object({ data: z.array(PullRequestSchema), truncated: z.boolean() })
      .parse(await (await call("/repositories/r1/pull-requests?attention=me", "GET", "u5")).json());
    expect(list.data.some((entry) => entry.id === value.id)).toBe(true);
    const agentList = await call(
      "/repositories/r1/pull-requests?attention=me",
      "GET",
      "u2",
      undefined,
      {
        id: "s1",
        agentId: "a1",
        agentName: "builder",
        repositoryId: "r1",
        workspaceName: "workspace",
        permission: "write",
      }
    );
    expect(
      z
        .object({ data: z.array(PullRequestSchema) })
        .parse(await agentList.json())
        .data.some((entry) => entry.id === value.id)
    ).toBe(true);
    const anonymous = await call("/repositories/r1/pull-requests?attention=me", "GET", null);
    expect(await anonymous.json()).toMatchObject({ data: [] });
    await review(value, "u5", "changes_requested");
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u1", name: "member-u1", reason: "changes_requested" },
    ]);
    expect(
      (
        await call(`/repositories/r1/pull-requests/${value.number}/comments`, "POST", "u1", {
          body: "Addressed the review.",
        })
      ).status
    ).toBe(201);
    expect((await detail(value)).attention.map((entry) => entry.reason)).toEqual([
      "reply",
      "reply",
    ]);
    await requestReview(value);
    await review(value, "u5");
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u1", name: "member-u1", reason: "reviewed" },
    ]);
  });

  it("does not call a historic approval complete when the published head is unrecorded", async () => {
    const value = await pull();
    await requestReview(value);
    await review(value, "u5");
    heads.set(value.head, "e".repeat(40));
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u1", name: "member-u1", reason: "head_unverified" },
    ]);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO forge_counters (repository_id) VALUES ('r1')"
    ).run();
    await env.DB.prepare("UPDATE forge_counters SET conversation_number=? WHERE repository_id='r1'")
      .bind(sequence)
      .run();
    const created = await data(
      await call("/repositories/r1/pull-requests", "POST", "u1", {
        title: "New proposal",
        body: "",
        baseRef: "main",
        headRef: "untracked",
      }),
      PullRequestSchema
    );
    sequence = created.number;
    const reread = await data(
      await call(`/repositories/r1/pull-requests/${created.number}`),
      PullRequestSchema
    );
    expect(created.attention).toEqual(reread.attention);
    expect(created.attention[0]?.reason).toBe("head_unverified");
  });

  it("returns a changed head to reviewers without using old approvals or unpublished comments", async () => {
    const value = await pull();
    await pusher(value, "u1");
    await requestReview(value);
    await review(value, "u5");
    const next = "e".repeat(40);
    heads.set(value.head, next);
    const pushed = await call("/internal/push-event", "POST", null, {
      repositoryId: "r1",
      pusherId: "u1",
      updates: [{ ref: `refs/heads/${value.head}`, before: value.oid, after: next }],
    });
    expect(pushed.status).toBe(200);
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u5", name: "member-u5", reason: "head_updated" },
    ]);
    await env.DB.prepare(
      "INSERT INTO forge_review_comments (id,repository_id,pull_request_id,actor_json,actor_key,author_id,commit_oid,path,side,line,body,pending,created_at,updated_at) VALUES (?,'r1',?,?,'user:u5:','u5',?,'a.ts','RIGHT',1,'Private draft',1,?,?)"
    )
      .bind(
        `pending-${value.id}`,
        value.id,
        JSON.stringify(actor("u5")),
        next,
        Date.now() + 1000,
        Date.now() + 1000
      )
      .run();
    expect((await detail(value)).attention[0]).toMatchObject({ id: "u5", reason: "head_updated" });
    const stale = await call(
      `/repositories/r1/pull-requests/${value.number}/reviews`,
      "POST",
      "u5",
      { state: "approved", commitOid: value.oid }
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "stale_commit" } });
    expect(
      (await call(`/repositories/r1/pull-requests/${value.number}`, "PATCH", "u1", { draft: true }))
        .status
    ).toBe(200);
    expect((await detail(value)).attention).toEqual([]);
    await env.DB.prepare("UPDATE forge_pull_requests SET draft=0,state='closed' WHERE id=?")
      .bind(value.id)
      .run();
    expect((await detail(value)).attention).toEqual([]);
  });
  it("hands a deleted published head back to its author rather than reporting old approval as ready", async () => {
    const value = await pull();
    await pusher(value, "u1");
    await requestReview(value);
    await review(value, "u5");
    heads.delete(value.head);
    expect(
      (
        await call("/internal/push-event", "POST", null, {
          repositoryId: "r1",
          pusherId: "u1",
          updates: [{ ref: `refs/heads/${value.head}`, before: value.oid, after: "0".repeat(40) }],
        })
      ).status
    ).toBe(200);
    expect((await detail(value)).attention).toEqual([
      { kind: "user", id: "u1", name: "member-u1", reason: "head_missing" },
    ]);
  });
});
