import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import {
  processMergeQueue,
  reconcileRepository,
  sweepMergeAutomation,
} from "../../workers/forge/src/merge-automation";
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
const mergeBodies: Array<Record<string, unknown>> = [];
const mergeUsers: string[] = [];
const mergeFailures = new Map<string, { status: number; code: string }>();
let mergeCounter = 0;
let mergeGate: Promise<void> | null = null;
let onMergeStarted: (() => void) | null = null;

const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  MERGE_QUEUE: env.MERGE_QUEUE,
  GIT: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.endsWith("/pull-head")) {
        const oid = heads.get(url.searchParams.get("head") ?? "");
        return oid
          ? Response.json({ data: { oid } })
          : Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      if (request.method === "GET" && url.pathname.endsWith("/compare"))
        return Response.json({ data: { commits: [] } });
      if (request.method !== "POST") return Response.json({ data: {} });
      const body = (await request.json()) as Record<string, unknown>;
      mergeBodies.push(body);
      mergeUsers.push(request.headers.get("X-GitEdge-User-Id") ?? "");
      if (mergeGate) {
        onMergeStarted?.();
        await mergeGate;
      }
      const failure = mergeFailures.get(String(body.headRef));
      if (failure)
        return Response.json(
          { error: { code: failure.code, message: `Git said ${failure.code}.` } },
          { status: failure.status }
        );
      if (heads.get(String(body.baseRef)) !== body.expectedBaseOid)
        return Response.json(
          { error: { code: "refs_changed", message: "Moved." } },
          { status: 409 }
        );
      const oid = (++mergeCounter).toString(16).padStart(40, "e");
      heads.set(String(body.baseRef), oid);
      return Response.json({ data: { oid } });
    },
  },
};

function headers(userId: string, name: string): Headers {
  return new Headers({
    "X-GitEdge-User-Id": userId,
    "X-GitEdge-User-Name": name,
    "X-GitEdge-User-Group": "free",
    "Content-Type": "application/json",
  });
}

const alice: [string, string] = ["u1", "alice"];
const bob: [string, string] = ["u2", "bob"];
const eve: [string, string] = ["u3", "eve"];

function context(): { ctx: ExecutionContext; settled: () => Promise<unknown> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
    settled: () => Promise.all(pending),
  };
}

async function call(
  path: string,
  method: string,
  who: [string, string],
  body?: unknown,
  ctx?: ExecutionContext
): Promise<Response> {
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: headers(who[0], who[1]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv,
    ctx
  );
}

async function json<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

let sequence = 0;
interface Fixture {
  number: number;
  id: string;
  headRef: string;
  head: string;
}

/** Opens a pull request from a unique head branch into `base`. */
async function openPull(base: string): Promise<Fixture> {
  const head = (++sequence).toString(16).padStart(40, "a");
  const headRef = `topic-${sequence}`;
  heads.set(headRef, head);
  if (!heads.has(base)) heads.set(base, BASE);
  const response = await call("/repositories/r1/pull-requests", "POST", alice, {
    title: `Change ${headRef}`,
    body: "",
    baseRef: base,
    headRef,
  });
  expect(response.status).toBe(201);
  const created = await json<{ number: number; id: string }>(response);
  return { number: created.number, id: created.id, headRef, head };
}

function rule(
  base: string,
  fields: { checks?: string[]; queue?: boolean; approvals?: number } = {}
): Promise<unknown> {
  return env.DB.prepare(
    "INSERT INTO repository_branch_rules (id,repository_id,pattern,required_status_checks,require_passing_checks,required_approvals,require_merge_queue,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)"
  )
    .bind(
      `rule-${base}`,
      "r1",
      base,
      JSON.stringify(fields.checks ?? []),
      fields.checks?.length ? 1 : 0,
      fields.approvals ?? 0,
      fields.queue ? 1 : 0
    )
    .run();
}

function enable(pull: Fixture, who = bob, method = "squash", expectedHeadOid = pull.head) {
  return call(`/repositories/r1/pull-requests/${pull.number}/auto-merge`, "PUT", who, {
    method,
    expectedHeadOid,
  });
}

function passCheck(pull: Fixture, ctx?: ExecutionContext, oid = pull.head) {
  return call(
    `/repositories/r1/pull-requests/${pull.number}/checks`,
    "POST",
    bob,
    { name: "CI", commitOid: oid, status: "completed", conclusion: "success" },
    ctx
  );
}

async function state(pull: Fixture): Promise<string> {
  const row = await env.DB.prepare("SELECT state FROM forge_pull_requests WHERE id = ?")
    .bind(pull.id)
    .first<{ state: string }>();
  return row?.state ?? "missing";
}

function autoMergeRow(pull: Fixture) {
  return env.DB.prepare("SELECT * FROM forge_auto_merges WHERE pull_request_id = ?")
    .bind(pull.id)
    .first<{ expected_head_oid: string; enabled_by: string; method: string }>();
}

async function notifications(userId: string, reason: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM forge_notifications WHERE recipient_id = ? AND reason = ?"
  )
    .bind(userId, reason)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function deliveries(action: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM forge_webhook_deliveries WHERE event = 'pull_request' AND action = ?"
  )
    .bind(action)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function auditMetadata(action: string, pull: Fixture): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "SELECT metadata_json AS metadata FROM audit_events WHERE action = ? AND target_id = ?"
  )
    .bind(action, pull.id)
    .first<{ metadata: string }>();
  return JSON.parse(row?.metadata ?? "{}");
}

function mergedHeads(): string[] {
  return mergeBodies.map((body) => String(body.headRef));
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  const source = await artifacts.create("repo-r1", { setDefaultBranch: "main" });
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1), ('u3','eve','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote,default_branch) VALUES ('r1','n1','u1','demo','repo:r1','public','',1,1,'${source.name}','${source.remote}','main');
INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES ('r1','u2','write',1);
INSERT INTO forge_webhooks (id,repository_id,url,events_json,secret_ciphertext,secret_iv,created_by,created_at,updated_at) VALUES ('hook1','r1','https://hooks.example.test/in','["pull_request"]','x','x','u1',1,1);
INSERT INTO auth_agents (id,user_id,name,description,created_at) VALUES ('a1','u2','helper','',1);
INSERT INTO auth_git_tokens (id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES ('gt1','u2','r1','test','git-hash','write',9999999999999,1);
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','session-hash','gt1','work','artifact://repo-r1','main',NULL,'write','active',1,9999999999999);`
  );
});

beforeEach(() => {
  mergeBodies.length = 0;
  mergeUsers.length = 0;
  mergeFailures.clear();
  mergeGate = null;
  onMergeStarted = null;
});

describe("Auto-merge", () => {
  it("merges under the enabling user once required checks pass", async () => {
    await rule("am-main", { checks: ["CI"] });
    const pull = await openPull("am-main");

    const enabled = await enable(pull);
    expect(enabled.status).toBe(201);
    expect(await json(enabled)).toMatchObject({
      enabled: true,
      method: "squash",
      enabledBy: "bob",
      expectedHeadOid: pull.head,
      waitingOn: { code: "checks_required" },
    });

    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies).toHaveLength(0);
    expect(await state(pull)).toBe("open");

    const trigger = context();
    expect((await passCheck(pull, trigger.ctx)).status).toBe(201);
    await trigger.settled();

    expect(mergeBodies).toHaveLength(1);
    expect(mergeBodies[0]).toMatchObject({
      method: "squash",
      baseRef: "am-main",
      headRef: pull.headRef,
      expectedBaseOid: BASE,
      expectedHeadOid: pull.head,
      author: { name: "bob" },
    });
    expect(mergeUsers).toEqual(["u2"]);
    expect(await state(pull)).toBe("merged");
    expect(await autoMergeRow(pull)).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT actor_name AS actor FROM audit_events WHERE action = 'pull_request.merged' AND target_id = ?"
    )
      .bind(pull.id)
      .first<{ actor: string }>();
    expect(audit?.actor).toBe("bob");
    expect(await auditMetadata("pull_request.merged", pull)).toMatchObject({
      trigger: "auto_merge",
    });
    expect(await notifications("u1", "merged")).toBeGreaterThan(0);
  });

  it("merges when a required approval arrives", async () => {
    await rule("am-review", { approvals: 1 });
    const pull = await openPull("am-review");
    await enable(pull);
    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies).toHaveLength(0);

    const trigger = context();
    const review = await call(
      `/repositories/r1/pull-requests/${pull.number}/reviews`,
      "POST",
      bob,
      { state: "approved", body: "", commitOid: pull.head },
      trigger.ctx
    );
    expect(review.status).toBe(201);
    await trigger.settled();
    expect(mergedHeads()).toEqual([pull.headRef]);
  });

  it("is disabled when someone other than the enabler pushes", async () => {
    await rule("am-push", { checks: ["CI"] });
    const pull = await openPull("am-push");
    await enable(pull);
    const next = "9".repeat(40);
    heads.set(pull.headRef, next);

    const trigger = context();
    await passCheck(pull, trigger.ctx, next);
    await trigger.settled();

    expect(mergeBodies).toHaveLength(0);
    expect(await autoMergeRow(pull)).toBeNull();
    expect(await state(pull)).toBe("open");
    expect(await notifications("u2", "auto_merge_disabled")).toBeGreaterThan(0);
    expect(await deliveries("auto_merge_disabled")).toBeGreaterThan(0);
    expect(await auditMetadata("pull_request.auto_merge_disabled", pull)).toMatchObject({
      reason: "head_changed",
    });
    const status = await json(
      await call(`/repositories/r1/pull-requests/${pull.number}/auto-merge`, "GET", bob)
    );
    expect(status).toMatchObject({ enabled: false });
  });

  it("follows pushes made by the enabler", async () => {
    await rule("am-self", { checks: ["CI"] });
    const pull = await openPull("am-self");
    await enable(pull);
    const next = "8".repeat(40);
    heads.set(pull.headRef, next);

    const push = await forge.fetch(
      new Request("https://forge.internal/internal/push-event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId: "r1",
          pusherId: "u2",
          updates: [{ ref: `refs/heads/${pull.headRef}`, before: pull.head, after: next }],
        }),
      }),
      forgeEnv
    );
    expect(push.status).toBe(200);
    await reconcileRepository(forgeEnv, "r1");

    expect(await autoMergeRow(pull)).toMatchObject({ expected_head_oid: next });
    await passCheck(pull, undefined, next);
    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies[0]).toMatchObject({ expectedHeadOid: next });
    expect(await state(pull)).toBe("merged");
  });

  it("is disabled when the enabling user loses permission", async () => {
    await rule("am-perm", { checks: ["CI"] });
    const pull = await openPull("am-perm");
    await enable(pull);
    await passCheck(pull);
    await env.DB.prepare("DELETE FROM repository_collaborators WHERE user_id = 'u2'").run();
    try {
      await reconcileRepository(forgeEnv, "r1");
    } finally {
      await env.DB.prepare(
        "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES ('r1','u2','write',1)"
      ).run();
    }
    expect(mergeBodies).toHaveLength(0);
    expect(await autoMergeRow(pull)).toBeNull();
    expect(await auditMetadata("pull_request.auto_merge_disabled", pull)).toMatchObject({
      reason: "permission_lost",
    });
  });

  it("is disabled when Git reports the proposal no longer merges", async () => {
    const pull = await openPull("am-conflict");
    mergeFailures.set(pull.headRef, { status: 409, code: "merge_conflict" });
    await enable(pull);
    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies).toHaveLength(1);
    expect(await autoMergeRow(pull)).toBeNull();
    expect(await state(pull)).toBe("open");
    expect(await auditMetadata("pull_request.auto_merge_disabled", pull)).toMatchObject({
      reason: "merge_failed",
    });
  });

  it("starts a single merge when triggers race", async () => {
    const pull = await openPull("am-race");
    await enable(pull);
    let release: () => void = () => undefined;
    mergeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      onMergeStarted = resolve;
    });
    const first = reconcileRepository(forgeEnv, "r1");
    await started;
    await Promise.all([reconcileRepository(forgeEnv, "r1"), reconcileRepository(forgeEnv, "r1")]);
    release();
    await first;
    expect(mergeBodies).toHaveLength(1);
    expect(await state(pull)).toBe("merged");
    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies).toHaveLength(1);
  });

  it("bounds the merges a cron sweep performs", async () => {
    const pulls = [
      await openPull("am-sweep-a"),
      await openPull("am-sweep-b"),
      await openPull("am-sweep-c"),
    ];
    for (const pull of pulls) await enable(pull);
    await sweepMergeAutomation(forgeEnv);
    expect(mergeBodies).toHaveLength(2);
    await sweepMergeAutomation(forgeEnv);
    expect(mergeBodies).toHaveLength(3);
    expect(await Promise.all(pulls.map(state))).toEqual(["merged", "merged", "merged"]);
  });

  it("limits who can enable it and rejects stale heads", async () => {
    const pull = await openPull("am-guard");
    expect((await enable(pull, eve)).status).toBe(403);
    expect((await enable(pull, bob, "squash", "7".repeat(40))).status).toBe(409);
    const session = headers("u2", "bob");
    session.set(
      "X-GitEdge-Agent-Session",
      JSON.stringify({
        id: "s1",
        agentId: "a1",
        agentName: "helper",
        repositoryId: "r1",
        workspaceName: "work",
        remote: "artifact://repo-r1",
        baseRef: "main",
        baseOid: null,
        permission: "write",
        status: "active",
        createdAt: 1,
        expiresAt: 9999999999999,
      })
    );
    const agent = await forge.fetch(
      new Request(`https://forge.test/repositories/r1/pull-requests/${pull.number}/auto-merge`, {
        method: "PUT",
        headers: session,
        body: JSON.stringify({ method: "merge", expectedHeadOid: pull.head }),
      }),
      forgeEnv
    );
    expect(agent.status).toBe(403);
    expect(await autoMergeRow(pull)).toBeNull();
  });

  it("can be turned off by a member", async () => {
    await rule("am-off", { checks: ["CI"] });
    const pull = await openPull("am-off");
    await enable(pull);
    const removed = await call(
      `/repositories/r1/pull-requests/${pull.number}/auto-merge`,
      "DELETE",
      alice
    );
    expect(removed.status).toBe(200);
    expect(await json(removed)).toMatchObject({ enabled: false });
    expect(await autoMergeRow(pull)).toBeNull();
    expect(await auditMetadata("pull_request.auto_merge_disabled", pull)).toMatchObject({
      reason: "manual",
    });
  });
});

describe("Merge queue", () => {
  function enqueue(pull: Fixture, who = bob) {
    return call(`/repositories/r1/pull-requests/${pull.number}/merge-queue`, "POST", who, {
      method: "merge",
      expectedHeadOid: pull.head,
    });
  }

  it("rejects direct merges and merges queued pull requests in order", async () => {
    await rule("mq-order", { queue: true });
    const pulls = [
      await openPull("mq-order"),
      await openPull("mq-order"),
      await openPull("mq-order"),
    ];

    const direct = await call(
      `/repositories/r1/pull-requests/${pulls[0].number}/merge`,
      "POST",
      bob,
      { method: "merge", expectedBaseOid: BASE, expectedHeadOid: pulls[0].head }
    );
    expect(direct.status).toBe(409);
    expect(await direct.json()).toMatchObject({ error: { code: "merge_queue_required" } });

    for (const [index, pull] of pulls.entries()) {
      const response = await enqueue(pull);
      expect(response.status).toBe(201);
      expect(await json(response)).toMatchObject({ required: true, position: index + 1 });
    }
    expect((await enqueue(pulls[1])).status).toBe(200);

    const listing = await json<{ entries: Array<{ pullRequestNumber: number }> }>(
      await call("/repositories/r1/merge-queue?branch=mq-order", "GET", eve)
    );
    expect(listing.entries.map((entry) => entry.pullRequestNumber)).toEqual(
      pulls.map((pull) => pull.number)
    );

    await processMergeQueue(forgeEnv, "r1", "mq-order", { merges: 10 });

    expect(mergedHeads()).toEqual(pulls.map((pull) => pull.headRef));
    const bases = mergeBodies.map((body) => body.expectedBaseOid);
    expect(bases[0]).toBe(BASE);
    expect(new Set(bases).size).toBe(3);
    expect(await Promise.all(pulls.map(state))).toEqual(["merged", "merged", "merged"]);
    const status = await json(
      await call(`/repositories/r1/pull-requests/${pulls[0].number}/merge-queue`, "GET", bob)
    );
    expect(status).toMatchObject({ position: null, length: 0 });
  });

  it("ejects a conflicting entry with a notification and continues", async () => {
    await rule("mq-conflict", { queue: true });
    const [one, two, three] = [
      await openPull("mq-conflict"),
      await openPull("mq-conflict"),
      await openPull("mq-conflict"),
    ];
    mergeFailures.set(two.headRef, { status: 409, code: "merge_conflict" });
    for (const pull of [one, two, three]) await enqueue(pull);

    await processMergeQueue(forgeEnv, "r1", "mq-conflict", { merges: 10 });

    expect(mergedHeads()).toEqual([one.headRef, two.headRef, three.headRef]);
    expect(await state(one)).toBe("merged");
    expect(await state(two)).toBe("open");
    expect(await state(three)).toBe("merged");
    expect(await notifications("u2", "queue_ejected")).toBeGreaterThan(0);
    expect(await notifications("u1", "queue_ejected")).toBeGreaterThan(0);
    expect(await deliveries("dequeued")).toBeGreaterThan(0);
    const queue = await json<{ entries: unknown[] }>(
      await call("/repositories/r1/merge-queue?branch=mq-conflict", "GET", bob)
    );
    expect(queue.entries).toHaveLength(0);
  });

  it("ejects an entry whose head moved after it was queued", async () => {
    await rule("mq-moved", { queue: true });
    const [one, two] = [await openPull("mq-moved"), await openPull("mq-moved")];
    await enqueue(one);
    await enqueue(two);
    heads.set(one.headRef, "6".repeat(40));
    await processMergeQueue(forgeEnv, "r1", "mq-moved", { merges: 10 });
    expect(mergedHeads()).toEqual([two.headRef]);
    expect(await state(one)).toBe("open");
    expect(await notifications("u2", "queue_ejected")).toBeGreaterThan(0);
  });

  it("lets a member remove an entry that is not being merged", async () => {
    await rule("mq-remove", { queue: true });
    const [one, two] = [await openPull("mq-remove"), await openPull("mq-remove")];
    await enqueue(one);
    await enqueue(two);
    const removed = await call(
      `/repositories/r1/pull-requests/${one.number}/merge-queue`,
      "DELETE",
      alice
    );
    expect(removed.status).toBe(200);
    expect(await json(removed)).toMatchObject({ position: null, length: 1 });
    await processMergeQueue(forgeEnv, "r1", "mq-remove", { merges: 10 });
    expect(mergedHeads()).toEqual([two.headRef]);
  });

  it("refuses queueing where no queue is required or the pull request is not ready", async () => {
    const plain = await openPull("mq-none");
    expect((await enqueue(plain)).status).toBe(409);
    await rule("mq-checks", { queue: true, checks: ["CI"] });
    const blocked = await openPull("mq-checks");
    const response = await enqueue(blocked);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "checks_required" } });
    expect((await enqueue(blocked, eve)).status).toBe(403);
  });

  it("processes each entry once when workers race", async () => {
    await rule("mq-race", { queue: true });
    const [one, two] = [await openPull("mq-race"), await openPull("mq-race")];
    await enqueue(one);
    await enqueue(two);
    let release: () => void = () => undefined;
    mergeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      onMergeStarted = resolve;
    });
    const first = processMergeQueue(forgeEnv, "r1", "mq-race", { merges: 1 });
    await started;
    await processMergeQueue(forgeEnv, "r1", "mq-race", { merges: 5 });
    expect(mergeBodies).toHaveLength(1);
    const removal = await call(
      `/repositories/r1/pull-requests/${one.number}/merge-queue`,
      "DELETE",
      bob
    );
    expect(removal.status).toBe(409);
    release();
    await first;
    mergeGate = null;
    await processMergeQueue(forgeEnv, "r1", "mq-race", { merges: 5 });
    expect(mergedHeads()).toEqual([one.headRef, two.headRef]);
  });

  it("queues an auto-merge pull request once it is ready", async () => {
    await rule("mq-auto", { queue: true, checks: ["CI"] });
    const pull = await openPull("mq-auto");
    expect((await enable(pull)).status).toBe(201);
    await reconcileRepository(forgeEnv, "r1");
    expect(mergeBodies).toHaveLength(0);
    await passCheck(pull);
    await reconcileRepository(forgeEnv, "r1");
    expect(await state(pull)).toBe("merged");
    expect(await autoMergeRow(pull)).toBeNull();
    expect(mergeBodies[0]).toMatchObject({ method: "squash" });
    const queued = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'pull_request.queued' AND target_id = ?"
    )
      .bind(pull.id)
      .first<{ count: number }>();
    expect(queued?.count).toBe(1);
  });
});
