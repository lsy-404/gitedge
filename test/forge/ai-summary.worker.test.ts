import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import { drainAiSummaries } from "../../workers/forge/src/ai-summary";
import { AiSummaryStateSchema } from "../support/ai-summary";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const BASE = "e".repeat(40);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
let head = HEAD_A;
let patch = "@@ -1 +1 @@\n-old\n+new";
let comparisonTruncated = false;
let modelOutput: Record<string, unknown> = {};
const aiCalls: {
  model: string;
  messages: { role: string; content: string }[];
  signal: AbortSignal | undefined;
}[] = [];
const goodOutput = {
  response: JSON.stringify({
    overview: "Renames a helper.",
    notableChanges: ["Renamed helper"],
    riskAreas: ["Callers outside the repository"],
    reviewerFocus: ["Check the call sites"],
  }),
};

const AI = {
  async run(model: string, inputs: Record<string, unknown>, options?: AiOptions) {
    const parsed = z
      .object({ messages: z.array(z.object({ role: z.string(), content: z.string() })) })
      .parse(inputs);
    aiCalls.push({ model, messages: parsed.messages, signal: options?.signal });
    return modelOutput;
  },
};
const GIT = {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pull-head")) return Response.json({ data: { oid: head } });
    if (url.pathname.endsWith("/compare"))
      return Response.json({
        data: {
          baseOid: BASE,
          headOid: head,
          mergeBaseOid: BASE,
          commits: [{ message: "Rename helper" }],
          files: [
            {
              path: "src/app.ts",
              type: "modified",
              oldOid: BASE,
              newOid: head,
              patch,
              binary: false,
            },
          ],
          truncated: comparisonTruncated,
        },
      });
    return Response.json({ data: { oid: "c".repeat(40) } });
  },
};
const baseEnv: Parameters<typeof forge.fetch>[1] = { DB: env.DB, ARTIFACTS: artifacts, GIT };
let siteEnv: Parameters<typeof forge.fetch>[1] = { ...baseEnv, AI };

const users = {
  owner: ["u1", "owner"],
  writer: ["u2", "writer"],
  reader: ["u3", "reader"],
  stranger: ["u4", "stranger"],
} as const;
type Who = keyof typeof users | "anonymous" | "agent";

function request(
  path: string,
  method: string,
  who: Who,
  body?: unknown,
  target: Parameters<typeof forge.fetch>[1] = siteEnv
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (who !== "anonymous") {
    const [id, name] = users[who === "agent" ? "writer" : who];
    headers.set("X-GitEdge-User-Id", id);
    headers.set("X-GitEdge-User-Name", name);
    headers.set("X-GitEdge-User-Group", "free");
  }
  if (who === "agent")
    headers.set(
      "X-GitEdge-Agent-Session",
      JSON.stringify({
        id: "s1",
        agentId: "a1",
        agentName: "helper",
        repositoryId: "r1",
        workspaceName: "w",
        permission: "write",
      })
    );
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: who === "anonymous" && method === "GET" ? undefined : headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    target
  );
}
async function state(repo: string, number: number, who: Who = "owner") {
  const response = await request(
    `/repositories/${repo}/pull-requests/${number}/ai-summary`,
    "GET",
    who
  );
  expect(response.status).toBe(200);
  return AiSummaryStateSchema.parse(await response.json()).data;
}
async function openPull(repo: string): Promise<number> {
  const response = await request(`/repositories/${repo}/pull-requests`, "POST", "writer", {
    title: "Rename helper",
    body: "Renames the helper.",
    baseRef: "main",
    headRef: "topic",
  });
  expect(response.status).toBe(201);
  return z.object({ data: z.object({ number: z.number() }) }).parse(await response.json()).data
    .number;
}
async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}
function pushEvent(repositoryId: string) {
  return forge.fetch(
    new Request("https://forge.internal/internal/push-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId,
        pusherId: "u2",
        updates: [{ ref: "refs/heads/topic", before: "0".repeat(40), after: head }],
      }),
    }),
    siteEnv
  );
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  const source = await artifacts.create("repo-r1", { setDefaultBranch: "main" });
  const repo = (id: string, slug: string, visibility: string, enabled: number, consent: number) =>
    `('${id}','n1','u1','${slug}','repo:${id}','${visibility}','',1,1,'${source.name}','${source.remote}','main',${enabled},${consent})`;
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('u1','owner','x','x',1), ('u2','writer','x','x',1), ('u3','reader','x','x',1), ('u4','stranger','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','owner','u1',1,'personal','Owner','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','u1',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote,default_branch,ai_summaries_enabled,ai_summaries_private_consent) VALUES ${[
      repo("r1", "enabled", "public", 1, 0),
      repo("r2", "off", "public", 0, 0),
      repo("r3", "secret", "private", 1, 0),
      repo("r4", "secret-consented", "private", 1, 1),
      repo("r5", "gated", "public", 1, 0),
    ].join(",")};
INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES ${[
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
    ]
      .flatMap((id) => [`('${id}','u2','write',1)`, `('${id}','u3','read',1)`])
      .join(",")};
INSERT INTO forge_counters (repository_id) VALUES ('r1'),('r2'),('r3'),('r4'),('r5');`
  );
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM forge_ai_summaries"),
    env.DB.prepare("DELETE FROM forge_ai_usage"),
    env.DB.prepare("UPDATE forge_pull_requests SET state = 'closed'"),
  ]);
  head = HEAD_A;
  patch = "@@ -1 +1 @@\n-old\n+new";
  comparisonTruncated = false;
  modelOutput = goodOutput;
  aiCalls.length = 0;
  siteEnv = { ...baseEnv, AI };
});

describe("AI pull request summaries", () => {
  it("stays off without the Workers AI binding or with the kill switch", async () => {
    const number = await openPull("r1");
    expect(await count("forge_ai_summaries")).toBe(1);
    await env.DB.prepare("DELETE FROM forge_ai_summaries").run();
    siteEnv = baseEnv;
    expect(await state("r1", number)).toMatchObject({
      unavailable: "site_disabled",
      summary: null,
    });
    const regenerate = await request(
      `/repositories/r1/pull-requests/${number}/ai-summary`,
      "POST",
      "writer"
    );
    expect(regenerate.status).toBe(409);
    await drainAiSummaries(baseEnv);
    siteEnv = { ...baseEnv, AI, AI_SUMMARIES_DISABLED: "true" };
    expect(await state("r1", number)).toMatchObject({ unavailable: "site_disabled" });
    await openPull("r1");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(0);
    expect(await count("forge_ai_summaries")).toBe(0);
  });

  it("does nothing while the repository setting is off", async () => {
    const number = await openPull("r2");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(0);
    expect(await state("r2", number)).toMatchObject({
      unavailable: "repository_disabled",
      summary: null,
      job: null,
    });
    const regenerate = await request(
      `/repositories/r2/pull-requests/${number}/ai-summary`,
      "POST",
      "writer"
    );
    expect(regenerate.status).toBe(409);
  });

  it("requires explicit consent before a private repository is sent to the model", async () => {
    const number = await openPull("r3");
    expect(await count("forge_ai_summaries")).toBe(0);
    expect(await state("r3", number)).toMatchObject({ unavailable: "private_consent_required" });
    await env.DB.prepare("UPDATE repositories SET ai_summaries_enabled = 0 WHERE id = 'r3'").run();
    const bare = await request("/repositories/r3/settings", "PATCH", "owner", {
      aiSummariesEnabled: true,
    });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ error: { code: "private_consent_required" } });
    const stored = await request("/repositories/r3/settings", "PATCH", "owner", {
      aiSummariesEnabled: true,
      aiSummariesPrivateConsent: true,
    });
    expect(stored.status).toBe(200);
    expect((await state("r3", number)).unavailable).toBeNull();
    await env.DB.prepare(
      "UPDATE repositories SET ai_summaries_private_consent = 0 WHERE id = 'r3'"
    ).run();
    const hidden = await request("/repositories/r3/settings", "PATCH", "owner", {
      visibility: "public",
    });
    expect(hidden.status).toBe(200);
    const flipped = await request("/repositories/r3/settings", "PATCH", "owner", {
      visibility: "private",
    });
    expect(flipped.status).toBe(400);
    expect(await flipped.json()).toMatchObject({ error: { code: "private_consent_required" } });
    await env.DB.prepare("UPDATE repositories SET visibility = 'private' WHERE id = 'r3'").run();
    expect(await state("r3", number)).toMatchObject({ unavailable: "private_consent_required" });
    const consented = await request("/repositories/r3/settings", "PATCH", "owner", {
      aiSummariesPrivateConsent: true,
    });
    expect(consented.status).toBe(200);
    const withdrawn = await request("/repositories/r3/settings", "PATCH", "owner", {
      aiSummariesPrivateConsent: false,
    });
    expect(withdrawn.status).toBe(400);
    const switchedOff = await request("/repositories/r3/settings", "PATCH", "owner", {
      aiSummariesEnabled: false,
      aiSummariesPrivateConsent: false,
    });
    expect(switchedOff.status).toBe(200);
    expect(await state("r3", number)).toMatchObject({ unavailable: "repository_disabled" });
    await env.DB.prepare(
      "UPDATE repositories SET ai_summaries_enabled = 1, ai_summaries_private_consent = 0 WHERE id = 'r3'"
    ).run();
  });

  it("limits who can change the setting", async () => {
    for (const who of ["writer", "reader"] as const) {
      const denied = await request("/repositories/r5/settings", "PATCH", who, {
        aiSummariesEnabled: false,
      });
      expect(denied.status).toBe(403);
    }
    const settings = await request("/repositories/r5/settings", "GET", "owner");
    expect(await settings.json()).toMatchObject({
      data: { aiSummariesAvailable: true, aiSummariesEnabled: true },
    });
    siteEnv = baseEnv;
    const hiddenSettings = await request("/repositories/r5/settings", "GET", "owner");
    expect(await hiddenSettings.json()).toMatchObject({ data: { aiSummariesAvailable: false } });
  });

  it("generates a labeled system summary when a pull request opens", async () => {
    const number = await openPull("r1");
    expect(await state("r1", number)).toMatchObject({
      summary: null,
      job: { status: "queued" },
    });
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(1);
    const current = await state("r1", number, "anonymous");
    expect(current.summary).toMatchObject({
      author: { kind: "system", name: "AI summary" },
      headOid: HEAD_A,
      truncated: false,
      content: { overview: "Renames a helper.", riskAreas: ["Callers outside the repository"] },
    });
    expect(current.job).toBeNull();
    expect(aiCalls[0].signal).toBeInstanceOf(AbortSignal);
    const prompt = aiCalls[0].messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("+new");
  });

  it("never re-bills an object id that already has a summary", async () => {
    const number = await openPull("r1");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(1);
    expect((await pushEvent("r1")).status).toBe(200);
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(1);
    expect(await count("forge_ai_summaries")).toBeGreaterThan(0);
    head = HEAD_B;
    await pushEvent("r1");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(2);
    expect((await state("r1", number)).summary?.headOid).toBe(HEAD_B);
    head = HEAD_A;
    await pushEvent("r1");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(2);
  });

  it("reports truncation to the model and to readers", async () => {
    patch = "@@ -1 +1 @@\n" + "+line of added code\n".repeat(10_000);
    comparisonTruncated = true;
    const number = await openPull("r1");
    await drainAiSummaries(siteEnv);
    expect((await state("r1", number)).summary?.truncated).toBe(true);
    const prompt = aiCalls[0].messages.map((message) => message.content).join("\n");
    expect(prompt).toContain("Input truncated");
    expect(prompt.length).toBeLessThan(60_000);
  });

  it("records a failure for unusable model output without a summary", async () => {
    modelOutput = { response: "not json" };
    const number = await openPull("r1");
    await drainAiSummaries(siteEnv);
    expect(await state("r1", number)).toMatchObject({
      summary: null,
      job: { status: "failed", errorCode: "invalid_output" },
    });
  });

  it("lets only write members regenerate, and re-bills only on request", async () => {
    const number = await openPull("r1");
    await drainAiSummaries(siteEnv);
    const path = `/repositories/r1/pull-requests/${number}/ai-summary`;
    for (const who of ["anonymous", "stranger", "reader", "agent"] as const)
      expect([401, 403, 404]).toContain((await request(path, "POST", who)).status);
    expect(await count("forge_ai_summaries")).toBe(1);
    const accepted = await request(path, "POST", "writer");
    expect(accepted.status).toBe(202);
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(2);
    expect((await state("r1", number)).summary?.headOid).toBe(HEAD_A);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM forge_ai_summaries WHERE pull_request_id = (SELECT id FROM forge_pull_requests WHERE number = ? AND repository_id = 'r1') AND status = 'succeeded'"
    )
      .bind(number)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("rate limits model calls per repository", async () => {
    const limited = { ...siteEnv, AI_SUMMARY_HOURLY_LIMIT: "1" };
    siteEnv = limited;
    const number = await openPull("r1");
    await env.DB.prepare("DELETE FROM forge_ai_usage").run();
    await drainAiSummaries(limited);
    expect(aiCalls).toHaveLength(1);
    const path = `/repositories/r1/pull-requests/${number}/ai-summary`;
    const blocked = await request(path, "POST", "writer");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    await env.DB.prepare("DELETE FROM forge_ai_usage").run();
  });

  it("cannot satisfy review or approval requirements", async () => {
    await env.DB.prepare("UPDATE repositories SET required_approvals = 1 WHERE id = 'r4'").run();
    await env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id,user_id,role,created_at) VALUES ('r4','u2','write',1) ON CONFLICT DO NOTHING"
    ).run();
    const number = await openPull("r4");
    await drainAiSummaries(siteEnv);
    expect((await state("r4", number)).summary).not.toBeNull();
    expect(await count("forge_reviews")).toBe(0);
    const comments = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM forge_comments WHERE repository_id = 'r4'"
    ).first<{ n: number }>();
    expect(comments?.n).toBe(0);
    const merged = await request(
      `/repositories/r4/pull-requests/${number}/merge`,
      "POST",
      "owner",
      {
        expectedBaseOid: BASE,
        expectedHeadOid: HEAD_A,
      }
    );
    expect(merged.status).toBe(409);
    expect(await merged.json()).toMatchObject({ error: { code: "approvals_required" } });
  });

  it("runs summaries from the scheduled drain, not from request waitUntil", async () => {
    const pending: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (promise) => void pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    };
    const response = await forge.fetch(
      new Request("https://forge.test/repositories/r1/pull-requests", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitEdge-User-Id": "u2",
          "X-GitEdge-User-Name": "writer",
          "X-GitEdge-User-Group": "free",
        },
        body: JSON.stringify({ title: "Inline", body: "", baseRef: "main", headRef: "topic" }),
      }),
      siteEnv,
      ctx
    );
    expect(response.status).toBe(201);
    await Promise.all(pending);
    expect(aiCalls).toHaveLength(0);
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(1);
  });

  it("never runs two jobs of one pull request at the same time", async () => {
    const number = await openPull("r1");
    await env.DB.prepare(
      "UPDATE forge_ai_summaries SET status = 'running', started_at = ? WHERE status = 'queued'"
    )
      .bind(Date.now())
      .run();
    const accepted = await request(
      `/repositories/r1/pull-requests/${number}/ai-summary`,
      "POST",
      "writer"
    );
    expect(accepted.status).toBe(202);
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(0);
    expect(await state("r1", number)).toMatchObject({ job: { status: "queued" } });
  });

  it("holds the hourly limit across pull requests drained together", async () => {
    siteEnv = { ...siteEnv, AI_SUMMARY_HOURLY_LIMIT: "1" };
    const first = await openPull("r1");
    const second = await openPull("r1");
    await drainAiSummaries(siteEnv);
    expect(aiCalls).toHaveLength(1);
    expect(await count("forge_ai_usage")).toBe(1);
    const states = [await state("r1", first), await state("r1", second)];
    expect(states.filter((entry) => entry.summary !== null)).toHaveLength(1);
    expect(states.filter((entry) => entry.job?.errorCode === "rate_limited")).toHaveLength(1);
  });
});
