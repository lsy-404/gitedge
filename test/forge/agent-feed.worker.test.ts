import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_FEED_MAX_EVENTS,
  AGENT_FEED_RETENTION_MS,
  AgentFeedPageSchema,
  type AgentFeedPage,
} from "../../packages/contracts/src/index";
import forge from "../../workers/forge/src/index";
import {
  appendFeedEvent,
  pollFeed,
  purgeAgentFeeds,
  streamFeed,
} from "../../workers/forge/src/agent-feed";
import { agentEvent } from "../../workers/forge/src/agent-events";
import type { RepositoryRow } from "../../workers/forge/src/common";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  GIT: { fetch: async () => Response.json({ error: { code: "not_found" } }, { status: 404 }) },
};
const repository = { id: "r1", agents_enabled: 1 } as RepositoryRow;
const scope = { agentId: "a1", repositoryId: "r1" };

function session(id: string, agentId: string, repositoryId = "r1") {
  return {
    id,
    agentId,
    agentName: "bob-agent",
    repositoryId,
    workspaceName: `workspace-${id}`,
    permission: "read",
  };
}

function call(path: string, user: string, agentSession?: unknown): Promise<Response> {
  const headers = new Headers({
    "X-GitEdge-User-Id": user,
    "X-GitEdge-User-Name": user,
    "X-GitEdge-User-Group": "free",
  });
  if (agentSession) headers.set("X-GitEdge-Agent-Session", JSON.stringify(agentSession));
  return forge.fetch(new Request(`https://forge.test${path}`, { headers }), forgeEnv);
}

/** Parses a poll page against the documented schema; parsing drops undeclared keys, so equality proves there are none. */
async function page(response: Response): Promise<AgentFeedPage> {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const parsed = z.object({ data: AgentFeedPageSchema }).parse(body);
  expect(parsed).toEqual(body);
  return parsed.data;
}

/** A clock whose sleeps advance time instantly. */
function fakeClock() {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

async function setMode(mode: "webhook" | "pull" | "both"): Promise<void> {
  await env.DB.prepare("UPDATE auth_agents SET delivery_mode = ? WHERE id = 'a1'").bind(mode).run();
}

async function emit(count: number, event: "agent.assigned" | "comment.created" = "agent.assigned") {
  for (let index = 0; index < count; index += 1)
    await agentEvent(forgeEnv, repository, { id: "u1" }, "a1", event, { index });
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','alice','x','x',1), ('u2','bob','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','u1',1,'personal','Alice','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner'), ('n1','u2',1,'member');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES ('r1','n1','u1','demo','repo:r1','private','',1,1,'repo-r1','x'), ('r2','n1','u1','other','repo:r2','private','',1,1,'repo-r2','x');
INSERT INTO auth_agents (id,user_id,name,description,created_at,handle) VALUES ('a1','u2','bob-agent','',1,'bob-agent');
INSERT INTO auth_agent_sessions (id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES ('s1','a1','u2','r1','h1','g1','workspace-s1','x','main',NULL,'read','active',1,9999999999999), ('s2','a1','u2','r2','h2','g2','workspace-s2','x','main',NULL,'read','active',1,9999999999999);`
  );
});

describe("agent pull feed", () => {
  it("is available only to agent sessions of the repository whose agent chose pull delivery", async () => {
    const path = "/repositories/r1/agent-events";
    expect((await call(path, "u2")).status).toBe(403);
    expect((await call(path, "u2", session("s2", "a1", "r2"))).status).toBe(403);
    const disabled = await call(path, "u2", session("s1", "a1"));
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toMatchObject({ error: { code: "pull_delivery_disabled" } });
    await setMode("pull");
    expect((await call(path, "u2", session("s1", "a1"))).status).toBe(200);
  });

  it("writes feed events only for pull and both modes", async () => {
    await setMode("webhook");
    await emit(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM forge_agent_events").first()).toEqual({
      n: 0,
    });
    await setMode("pull");
    await emit(1);
    await setMode("both");
    await emit(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM forge_agent_events").first()).toEqual({
      n: 2,
    });
  });

  it("serves ordered pages with monotonic cursors that resume after the last event", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await setMode("pull");
    await emit(3);
    const first = await page(
      await call("/repositories/r1/agent-events?limit=2", "u2", session("s1", "a1"))
    );
    expect(first.events.map((event) => event.data.index)).toEqual([0, 1]);
    expect(first.more).toBe(true);
    expect(first.events[0]?.cursor).toBeLessThan(first.events[1]?.cursor ?? 0);
    expect(first.cursor).toBe(first.events[1]?.cursor);
    expect(first.events[0]).toMatchObject({
      event: "agent.assigned",
      data: { repositoryId: "r1", agentId: "a1", index: 0 },
    });
    const second = await page(
      await call(`/repositories/r1/agent-events?cursor=${first.cursor}`, "u2", session("s1", "a1"))
    );
    expect(second.events.map((event) => event.data.index)).toEqual([2]);
    expect(second.more).toBe(false);
    const idle = await page(
      await call(`/repositories/r1/agent-events?cursor=${second.cursor}`, "u2", session("s1", "a1"))
    );
    expect(idle).toEqual({ events: [], cursor: second.cursor, more: false });
  });

  it("scopes events to the session repository", async () => {
    await agentEvent(
      forgeEnv,
      { id: "r2", agents_enabled: 1 } as RepositoryRow,
      { id: "u1" },
      "a1",
      "agent.assigned",
      { other: true }
    );
    const feed = await page(
      await call("/repositories/r1/agent-events?limit=100", "u2", session("s1", "a1"))
    );
    expect(feed.events.every((event) => event.data.repositoryId === "r1")).toBe(true);
  });

  it("rejects out-of-range queries", async () => {
    for (const query of ["wait=26", "wait=-1", "limit=0", "limit=101", "cursor=-3", "cursor=abc"])
      expect(
        (await call(`/repositories/r1/agent-events?${query}`, "u2", session("s1", "a1"))).status
      ).toBe(400);
  });

  it("answers cursor_expired once events after the cursor were pruned by age", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await env.DB.prepare("DELETE FROM forge_agent_feed_state").run();
    await emit(3);
    const all = await page(await call("/repositories/r1/agent-events", "u2", session("s1", "a1")));
    const [oldest, middle] = all.events;
    await env.DB.prepare("UPDATE forge_agent_events SET created_at = ? WHERE id <= ?")
      .bind(Date.now() - AGENT_FEED_RETENTION_MS - 1000, middle?.cursor)
      .run();
    const expired = await call(
      `/repositories/r1/agent-events?cursor=${(oldest?.cursor ?? 1) - 1}`,
      "u2",
      session("s1", "a1")
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({
      error: { code: "cursor_expired", oldestCursor: middle?.cursor },
    });
    const resumed = await page(
      await call(
        `/repositories/r1/agent-events?cursor=${middle?.cursor}`,
        "u2",
        session("s1", "a1")
      )
    );
    expect(resumed.events).toHaveLength(1);
    const fresh = await page(
      await call("/repositories/r1/agent-events", "u2", session("s1", "a1"))
    );
    expect(fresh.events).toHaveLength(1);
  });

  it("keeps at most the newest events and expires cursors that fell behind", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await env.DB.prepare("DELETE FROM forge_agent_feed_state").run();
    await env.DB.prepare(
      "INSERT INTO forge_agent_feed_state (agent_id, repository_id) VALUES ('a1','r1')"
    ).run();
    await env.DB.prepare(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO forge_agent_events (agent_id, repository_id, event_id, event, payload, created_at) SELECT 'a1','r1','seed-' || i,'agent.assigned','{}',? FROM n"
    )
      .bind(AGENT_FEED_MAX_EVENTS, Date.now())
      .run();
    expect(
      await appendFeedEvent(forgeEnv, repository, "a1", "comment.created", { last: true })
    ).toBe(true);
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MIN(id) AS first FROM forge_agent_events"
    ).first<{ n: number; first: number }>();
    expect(retained?.n).toBe(AGENT_FEED_MAX_EVENTS);
    const state = await env.DB.prepare("SELECT pruned_through FROM forge_agent_feed_state").first<{
      pruned_through: number;
    }>();
    expect(state?.pruned_through).toBe((retained?.first ?? 0) - 1);
    const behind = await call("/repositories/r1/agent-events?cursor=0", "u2", session("s1", "a1"));
    expect(behind.status).toBe(410);
    const caught = await call(
      `/repositories/r1/agent-events?cursor=${state?.pruned_through}&limit=1`,
      "u2",
      session("s1", "a1")
    );
    expect(caught.status).toBe(200);
  });

  it("moves the cursor past rows it cannot present", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await env.DB.prepare("DELETE FROM forge_agent_feed_state").run();
    await env.DB.prepare(
      "INSERT INTO forge_agent_events (agent_id, repository_id, event_id, event, payload, created_at) VALUES ('a1','r1','broken','unknown.event','{}',?)"
    )
      .bind(Date.now())
      .run();
    const broken = await page(
      await call("/repositories/r1/agent-events", "u2", session("s1", "a1"))
    );
    expect(broken.events).toEqual([]);
    expect(broken.cursor).toBeGreaterThan(0);
    await emit(1);
    const next = await page(
      await call(`/repositories/r1/agent-events?cursor=${broken.cursor}`, "u2", session("s1", "a1"))
    );
    expect(next.events).toHaveLength(1);
  });

  it("removes aged events in the scheduled sweep", async () => {
    await env.DB.prepare("UPDATE forge_agent_events SET created_at = 1").run();
    await purgeAgentFeeds(forgeEnv);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM forge_agent_events").first()).toEqual({
      n: 0,
    });
    expect(
      (await call("/repositories/r1/agent-events?cursor=0", "u2", session("s1", "a1"))).status
    ).toBe(410);
  });
});

describe("long polling and streaming", () => {
  it("waits no longer than the requested bound with backing-off polls", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    const clock = fakeClock();
    const result = await page(await pollFeed(forgeEnv, scope, { limit: 10, wait: 25 }, clock));
    expect(result.events).toEqual([]);
    const waited = clock.sleeps.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBe(25_000);
    expect(clock.sleeps.length).toBeLessThan(15);
    expect(clock.sleeps.slice(0, 4)).toEqual([500, 1000, 2000, 3000]);
    const none = fakeClock();
    await pollFeed(forgeEnv, scope, { limit: 10, wait: 0 }, none);
    expect(none.sleeps).toEqual([]);
  });

  it("returns as soon as an event arrives while waiting", async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await page(
      await pollFeed(
        forgeEnv,
        scope,
        { limit: 10, wait: 25 },
        {
          now: clock.now,
          sleep: async (ms) => {
            await clock.sleep(ms);
            calls += 1;
            if (calls === 2) await emit(1, "comment.created");
          },
        }
      )
    );
    expect(clock.sleeps).toEqual([500, 1000]);
    expect(result.events.map((event) => event.event)).toEqual(["comment.created"]);
  });

  it("streams events as SSE frames and resumes from Last-Event-ID", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await emit(2);
    const clock = fakeClock();
    const open = async (cursor?: number) => {
      const response = await streamFeed(
        forgeEnv,
        new Request("https://forge.test/stream"),
        scope,
        cursor,
        {
          now: clock.now,
          sleep: clock.sleep,
          streamMs: 10_000,
        }
      );
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      return response.text();
    };
    const body = await open();
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids).toHaveLength(2);
    expect(body).toContain("event: agent.assigned");
    const resumed = await open(ids[0]);
    expect([...resumed.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([
      ids[1],
    ]);
  });
});

describe("stream resume", () => {
  it("prefers Last-Event-ID over the original cursor when an EventSource reconnects", async () => {
    await env.DB.prepare("DELETE FROM forge_agent_events").run();
    await env.DB.prepare("DELETE FROM forge_agent_feed_state").run();
    await emit(2);
    const all = await page(await call("/repositories/r1/agent-events", "u2", session("s1", "a1")));
    const [first, second] = all.events;
    const headers = new Headers({
      "X-GitEdge-User-Id": "u2",
      "X-GitEdge-User-Name": "u2",
      "X-GitEdge-User-Group": "free",
      "X-GitEdge-Agent-Session": JSON.stringify(session("s1", "a1")),
      "Last-Event-ID": String(first?.cursor),
    });
    const controller = new AbortController();
    const response = await forge.fetch(
      new Request("https://forge.test/repositories/r1/agent-events/stream?cursor=0", {
        headers,
        signal: controller.signal,
      }),
      forgeEnv
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (reader && !/^id: /m.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    controller.abort();
    await reader?.cancel();
    expect([...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual([
      second?.cursor,
    ]);
  });
});

describe("owner feed status", () => {
  it("reports the last poll to the agent owner only", async () => {
    const status = await call("/agents/a1/event-feed", "u2");
    expect(status.status).toBe(200);
    const body = ((await status.json()) as { data: Record<string, unknown> }).data;
    expect(body).toMatchObject({
      deliveryMode: "pull",
      retentionDays: 7,
      maxEvents: AGENT_FEED_MAX_EVENTS,
    });
    expect(typeof body.lastPolledAt).toBe("number");
    expect((await call("/agents/a1/event-feed", "u1")).status).toBe(404);
    expect((await call("/agents/a1/event-feed", "u2", session("s1", "a1"))).status).toBe(403);
  });
});
