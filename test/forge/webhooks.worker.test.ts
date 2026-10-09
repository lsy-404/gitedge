import { env } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import forge from "../../workers/forge/src/index";
import { drainWebhookDeliveries } from "../../workers/forge/src/webhooks";
import type {
  RepositoryWebhook,
  RepositoryWebhookDelivery,
  SavedRepositoryWebhook,
  TrustedUser,
} from "../../packages/contracts/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  WEBHOOK_ENCRYPTION_KEY: ENCRYPTION_KEY,
  GIT: { fetch: async () => Response.json({ data: { oid: "2".repeat(40) } }) },
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
  sent = [];
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
    for (const events of [[], ["release"], ["push", "push"]])
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
      (await push({ repositoryId: "rp", pusherId: "u-owner", updates: [update(1)] }, "forge.test"))
        .status
    ).toBe(404);
    expect((await push({ repositoryId: "rp", updates: [] })).status).toBe(400);
  });

  it("queues one delivery per ref update and reports truncation", async () => {
    const hook = await createHook(["push"]);
    const response = await push({
      repositoryId: "rp",
      pusherId: "u-writer",
      updates: Array.from({ length: 25 }, (_, index) => update(index + 1)),
    });
    expect(await json(response, 200)).toEqual({ queued: 20, truncated: true });
    await push({
      repositoryId: "rp",
      pusherId: "u-writer",
      updates: [{ ref: "refs/tags/v1", before: "b".repeat(40), after: "0".repeat(40) }],
    });
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
    await push({ repositoryId: "rp", pusherId: "u-owner", updates: [update(1)] });
    expect(await deliveries(hook.id)).toEqual([]);
    expect(
      await json(
        await push({ repositoryId: "missing", pusherId: "u-owner", updates: [update(1)] }),
        200
      )
    ).toEqual({
      queued: 0,
    });
  });
});
