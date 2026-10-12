import { env } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import { drainWebhookDeliveries } from "../../workers/forge/src/webhooks";
import type {
  PushEventInput,
  RepositoryWebhook,
  RepositoryWebhookDelivery,
  SavedRepositoryWebhook,
  TrustedUser,
} from "../../packages/contracts/src/index";
import { MergeRequirementsSchema } from "../../packages/contracts/src/merge-requirements";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const refHeadKey = (repositoryId: string, sessionId: string | undefined, ref: string) =>
  `${repositoryId}:${sessionId ?? ""}:${ref}`;
const actualHeads = new Map<string, string | null>();
let failRefHeadLookup = false;
let beforeRefHeadResponse: (() => Promise<void>) | null = null;
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  WEBHOOK_ENCRYPTION_KEY: ENCRYPTION_KEY,
  GIT: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === "/internal/ref-heads") {
        if (failRefHeadLookup) return new Response(null, { status: 503 });
        const input = z
          .object({
            repositoryId: z.string(),
            agentSessionId: z.string().optional(),
            updates: z.array(z.object({ ref: z.string(), after: z.string() })),
          })
          .parse(await request.json());
        const responseHeads = input.updates.map((update) => ({
          ref: update.ref,
          oid: actualHeads.has(refHeadKey(input.repositoryId, input.agentSessionId, update.ref))
            ? actualHeads.get(refHeadKey(input.repositoryId, input.agentSessionId, update.ref))
            : update.after === "0".repeat(40)
              ? null
              : update.after,
        }));
        const race = beforeRefHeadResponse;
        beforeRefHeadResponse = null;
        if (race) await race();
        return Response.json({
          data: {
            heads: responseHeads,
          },
        });
      }
      return Response.json({ data: { oid: "2".repeat(40) } });
    },
  },
};
const people = {
  owner: { id: "u-owner", identifier: "owner", groupKey: "free" },
  writer: { id: "u-writer", identifier: "writer", groupKey: "free" },
  reader: { id: "u-reader", identifier: "reader", groupKey: "free" },
  outsider: { id: "u-outsider", identifier: "outsider", groupKey: "free" },
} satisfies Record<string, TrustedUser>;
type Person = keyof typeof people;

interface Sent {
  url: string;
  headers: Headers;
  body: string;
}
let sent: Sent[] = [];
let respondWith: (attempt: number) => number = () => 204;
const privateHosts = new Set(["rebind.example.com"]);

function pushReport(
  input: Omit<PushEventInput, "eventId" | "occurredAt">,
  eventId = crypto.randomUUID(),
  occurredAt = Date.now()
): PushEventInput {
  return { ...input, eventId, occurredAt };
}

function stubNetwork(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "cloudflare-dns.com") {
      const host = url.searchParams.get("name") ?? "";
      const answers =
        url.searchParams.get("type") === "A"
          ? [{ type: 1, data: privateHosts.has(host) ? "10.0.0.8" : "93.184.216.34" }]
          : [];
      return Response.json({ Status: 0, Answer: answers });
    }
    sent.push({
      url: url.href,
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(null, { status: respondWith(sent.length) });
  });
}

async function call(
  path: string,
  method: string,
  person: Person,
  body?: unknown,
  options: { fresh?: boolean; env?: Partial<typeof forgeEnv> } = {}
): Promise<Response> {
  const user =
    options.fresh === false ? people[person] : { ...people[person], recentAuthAt: Date.now() };
  const headers = trustedHeaders(user);
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...forgeEnv, ...options.env }
  );
}

async function json<T>(response: Response, status?: number): Promise<T> {
  if (status !== undefined) expect(response.status).toBe(status);
  const payload: { data: T } = await response.json();
  return payload.data;
}

async function createHook(
  events: string[] = ["issues"],
  extra: Record<string, unknown> = {}
): Promise<SavedRepositoryWebhook> {
  return json(
    await call("/repositories/rp/webhooks", "POST", "owner", {
      url: "https://hooks.example.com/receive",
      events,
      ...extra,
    }),
    201
  );
}

async function deliveries(hookId: string): Promise<RepositoryWebhookDelivery[]> {
  return json(await call(`/repositories/rp/webhooks/${hookId}/deliveries`, "GET", "owner"), 200);
}

async function removeAllHooks(): Promise<void> {
  await env.DB.prepare("DELETE FROM forge_webhooks").run();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM forge_pull_head_updates"),
    env.DB.prepare("DELETE FROM forge_push_event_refs"),
    env.DB.prepare("DELETE FROM forge_ref_pushers"),
    env.DB.prepare("DELETE FROM forge_agent_events"),
    env.DB.prepare("DELETE FROM forge_agent_feed_state"),
    env.DB.prepare("DELETE FROM forge_notifications"),
    env.DB.prepare(
      "DELETE FROM forge_pull_requests WHERE id IN ('pr-branch','pr-fork','pr-session')"
    ),
    env.DB.prepare("DELETE FROM auth_agent_sessions WHERE id LIKE 'session-%'"),
    env.DB.prepare("DELETE FROM auth_git_tokens WHERE id LIKE 'git-token%'"),
    env.DB.prepare("DELETE FROM forge_assignments WHERE id = 'head-reviewer'"),
    env.DB.prepare("DELETE FROM auth_agents WHERE id IN ('agent-writer','agent-reviewer')"),
    env.DB.prepare("UPDATE users SET disabled_at=NULL"),
    env.DB.prepare("DELETE FROM repositories WHERE id = 'fork-rp'"),
  ]);
  sent = [];
  actualHeads.clear();
  failRefHeadLookup = false;
  beforeRefHeadResponse = null;
  respondWith = () => 204;
}

beforeAll(async () => {
  stubNetwork();
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const person of Object.values(people))
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'s','h',1)"
    )
      .bind(person.id, person.identifier)
      .run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('ns','owner','u-owner',1,'personal')"
    ),
    env.DB.prepare(
      "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('ns','u-owner','owner',1)"
    ),
    env.DB.prepare(
      "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote) VALUES('rp','ns','u-owner','secret','do-rp','private','',1,1,'art-rp','artifact://art-rp')"
    ),
    env.DB.prepare(
      "INSERT INTO repository_collaborators(repository_id,user_id,role,created_at) VALUES('rp','u-writer','write',1),('rp','u-reader','read',1)"
    ),
  ]);
});

beforeEach(async () => {
  await removeAllHooks();
});

afterAll(() => vi.unstubAllGlobals());

describe("webhook configuration access", () => {
  it("is limited to repository administrators", async () => {
    for (const person of ["writer", "reader"] as const) {
      expect((await call("/repositories/rp/webhooks", "GET", person)).status).toBe(403);
      expect(
        (
          await call("/repositories/rp/webhooks", "POST", person, {
            url: "https://hooks.example.com/x",
            events: ["push"],
          })
        ).status
      ).toBe(403);
    }
    expect((await call("/repositories/rp/webhooks", "GET", "outsider")).status).toBe(404);
    expect(await json(await call("/repositories/rp/webhooks", "GET", "owner"), 200)).toEqual([]);
  });

  it("requires recent authentication for changes but not for reads or tests", async () => {
    const stale = await call(
      "/repositories/rp/webhooks",
      "POST",
      "owner",
      { url: "https://hooks.example.com/x", events: ["push"] },
      { fresh: false }
    );
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: "reauth_required" } });
    const hook = await createHook();
    for (const method of ["PATCH", "DELETE"])
      expect(
        (
          await call(
            `/repositories/rp/webhooks/${hook.id}`,
            method,
            "owner",
            { active: false },
            { fresh: false }
          )
        ).status
      ).toBe(403);
    expect(
      (
        await call(`/repositories/rp/webhooks/${hook.id}`, "GET", "owner", undefined, {
          fresh: false,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await call(`/repositories/rp/webhooks/${hook.id}/ping`, "POST", "owner", undefined, {
          fresh: false,
        })
      ).status
    ).toBe(200);
  });

  it("is hidden from other repositories and token scopes below admin", async () => {
    const hook = await createHook();
    expect((await call(`/repositories/rp/webhooks/missing`, "GET", "owner")).status).toBe(404);
    expect((await call(`/repositories/rpx/webhooks/${hook.id}`, "GET", "owner")).status).toBe(404);
    const headers = trustedHeaders({
      ...people.owner,
      token: { id: "tok", scopes: ["repo:write"] },
    });
    const response = await forge.fetch(
      new Request("https://forge.test/repositories/rp/webhooks", { headers }),
      forgeEnv
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_scope" } });
  });
});

describe("webhook URL safety", () => {
  it.each([
    "http://hooks.example.com/receive",
    "https://127.0.0.1/receive",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/receive",
    "https://metadata.internal/receive",
    "https://hooks.example.com:8443/receive",
    "https://user:pw@hooks.example.com/receive",
  ])("rejects %s", async (url) => {
    const response = await call("/repositories/rp/webhooks", "POST", "owner", {
      url,
      events: ["push"],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_webhook_url" } });
  });

  it("rejects public-looking names that resolve to private addresses", async () => {
    const response = await call("/repositories/rp/webhooks", "POST", "owner", {
      url: "https://rebind.example.com/receive",
      events: ["push"],
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_webhook_url" } });
    expect(sent).toEqual([]);
  });

  it("applies the same checks when updating the URL", async () => {
    const hook = await createHook();
    const response = await call(`/repositories/rp/webhooks/${hook.id}`, "PATCH", "owner", {
      url: "https://rebind.example.com/receive",
    });
    expect(response.status).toBe(400);
    expect(
      (
        await json<RepositoryWebhook>(
          await call(`/repositories/rp/webhooks/${hook.id}`, "GET", "owner"),
          200
        )
      ).url
    ).toBe("https://hooks.example.com/receive");
  });

  it("never delivers to a stored URL that fails the screen", async () => {
    const hook = await createHook();
    await env.DB.prepare("UPDATE forge_webhooks SET url = 'http://10.0.0.1/hook' WHERE id = ?")
      .bind(hook.id)
      .run();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Blocked", body: "" });
    await drainWebhookDeliveries(forgeEnv);
    expect(sent).toEqual([]);
    expect(await deliveries(hook.id)).toMatchObject([
      { status: "failed", errorCode: "url_rejected" },
    ]);
  });

  it("rejects unsupported events, empty event lists and a missing encryption key", async () => {
    for (const events of [[], ["deployment"], ["push", "push"]])
      expect(
        (
          await call("/repositories/rp/webhooks", "POST", "owner", {
            url: "https://hooks.example.com/x",
            events,
          })
        ).status
      ).toBe(400);
    const noKey = await call(
      "/repositories/rp/webhooks",
      "POST",
      "owner",
      { url: "https://hooks.example.com/x", events: ["push"] },
      { env: { WEBHOOK_ENCRYPTION_KEY: undefined } }
    );
    expect(noKey.status).toBe(503);
  });

  it("caps the number of webhooks per repository", async () => {
    for (let index = 0; index < 20; index += 1) await createHook(["push"]);
    const response = await call("/repositories/rp/webhooks", "POST", "owner", {
      url: "https://hooks.example.com/x",
      events: ["push"],
    });
    expect(response.status).toBe(409);
  });
});

describe("webhook secrets", () => {
  it("shows a generated secret once and stores only ciphertext", async () => {
    const hook = await createHook();
    expect(hook.secret).toMatch(/^ge_webhook_[0-9a-f]{64}$/);
    const row = await env.DB.prepare(
      "SELECT secret_ciphertext, secret_iv FROM forge_webhooks WHERE id = ?"
    )
      .bind(hook.id)
      .first<{ secret_ciphertext: string; secret_iv: string }>();
    expect(row?.secret_ciphertext).toBeTruthy();
    expect(row?.secret_ciphertext).not.toContain(hook.secret ?? "");
    const listed = JSON.stringify(
      await json(await call("/repositories/rp/webhooks", "GET", "owner"), 200)
    );
    expect(listed).not.toContain(hook.secret ?? "");
    expect(listed).not.toContain(row?.secret_ciphertext ?? "");
    const detail = JSON.stringify(
      await json(await call(`/repositories/rp/webhooks/${hook.id}`, "GET", "owner"), 200)
    );
    expect(detail).not.toContain("secret");
  });

  it("does not echo a caller-supplied secret and rotates on request", async () => {
    const supplied = "my-own-secret-value-123";
    const hook = await createHook(["issues"], { secret: supplied });
    expect(hook.secret).toBeNull();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Signed", body: "" });
    await drainWebhookDeliveries(forgeEnv);
    const expected = `sha256=${createHmac("sha256", supplied).update(sent[0].body).digest("hex")}`;
    expect(sent[0].headers.get("X-Hub-Signature-256")).toBe(expected);

    const rotated = await json<SavedRepositoryWebhook>(
      await call(`/repositories/rp/webhooks/${hook.id}`, "PATCH", "owner", { rotateSecret: true }),
      200
    );
    expect(rotated.secret).toMatch(/^ge_webhook_/);
    await call("/repositories/rp/issues", "POST", "owner", { title: "Rotated", body: "" });
    await drainWebhookDeliveries(forgeEnv);
    const second = sent[1];
    const withNew = `sha256=${createHmac("sha256", rotated.secret ?? "")
      .update(second.body)
      .digest("hex")}`;
    const withOld = `sha256=${createHmac("sha256", supplied).update(second.body).digest("hex")}`;
    expect(second.headers.get("X-Hub-Signature-256")).toBe(withNew);
    expect(second.headers.get("X-Hub-Signature-256")).not.toBe(withOld);
  });
});

describe("webhook delivery", () => {
  it("signs each event body and identifies the event and delivery", async () => {
    const hook = await createHook(["issues", "issue_comment"]);
    const created = await json<{ number: number }>(
      await call("/repositories/rp/issues", "POST", "writer", {
        title: "Hello hooks",
        body: "body",
      }),
      201
    );
    await json(
      await call(`/repositories/rp/issues/${created.number}/comments`, "POST", "reader", {
        body: "hi",
      }),
      201
    );
    expect(await drainWebhookDeliveries(forgeEnv)).toBe(2);
    expect(sent).toHaveLength(2);
    const [opened, commented] = sent;
    expect(opened.url).toBe("https://hooks.example.com/receive");
    expect(opened.headers.get("Content-Type")).toBe("application/json");
    expect(opened.headers.get("X-GitEdge-Event")).toBe("issues");
    expect(commented.headers.get("X-GitEdge-Event")).toBe("issue_comment");
    const expected = createHmac("sha256", hook.secret ?? "")
      .update(opened.body)
      .digest("hex");
    expect(opened.headers.get("X-Hub-Signature-256")).toBe(`sha256=${expected}`);
    const payload = JSON.parse(opened.body);
    expect(payload).toMatchObject({
      action: "opened",
      issue: { number: created.number, title: "Hello hooks", user: { login: "writer" } },
      repository: { id: "rp", full_name: "owner/secret", private: true },
      sender: { login: "writer" },
    });
    expect(JSON.parse(commented.body)).toMatchObject({
      action: "created",
      comment: { body: "hi", user: { login: "reader" } },
    });
    const history = await deliveries(hook.id);
    expect(history.map((item) => item.status)).toEqual(["success", "success"]);
    expect(history.map((item) => item.id)).toContain(opened.headers.get("X-GitEdge-Delivery"));
    expect(history[0]).toMatchObject({ attemptCount: 1, responseStatus: 204, nextAttemptAt: null });
  });

  it("only queues subscribed events for active webhooks", async () => {
    const hook = await createHook(["issue_comment"]);
    const created = await json<{ number: number }>(
      await call("/repositories/rp/issues", "POST", "owner", { title: "Ignored", body: "" }),
      201
    );
    expect(await deliveries(hook.id)).toEqual([]);
    await json(
      await call(`/repositories/rp/webhooks/${hook.id}`, "PATCH", "owner", { active: false }),
      200
    );
    await call(`/repositories/rp/issues/${created.number}/comments`, "POST", "owner", {
      body: "x",
    });
    expect(await deliveries(hook.id)).toEqual([]);
  });

  it("covers pull requests, reviews, checks and merges", async () => {
    const hook = await createHook(["pull_request", "pull_request_review", "check_run"]);
    const request = await json<{ number: number }>(
      await call("/repositories/rp/pull-requests", "POST", "writer", {
        title: "Feature",
        baseRef: "main",
        headRef: "topic",
      }),
      201
    );
    const head = "2".repeat(40);
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/reviews`, "POST", "owner", {
        state: "approved",
        body: "LGTM",
        commitOid: head,
      }),
      201
    );
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/checks`, "POST", "owner", {
        name: "unit",
        commitOid: head,
        status: "completed",
        conclusion: "failure",
      }),
      201
    );
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/checks`, "POST", "owner", {
        name: "unit",
        commitOid: head,
        status: "completed",
        conclusion: "success",
      }),
      200
    );
    await json(
      await call(`/repositories/rp/pull-requests/${request.number}/merge`, "POST", "owner", {
        expectedBaseOid: "1".repeat(40),
        expectedHeadOid: head,
      }),
      200
    );
    while ((await drainWebhookDeliveries(forgeEnv)) > 0);
    const events = sent.map(
      (item) => `${item.headers.get("X-GitEdge-Event")}:${JSON.parse(item.body).action}`
    );
    expect(events.sort()).toEqual(
      [
        "pull_request:opened",
        "pull_request_review:submitted",
        "check_run:completed",
        "check_run:completed",
        "pull_request:closed",
      ].sort()
    );
    const closed = sent.find((item) => JSON.parse(item.body).action === "closed");
    expect(JSON.parse(closed?.body ?? "{}").pull_request).toMatchObject({
      merged: true,
      state: "closed",
    });
    expect((await deliveries(hook.id)).every((item) => item.status === "success")).toBe(true);
  });

  it("does not queue anything when the sibling write is rejected", async () => {
    const hook = await createHook(["check_run"]);
    const request = await json<{ number: number }>(
      await call("/repositories/rp/pull-requests", "POST", "owner", {
        title: "Regress",
        baseRef: "main",
        headRef: "topic",
      }),
      201
    );
    const checks = `/repositories/rp/pull-requests/${request.number}/checks`;
    const head = "2".repeat(40);
    await json(
      await call(checks, "POST", "owner", {
        name: "lint",
        commitOid: head,
        status: "completed",
        conclusion: "success",
      }),
      201
    );
    expect(
      (
        await call(checks, "POST", "owner", {
          name: "lint",
          commitOid: head,
          status: "in_progress",
        })
      ).status
    ).toBe(409);
    expect(await deliveries(hook.id)).toHaveLength(1);
  });

  it("schedules bounded retries with exponential backoff", async () => {
    respondWith = () => 500;
    const hook = await createHook();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Flaky", body: "" });
    const base = Date.now();
    const delays = [60_000, 120_000, 240_000, 480_000];
    let clock = base;
    for (const [index, delay] of delays.entries()) {
      expect(await drainWebhookDeliveries(forgeEnv, clock)).toBe(1);
      const [current] = await deliveries(hook.id);
      expect(current).toMatchObject({
        status: "pending",
        attemptCount: index + 1,
        responseStatus: 500,
        errorCode: "http_error",
      });
      expect(current.nextAttemptAt).toBe(clock + delay);
      expect(await drainWebhookDeliveries(forgeEnv, clock + delay - 1)).toBe(0);
      clock += delay;
    }
    expect(sent).toHaveLength(4);
    expect(await drainWebhookDeliveries(forgeEnv, clock)).toBe(1);
    const [final] = await deliveries(hook.id);
    expect(final).toMatchObject({ status: "failed", attemptCount: 5, nextAttemptAt: null });
    expect(await drainWebhookDeliveries(forgeEnv, clock + 3_600_000)).toBe(0);
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((item) => item.headers.get("X-GitEdge-Delivery"))).size).toBe(1);
    expect(new Set(sent.map((item) => item.body)).size).toBe(1);
  });

  it("recovers a delivery whose worker stopped mid-attempt and stops at the limit", async () => {
    respondWith = () => 204;
    const hook = await createHook();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Crash", body: "" });
    await env.DB.prepare(
      "UPDATE forge_webhook_deliveries SET status = 'processing', attempt_count = 5, lease_until = 1 WHERE webhook_id = ?"
    )
      .bind(hook.id)
      .run();
    await drainWebhookDeliveries(forgeEnv);
    expect(sent).toHaveLength(0);
    expect(await deliveries(hook.id)).toMatchObject([
      { status: "failed", errorCode: "attempt_limit" },
    ]);
  });

  it("redelivers a finished delivery as a new record and tests with ping", async () => {
    respondWith = () => 500;
    const hook = await createHook();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Again", body: "" });
    await drainWebhookDeliveries(forgeEnv);
    const [pending] = await deliveries(hook.id);
    expect(
      (
        await call(
          `/repositories/rp/webhooks/${hook.id}/deliveries/${pending.id}/redeliveries`,
          "POST",
          "owner"
        )
      ).status
    ).toBe(409);
    await env.DB.prepare("UPDATE forge_webhook_deliveries SET status = 'failed' WHERE id = ?")
      .bind(pending.id)
      .run();
    respondWith = () => 204;
    const redelivered = await json<RepositoryWebhookDelivery>(
      await call(
        `/repositories/rp/webhooks/${hook.id}/deliveries/${pending.id}/redeliveries`,
        "POST",
        "owner"
      ),
      201
    );
    expect(redelivered).toMatchObject({
      status: "success",
      redeliveryOf: pending.id,
      attemptCount: 1,
    });
    expect(redelivered.id).not.toBe(pending.id);
    expect(sent.at(-1)?.body).toBe(sent[0].body);

    const ping = await json<RepositoryWebhookDelivery>(
      await call(`/repositories/rp/webhooks/${hook.id}/ping`, "POST", "owner"),
      200
    );
    expect(ping).toMatchObject({ event: "ping", status: "success" });
    expect(sent.at(-1)?.headers.get("X-GitEdge-Event")).toBe("ping");
    respondWith = () => 500;
    expect((await call(`/repositories/rp/webhooks/${hook.id}/ping`, "POST", "owner")).status).toBe(
      502
    );

    const detail = await json<{ payload: unknown }>(
      await call(`/repositories/rp/webhooks/${hook.id}/deliveries/${pending.id}`, "GET", "owner"),
      200
    );
    expect(detail.payload).toMatchObject({ action: "opened" });
    expect(
      (await call(`/repositories/rp/webhooks/${hook.id}/deliveries/nope`, "GET", "owner")).status
    ).toBe(404);
  });

  it("drops queued deliveries when the webhook is disabled or deleted", async () => {
    const hook = await createHook();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Disabled", body: "" });
    await json(
      await call(`/repositories/rp/webhooks/${hook.id}`, "PATCH", "owner", { active: false }),
      200
    );
    await drainWebhookDeliveries(forgeEnv);
    expect(sent).toEqual([]);
    expect(await deliveries(hook.id)).toMatchObject([
      { status: "failed", errorCode: "webhook_inactive" },
    ]);
    expect((await call(`/repositories/rp/webhooks/${hook.id}`, "DELETE", "owner")).status).toBe(
      200
    );
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM forge_webhook_deliveries"
    ).first<{
      total: number;
    }>();
    expect(left?.total).toBe(0);
  });

  it("records a retry instead of failing when the secret cannot be decrypted", async () => {
    const hook = await createHook();
    const rotated = { WEBHOOK_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };
    const ping = await call(
      `/repositories/rp/webhooks/${hook.id}/ping`,
      "POST",
      "owner",
      undefined,
      {
        env: rotated,
      }
    );
    expect(ping.status).toBe(502);
    expect(await json<RepositoryWebhookDelivery>(ping)).toMatchObject({
      event: "ping",
      status: "pending",
      errorCode: "delivery_error",
      attemptCount: 1,
    });
    expect(sent).toEqual([]);
  });

  it("does not follow redirects", async () => {
    respondWith = () => 302;
    const hook = await createHook();
    await call("/repositories/rp/issues", "POST", "owner", { title: "Redirect", body: "" });
    await drainWebhookDeliveries(forgeEnv);
    expect(await deliveries(hook.id)).toMatchObject([
      { status: "pending", errorCode: "redirect_rejected", responseStatus: 302 },
    ]);
  });
});

describe("push events", () => {
  const push = (body: unknown, host = "forge.internal") =>
    forge.fetch(
      new Request(`https://${host}/internal/push-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      forgeEnv
    );
  const update = (index: number) => ({
    ref: `refs/heads/branch-${index}`,
    before: "0".repeat(40),
    after: index.toString(16).padStart(40, "a"),
  });

  it("only accepts reports from the internal Git service", async () => {
    expect(
      (
        await push(
          pushReport({ repositoryId: "rp", pusherId: "u-owner", updates: [update(1)] }),
          "forge.test"
        )
      ).status
    ).toBe(404);
    expect(
      (await push(pushReport({ repositoryId: "rp", pusherId: "u-owner", updates: [] }))).status
    ).toBe(400);
  });

  it("queues one delivery per ref update and reports truncation", async () => {
    const hook = await createHook(["push"]);
    const response = await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        updates: Array.from({ length: 25 }, (_, index) => update(index + 1)),
      })
    );
    expect(await json(response, 200)).toEqual({ queued: 20, truncated: true });
    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        updates: [{ ref: "refs/tags/v1", before: "b".repeat(40), after: "0".repeat(40) }],
      })
    );
    while ((await drainWebhookDeliveries(forgeEnv)) > 0);
    expect(sent).toHaveLength(21);
    const created = JSON.parse(sent[0].body);
    expect(created).toMatchObject({
      created: true,
      deleted: false,
      pusher: { name: "writer" },
      repository: { full_name: "owner/secret" },
    });
    expect(sent[0].headers.get("X-GitEdge-Event")).toBe("push");
    const deleted = sent
      .map((item) => JSON.parse(item.body))
      .find((item) => item.ref === "refs/tags/v1");
    expect(deleted).toMatchObject({ deleted: true, created: false });
    expect((await deliveries(hook.id)).length).toBeGreaterThan(0);
  });

  it("ignores repositories without push webhooks", async () => {
    const hook = await createHook(["issues"]);
    await push(pushReport({ repositoryId: "rp", pusherId: "u-owner", updates: [update(1)] }));
    expect(await deliveries(hook.id)).toEqual([]);
    expect(
      await json(
        await push(
          pushReport({ repositoryId: "missing", pusherId: "u-owner", updates: [update(1)] })
        ),
        200
      )
    ).toEqual({
      queued: 0,
    });
  });

  it("does not enqueue an ordinary push webhook twice for a repeated report", async () => {
    const hook = await createHook(["push"]);
    const event = pushReport({
      repositoryId: "rp",
      pusherId: "u-writer",
      updates: [{ ref: "refs/heads/replayed", before: "0".repeat(40), after: "8".repeat(40) }],
    });
    await push(event);
    await push(event);
    expect(await deliveries(hook.id)).toHaveLength(1);
  });

  it("fails closed when Git cannot verify the current ref or the report is stale", async () => {
    const hook = await createHook(["push"]);
    const report = pushReport({
      repositoryId: "rp",
      pusherId: "u-writer",
      updates: [update(1)],
    });
    failRefHeadLookup = true;
    expect((await push(report)).status).toBe(503);
    failRefHeadLookup = false;
    expect(
      (await push({ ...report, occurredAt: Date.now() - 24 * 60 * 60 * 1_000 - 1 })).status
    ).toBe(400);
    expect(await deliveries(hook.id)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_push_event_refs").first()
    ).toEqual({ count: 0 });
  });

  it("accepts the actual head when reports arrive out of order", async () => {
    await createHeadUpdateFixtures();
    const hook = await createHook(["push", "pull_request"]);
    const ref = "refs/heads/local-head";
    const older = "a".repeat(40);
    const current = "b".repeat(40);
    const previous = "c".repeat(40);
    actualHeads.set(refHeadKey("rp", undefined, ref), current);
    await env.DB.prepare(
      "INSERT INTO forge_ref_pushers(repository_id,session_id,ref,oid,pusher_id,actor_json,updated_at) VALUES('rp','','refs/heads/local-head',?,'u-owner',?,1)"
    )
      .bind(previous, JSON.stringify({ kind: "user", id: "u-owner", name: "owner" }))
      .run();

    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        updates: [{ ref, before: older, after: current }],
      })
    );
    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-owner",
        updates: [{ ref, before: previous, after: older }],
      })
    );

    expect(
      await env.DB.prepare(
        "SELECT oid,pusher_id AS pusherId FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='' AND ref=?"
      )
        .bind(ref)
        .first()
    ).toEqual({ oid: current, pusherId: "u-writer" });
    expect(
      await env.DB.prepare(
        "SELECT previous_oid AS beforeOid,new_oid AS afterOid FROM forge_pull_head_updates WHERE pull_request_id='pr-branch'"
      ).first()
    ).toEqual({ beforeOid: older, afterOid: current });
    const events = await env.DB.prepare(
      "SELECT event,action,payload FROM forge_webhook_deliveries ORDER BY event,action"
    ).all<{ event: string; action: string | null; payload: string }>();
    expect(events.results.filter((row) => row.event === "push")).toHaveLength(1);
    const pullEvent = events.results.find((row) => row.event === "pull_request");
    expect(pullEvent?.action).toBe("synchronize");
    expect(JSON.parse(pullEvent!.payload)).toMatchObject({
      pull_request: { head: { sha: current } },
    });
  });

  it("preserves independent approval when a late report targets a restored OID", async () => {
    await createHeadUpdateFixtures();
    const ref = "refs/heads/local-head";
    const restored = "2".repeat(40);
    const intermediate = "d".repeat(40);
    const occurredAt = Date.now() - 10_000;
    for (const [before, after, pusherId, offset] of [
      [restored, intermediate, "u-owner", 1],
      [intermediate, restored, "u-writer", 2],
      ["a".repeat(40), restored, "u-owner", 0],
    ] as const) {
      actualHeads.set(refHeadKey("rp", undefined, ref), after);
      expect(
        (
          await push(
            pushReport(
              { repositoryId: "rp", pusherId, updates: [{ ref, before, after }] },
              crypto.randomUUID(),
              occurredAt + offset
            )
          )
        ).status
      ).toBe(200);
    }
    expect(
      (
        await call("/repositories/rp/branch-rules", "POST", "owner", {
          pattern: "main",
          requiredApprovals: 1,
          requireIndependentApproval: true,
        })
      ).status
    ).toBe(201);
    expect(
      (
        await call("/repositories/rp/pull-requests/1/reviews", "POST", "writer", {
          state: "approved",
          commitOid: restored,
        })
      ).status
    ).toBe(201);
    const result = await call(
      `/repositories/rp/pull-requests/1/merge-requirements?headOid=${restored}`,
      "GET",
      "owner"
    );
    expect(result.status).toBe(200);
    const parsed = z.object({ data: MergeRequirementsSchema }).parse(await result.json()).data;
    expect(parsed.requirements.find((entry) => entry.id === "approvals")).toMatchObject({
      status: "unsatisfied",
      actualCount: 0,
    });
    expect(parsed.excludedApprovals).toContainEqual({ name: "writer", reason: "last_pusher" });
    expect(
      (
        await push(
          pushReport(
            {
              repositoryId: "rp",
              pusherId: "u-owner",
              updates: [{ ref, before: intermediate, after: restored }],
            },
            crypto.randomUUID(),
            occurredAt + 2
          )
        )
      ).status
    ).toBe(200);
    const ambiguous = await call(
      `/repositories/rp/pull-requests/1/merge-requirements?headOid=${restored}`,
      "GET",
      "owner"
    );
    const ambiguousResult = z
      .object({ data: MergeRequirementsSchema })
      .parse(await ambiguous.json()).data;
    expect(ambiguousResult.requirements.find((entry) => entry.id === "approvals")).toMatchObject({
      status: "unsatisfied",
      blockerCode: "independent_approval_unverified",
    });
  });

  it("rejects a ref snapshot that changed while Git was checking the head", async () => {
    await createHeadUpdateFixtures();
    const ref = "refs/heads/local-head";
    const first = "a".repeat(40);
    const newer = "b".repeat(40);
    actualHeads.set(refHeadKey("rp", undefined, ref), first);
    beforeRefHeadResponse = async () => {
      actualHeads.set(refHeadKey("rp", undefined, ref), newer);
      const response = await push(
        pushReport({
          repositoryId: "rp",
          pusherId: "u-writer",
          updates: [{ ref, before: "0".repeat(40), after: newer }],
        })
      );
      expect(response.status).toBe(200);
    };

    const stale = pushReport({
      repositoryId: "rp",
      pusherId: "u-owner",
      updates: [{ ref, before: "0".repeat(40), after: first }],
    });
    expect((await push(stale)).status).toBe(503);
    expect((await push(stale)).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT oid,pusher_id AS pusherId,last_event_id AS eventId FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='' AND ref=?"
      )
        .bind(ref)
        .first()
    ).toEqual({ oid: newer, pusherId: "u-writer", eventId: expect.any(String) });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_push_event_refs WHERE ref=?")
        .bind(ref)
        .first()
    ).toEqual({ count: 1 });
  });

  it("announces deletion of a published head and clears its latest pusher", async () => {
    await createHeadUpdateFixtures();
    await createHook(["pull_request"]);
    const ref = "refs/heads/local-head";
    const before = "9".repeat(40);
    await env.DB.prepare(
      "INSERT INTO forge_ref_pushers(repository_id,session_id,ref,oid,pusher_id,actor_json,updated_at,last_event_id) VALUES('rp','','refs/heads/local-head',?,'u-owner',?,1,'seed-event')"
    )
      .bind(before, JSON.stringify({ kind: "user", id: "u-owner", name: "owner" }))
      .run();
    actualHeads.set(refHeadKey("rp", undefined, ref), null);

    const deletion = pushReport({
      repositoryId: "rp",
      pusherId: "u-writer",
      updates: [{ ref, before, after: "0".repeat(40) }],
    });
    await push(deletion);
    await push(deletion);

    expect(
      await env.DB.prepare(
        "SELECT source,previous_oid AS beforeOid,new_oid AS afterOid FROM forge_pull_head_updates WHERE pull_request_id='pr-branch'"
      ).first()
    ).toEqual({ source: "branch", beforeOid: before, afterOid: "0".repeat(40) });
    expect(
      await env.DB.prepare(
        "SELECT oid,pusher_id AS pusherId,last_event_id AS eventId FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='' AND ref=?"
      )
        .bind(ref)
        .first()
    ).toEqual({ oid: "0".repeat(40), pusherId: "u-writer", eventId: deletion.eventId });
    const delivery = await env.DB.prepare(
      "SELECT action,payload FROM forge_webhook_deliveries WHERE event='pull_request'"
    ).first<{ action: string; payload: string }>();
    expect(delivery?.action).toBe("synchronize");
    expect(JSON.parse(delivery!.payload)).toMatchObject({
      before,
      after: "0".repeat(40),
      pull_request: { head: { sha: "0".repeat(40) } },
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM forge_pull_head_updates WHERE pull_request_id='pr-branch'"
      ).first()
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_webhook_deliveries").first()
    ).toEqual({ count: 1 });
  });

  it("records the reported time and before/after OIDs on the PR update", async () => {
    await createHeadUpdateFixtures();
    await createHook(["pull_request"]);
    const occurredAt = Date.now() - 1_000;
    const before = "1".repeat(40);
    const after = "2".repeat(40);
    const response = await push(
      pushReport(
        {
          repositoryId: "rp",
          pusherId: "u-writer",
          updates: [{ ref: "refs/heads/local-head", before, after }],
        },
        crypto.randomUUID(),
        occurredAt
      )
    );
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT updated_at AS updatedAt FROM forge_pull_requests WHERE id='pr-branch'"
      ).first()
    ).toEqual({ updatedAt: occurredAt });
    const delivery = await env.DB.prepare(
      "SELECT payload FROM forge_webhook_deliveries WHERE event='pull_request'"
    ).first<{ payload: string }>();
    expect(JSON.parse(delivery!.payload)).toMatchObject({
      before,
      after,
      pull_request: { head: { sha: after } },
    });
  });

  async function createHeadUpdateFixtures(): Promise<void> {
    await env.DB.batch([
      env.DB.prepare("UPDATE repositories SET agents_enabled = 1 WHERE id = 'rp'"),
      env.DB.prepare(
        "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at,artifact_name,remote,fork_of) VALUES('fork-rp','ns','u-writer','fork','do-fork','private','',1,1,'art-fork','artifact://art-fork','rp')"
      ),
      env.DB.prepare(
        "INSERT INTO repository_collaborators(repository_id,user_id,role,created_at) VALUES('fork-rp','u-writer','admin',1)"
      ),
      env.DB.prepare(
        "INSERT INTO auth_agents(id,user_id,name,description,created_at,handle,delivery_mode) VALUES('agent-writer','u-writer','Writer Agent','',1,'writer-agent','pull'),('agent-reviewer','u-writer','Reviewer Agent','',1,'reviewer-agent','pull')"
      ),
      env.DB.prepare(
        "INSERT INTO forge_assignments(id,repository_id,target_kind,target_id,role,assignee_kind,assignee_id,assigned_by,created_at) VALUES('head-reviewer','rp','pull_request','pr-session','reviewer','agent','agent-reviewer','u-writer',1)"
      ),
      env.DB.prepare(
        "INSERT INTO auth_git_tokens(id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES('git-token','u-writer','rp','Agent session','git-token-hash','write',9999999999999,1)"
      ),
      env.DB.prepare(
        "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES('session-writer','agent-writer','u-writer','rp','hash','git-token','writer-workspace','artifact://session','main',NULL,'write','active',1,9999999999999)"
      ),
      ...[
        ["pr-branch", "rp", 1, "local-head", null, null],
        ["pr-fork", "rp", 2, "fork-head", null, "fork-rp"],
        ["pr-session", "rp", 3, "session-head", "session-writer", null],
      ].map(([id, repositoryId, number, headRef, sessionId, forkId]) =>
        env.DB.prepare(
          "INSERT INTO forge_pull_requests(id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,head_repository_id,draft,state,created_at,updated_at) VALUES(?,?,?,'u-owner','{}','Head update','', 'main',?,?,?,0,'open',1,1)"
        ).bind(id, repositoryId, number, headRef, sessionId, forkId)
      ),
    ]);
  }

  it("announces only matching published branch, fork and session PR heads", async () => {
    await createHeadUpdateFixtures();
    const hook = await createHook(["pull_request", "push"]);
    const updates = [
      { ref: "refs/heads/local-head", before: "0".repeat(40), after: "1".repeat(40) },
      { ref: "refs/heads/fork-head", before: "0".repeat(40), after: "2".repeat(40) },
      { ref: "refs/heads/session-head", before: "0".repeat(40), after: "3".repeat(40) },
    ];
    for (const [repositoryId, update, agentSessionId] of [
      ["rp", updates[0], undefined],
      ["fork-rp", updates[1], undefined],
      ["rp", updates[2], "session-writer"],
    ] as const) {
      const response = await push(
        pushReport({
          repositoryId,
          pusherId: "u-writer",
          ...(agentSessionId ? { agentSessionId } : {}),
          updates: [update!],
        })
      );
      expect(response.status).toBe(200);
    }

    const history = await env.DB.prepare(
      "SELECT pull_request_id AS pullRequestId, source, previous_oid AS previousOid, new_oid AS newOid FROM forge_pull_head_updates ORDER BY pull_request_id"
    ).all();
    expect(history.results).toEqual([
      {
        pullRequestId: "pr-branch",
        source: "branch",
        previousOid: "0".repeat(40),
        newOid: "1".repeat(40),
      },
      {
        pullRequestId: "pr-fork",
        source: "fork",
        previousOid: "0".repeat(40),
        newOid: "2".repeat(40),
      },
      {
        pullRequestId: "pr-session",
        source: "session",
        previousOid: "0".repeat(40),
        newOid: "3".repeat(40),
      },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT pusher_id AS pusherId, actor_json AS actor FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='session-writer' AND ref='refs/heads/session-head'"
      ).first()
    ).toEqual({
      pusherId: "u-writer",
      actor: JSON.stringify({
        kind: "agent",
        id: "agent-writer",
        name: "Writer Agent",
        sessionId: "session-writer",
      }),
    });
    const hooks = await env.DB.prepare(
      "SELECT action, payload FROM forge_webhook_deliveries WHERE event='pull_request' ORDER BY created_at, id"
    ).all<{ action: string; payload: string }>();
    expect(hooks.results).toHaveLength(3);
    expect(
      hooks.results
        .map((row) => JSON.parse(row.payload))
        .some(
          (payload) =>
            payload.action === "synchronize" && payload.pull_request.head.sha === "3".repeat(40)
        )
    ).toBe(true);
    const agentEvents = await env.DB.prepare(
      "SELECT agent_id AS agentId,event,payload FROM forge_agent_events"
    ).all<{ agentId: string; event: string; payload: string }>();
    expect(agentEvents.results).toHaveLength(1);
    expect(agentEvents.results[0]!.agentId).toBe("agent-reviewer");
    expect(agentEvents.results[0]!.event).toBe("pull_request.head_updated");
    expect(JSON.parse(agentEvents.results[0]!.payload)).toMatchObject({
      action: "synchronize",
      before: "0".repeat(40),
      after: "3".repeat(40),
    });
    expect(
      await env.DB.prepare(
        "SELECT reason FROM forge_notifications WHERE recipient_id='u-owner' AND subject_id='pr-session'"
      ).first()
    ).toEqual({ reason: "review_requested" });
  });

  it("matches fork-local and upstream PRs by the published head repository", async () => {
    await createHeadUpdateFixtures();
    await createHook(["pull_request"]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO forge_webhooks(id,repository_id,url,events_json,active,secret_ciphertext,secret_iv,created_by,created_at,updated_at) VALUES('fork-hook','fork-rp','https://hooks.example.com/receive','[\"pull_request\"]',1,'ciphertext','iv','u-writer',1,1)"
      ),
      env.DB.prepare(
        "INSERT INTO forge_pull_requests(id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,head_repository_id,draft,state,created_at,updated_at) VALUES('pr-fork-local','fork-rp',4,'u-owner','{}','Fork local','', 'main','shared-head',NULL,NULL,0,'open',1,1)"
      ),
      env.DB.prepare(
        "INSERT INTO forge_pull_requests(id,repository_id,number,author_id,actor_json,title,body,base_ref,head_ref,head_session_id,head_repository_id,draft,state,created_at,updated_at) VALUES('pr-unrelated','rp',5,'u-owner','{}','Unrelated','', 'main','shared-head',NULL,NULL,0,'open',1,1)"
      ),
      env.DB.prepare(
        "UPDATE forge_pull_requests SET head_ref = 'shared-head' WHERE id = 'pr-fork'"
      ),
    ]);

    const response = await push(
      pushReport({
        repositoryId: "fork-rp",
        pusherId: "u-writer",
        updates: [{ ref: "refs/heads/shared-head", before: "0".repeat(40), after: "5".repeat(40) }],
      })
    );
    expect(response.status).toBe(200);
    const history = await env.DB.prepare(
      "SELECT pull_request_id AS pullRequestId,source FROM forge_pull_head_updates ORDER BY pull_request_id"
    ).all();
    expect(history.results).toEqual([
      { pullRequestId: "pr-fork", source: "fork" },
      { pullRequestId: "pr-fork-local", source: "branch" },
    ]);
    const deliveries = await env.DB.prepare(
      "SELECT repository_id AS repositoryId,payload FROM forge_webhook_deliveries WHERE event='pull_request'"
    ).all<{ repositoryId: string; payload: string }>();
    expect(deliveries.results).toHaveLength(2);
    expect(
      deliveries.results
        .map((row) => [row.repositoryId, JSON.parse(row.payload).pull_request.number])
        .sort()
    ).toEqual([
      ["fork-rp", 4],
      ["rp", 2],
    ]);
  });

  it("hides unpublished session refs, rejects invalid sessions and deduplicates unchanged heads", async () => {
    await createHeadUpdateFixtures();
    const hook = await createHook(["pull_request", "push"]);
    const unpublished = {
      ref: "refs/heads/private-work",
      before: "0".repeat(40),
      after: "4".repeat(40),
    };
    const privatePush = await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        agentSessionId: "session-writer",
        updates: [unpublished],
      })
    );
    expect(privatePush.status).toBe(200);
    expect(await deliveries(hook.id)).toEqual([]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_pull_head_updates").first()
    ).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_ref_pushers").first()).toEqual(
      { count: 1 }
    );

    for (const invalid of [
      "missing",
      "session-completed",
      "session-expired",
      "session-revoked",
      "session-token-expired",
      "session-token-revoked",
    ]) {
      if (invalid !== "missing") {
        await env.DB.prepare(
          "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES(?, 'agent-writer','u-writer','rp',?,?,?,'artifact://session','main',NULL,'write',?,1,?)"
        )
          .bind(
            invalid,
            `hash-${invalid}`,
            `git-token-${invalid}`,
            `workspace-${invalid}`,
            invalid === "session-revoked"
              ? "revoked"
              : invalid === "session-completed"
                ? "completed"
                : "active",
            invalid === "session-expired" ? 2 : 9999999999999
          )
          .run();
        await env.DB.prepare(
          "INSERT INTO auth_git_tokens(id,user_id,repository_id,name,token_hash,permission,expires_at,created_at,revoked_at) VALUES(?,?,?,'Agent session',?,'write',?,1,?)"
        )
          .bind(
            `git-token-${invalid}`,
            "u-writer",
            "rp",
            `git-token-hash-${invalid}`,
            invalid === "session-token-expired" ? 2 : 9999999999999,
            invalid === "session-token-revoked" ? 2 : null
          )
          .run();
      }
      const rejected = await push(
        pushReport({
          repositoryId: "rp",
          pusherId: "u-writer",
          agentSessionId: invalid,
          updates: [{ ...unpublished, ref: `refs/heads/${invalid}` }],
        })
      );
      expect(rejected.status).toBe(403);
    }
    expect(
      (
        await push(
          pushReport({
            repositoryId: "rp",
            pusherId: "u-owner",
            agentSessionId: "session-writer",
            updates: [{ ...unpublished, ref: "refs/heads/wrong-owner" }],
          })
        )
      ).status
    ).toBe(403);
    await env.DB.prepare("UPDATE auth_agents SET disabled_at=2 WHERE id='agent-writer'").run();
    expect(
      (
        await push(
          pushReport({
            repositoryId: "rp",
            pusherId: "u-writer",
            agentSessionId: "session-writer",
            updates: [{ ...unpublished, ref: "refs/heads/disabled-agent" }],
          })
        )
      ).status
    ).toBe(403);
    await env.DB.prepare("UPDATE auth_agents SET disabled_at=NULL WHERE id='agent-writer'").run();
    await env.DB.prepare("UPDATE users SET disabled_at=2 WHERE id='u-writer'").run();
    expect(
      (
        await push(
          pushReport({
            repositoryId: "rp",
            pusherId: "u-writer",
            agentSessionId: "session-writer",
            updates: [{ ...unpublished, ref: "refs/heads/disabled-owner" }],
          })
        )
      ).status
    ).toBe(403);
    await env.DB.prepare("UPDATE users SET disabled_at=NULL WHERE id='u-writer'").run();

    const published = {
      ref: "refs/heads/session-head",
      before: "0".repeat(40),
      after: "5".repeat(40),
    };
    const publishedEvent = pushReport({
      repositoryId: "rp",
      pusherId: "u-writer",
      agentSessionId: "session-writer",
      updates: [published],
    });
    await push(publishedEvent);
    await push(publishedEvent);
    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        agentSessionId: "session-writer",
        updates: [{ ...published, before: published.after }],
      })
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM forge_pull_head_updates WHERE pull_request_id='pr-session'"
      ).first()
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_webhook_deliveries").first()
    ).toEqual({ count: 1 });

    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-writer",
        agentSessionId: "session-writer",
        updates: [{ ...published, before: published.after, after: "0".repeat(40) }],
      })
    );
    expect(
      await env.DB.prepare(
        "SELECT oid FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='session-writer' AND ref=?"
      )
        .bind(published.ref)
        .first()
    ).toEqual({ oid: "0".repeat(40) });

    const old = { ref: "refs/heads/pusher-check", before: "0".repeat(40), after: "6".repeat(40) };
    await push(pushReport({ repositoryId: "rp", pusherId: "u-writer", updates: [old] }));
    await push(
      pushReport({
        repositoryId: "rp",
        pusherId: "u-owner",
        updates: [{ ref: old.ref, before: old.after, after: "7".repeat(40) }],
      })
    );
    actualHeads.set(refHeadKey("rp", undefined, old.ref), "7".repeat(40));
    await push(pushReport({ repositoryId: "rp", pusherId: "u-writer", updates: [old] }));
    expect(
      await env.DB.prepare(
        "SELECT oid, pusher_id AS pusherId FROM forge_ref_pushers WHERE repository_id='rp' AND session_id='' AND ref=?"
      )
        .bind(old.ref)
        .first()
    ).toEqual({ oid: "7".repeat(40), pusherId: "u-owner" });
  });
});

describe("webhook audit", () => {
  it("records creation and deletion with the host only", async () => {
    const hook = await json<SavedRepositoryWebhook>(
      await call("/repositories/rp/webhooks", "POST", "owner", {
        url: "https://hooks.example.com/services/T000/very-secret-path",
        events: ["push", "release"],
      }),
      201
    );
    expect((await call(`/repositories/rp/webhooks/${hook.id}`, "DELETE", "owner")).status).toBe(
      200
    );
    const rows = await env.DB.prepare(
      "SELECT action, actor_name AS actor, target_label AS label, metadata_json AS metadata FROM audit_events WHERE repository_id = 'rp' AND target_id = ? ORDER BY created_at, action"
    )
      .bind(hook.id)
      .all<{ action: string; actor: string; label: string; metadata: string }>();
    expect(rows.results.map((row) => [row.action, row.actor, row.label])).toEqual([
      ["repository_webhook.created", "owner", "hooks.example.com"],
      ["repository_webhook.deleted", "owner", "hooks.example.com"],
    ]);
    expect(JSON.parse(rows.results[0].metadata)).toEqual({
      host: "hooks.example.com",
      events: ["push", "release"],
      active: true,
    });
    expect(JSON.stringify(rows.results)).not.toContain("very-secret-path");
  });
});
