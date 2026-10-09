import { unlimitedRateLimiter } from "../support/rate-limiter";
import { runSqlScript } from "../support/database";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSchema, sha256Hex, type Agent } from "../../packages/contracts/src/index";
import auth from "../../workers/auth/src/index";
import { drainAgentEventOutbox } from "../../workers/auth/src/agent-webhooks";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

async function applyMigrations(): Promise<void> {
  for (const path of Object.keys(migrations).sort()) {
    await runSqlScript(env.DB, migrations[path]);
    if (path.endsWith("0006_agents.sql")) {
      await env.DB.prepare(
        "INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind("legacy-agent-user", "legacy-agent-user", "salt", "hash", 1)
        .run();
      await env.DB.prepare(
        "INSERT INTO auth_agents (id, user_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind("legacy-agent", "legacy-agent-user", "Legacy Review Agent", "", 2)
        .run();
      await env.DB.prepare(
        "INSERT INTO auth_agents (id, user_id, name, description, created_at) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)"
      )
        .bind(
          "legacy-agent-collision-a",
          "legacy-agent-user",
          "a-b",
          "",
          3,
          "legacy-agent-collision-b",
          "legacy-agent-user",
          "A B",
          "",
          4,
          "legacy-agent-empty",
          "legacy-agent-user",
          "!!!",
          "",
          5
        )
        .run();
    }
  }
}

const artifacts = new FixtureArtifacts();
const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
  WEBHOOK_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

const CreatedSessionSchema = z.object({
  data: z.object({
    id: z.string(),
    agentId: z.string(),
    agentName: z.string(),
    repositoryId: z.string(),
    workspaceName: z.string(),
    remote: z.string(),
    baseRef: z.string(),
    baseOid: z.string().nullable(),
    permission: z.enum(["read", "write"]),
    status: z.literal("active"),
    createdAt: z.number(),
    expiresAt: z.number(),
    maxExpiresAt: z.number(),
    renewalCount: z.number(),
    token: z.string(),
    gitToken: z.string(),
    instructions: z.string().nullable(),
  }),
});
const CreatedGitTokenSchema = z.object({
  data: z.object({
    id: z.string(),
    token: z.string(),
    repositoryId: z.string(),
    name: z.string(),
    permission: z.enum(["read", "write"]),
    createdAt: z.number(),
    expiresAt: z.number(),
  }),
});

function cookieFrom(response: Response): string {
  const value = response.headers.get("Set-Cookie")?.match(/gitedge_session=([^;]+)/)?.[1];
  if (!value) throw new Error("Registration did not set a session cookie.");
  return `gitedge_session=${value}`;
}

function accountRequest(path: string, method: string, cookie: string, body?: unknown): Request {
  const headers = new Headers({ Cookie: cookie, Origin: "https://auth.test" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`https://auth.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function accountApi(
  path: string,
  method: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  return auth.fetch(accountRequest(path, method, cookie, body), authEnv);
}

beforeAll(async () => {
  await applyMigrations();
  const legacyAgent = await env.DB.prepare(
    "SELECT handle, profile_public AS profilePublic, updated_at AS updatedAt FROM auth_agents WHERE id = 'legacy-agent'"
  ).first<{ handle: string; profilePublic: number; updatedAt: number }>();
  expect(legacyAgent).toEqual({ handle: "legacy-review-agent-1", profilePublic: 0, updatedAt: 2 });
  const migratedHandles = await env.DB.prepare(
    "SELECT id, handle FROM auth_agents WHERE user_id = 'legacy-agent-user' ORDER BY created_at"
  ).all<{ id: string; handle: string }>();
  expect(migratedHandles.results.map(({ handle }) => handle)).toEqual([
    "legacy-review-agent-1",
    "a-b-2",
    "a-b-3",
    "agent-4",
  ]);
});

describe("Auth agents, Artifact sessions, and Git credentials", () => {
  it("owns registration, isolates two agents and sessions, revokes scoped tokens, and manages Git tokens", async () => {
    const registration = await auth.fetch(
      new Request("https://auth.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://auth.test" },
        body: JSON.stringify({ identifier: "FixtureUser", password: "a-long-test-password-2026" }),
      }),
      authEnv
    );
    expect(registration.status).toBe(201);
    const cookie = cookieFrom(registration);
    const user = await env.DB.prepare("SELECT id, identifier FROM users WHERE identifier = ?")
      .bind("fixtureuser")
      .first<{ id: string; identifier: string }>();
    expect(user).not.toBeNull();
    if (!user) throw new Error("Registered user row is missing.");

    const namespace = await env.DB.prepare(
      "SELECT namespaces.id, namespaces.created_by, namespace_memberships.role FROM namespaces JOIN namespace_memberships ON namespace_memberships.namespace_id = namespaces.id WHERE namespaces.slug = ? AND namespace_memberships.user_id = ?"
    )
      .bind(user.identifier, user.id)
      .first<{ id: string; created_by: string; role: string }>();
    expect(namespace).toEqual({ id: expect.any(String), created_by: user.id, role: "owner" });
    if (!namespace) throw new Error("Registration namespace is missing.");

    const source = await artifacts.create(`repo-${crypto.randomUUID()}`, {
      setDefaultBranch: "main",
      description: "Agent lifecycle fixture repository",
    });
    using sourceHandle = await artifacts.get(source.name);
    expect(await sourceHandle.revokeToken(source.token)).toBe(true);
    const repositoryId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?)"
    )
      .bind(
        repositoryId,
        namespace.id,
        user.id,
        "agent-source",
        `repo:${repositoryId}`,
        source.name,
        source.remote,
        source.defaultBranch,
        source.description ?? "",
        Date.now(),
        Date.now()
      )
      .run();

    const firstAgentResponse = await accountApi("/agents", "POST", cookie, {
      name: "Build assistant",
      description: "Runs repository builds",
    });
    const secondAgentResponse = await accountApi("/agents", "POST", cookie, {
      name: "Review assistant",
      description: "Reviews repository changes",
    });
    expect(firstAgentResponse.status).toBe(201);
    expect(secondAgentResponse.status).toBe(201);
    const agents = await env.DB.prepare(
      "SELECT id, name, description, created_at AS createdAt, disabled_at AS disabledAt FROM auth_agents WHERE user_id = ? ORDER BY name"
    )
      .bind(user.id)
      .all<Agent>();
    expect(agents.results.map((agent) => agent.name)).toEqual([
      "Build assistant",
      "Review assistant",
    ]);
    const buildAgent = agents.results[0];
    const reviewAgent = agents.results[1];
    if (!buildAgent || !reviewAgent) throw new Error("Both agents were not created.");

    const firstAgentPayload = z
      .object({ data: AgentSchema })
      .parse(await firstAgentResponse.json());
    const createdPath = firstAgentPayload.data.profilePath;
    expect(createdPath).toBe(`/${user.identifier}/@build-assistant`);
    const duplicateHandle = await accountApi("/agents", "POST", cookie, {
      handle: "build-assistant",
      name: "Another display name",
    });
    expect(duplicateHandle.status).toBe(409);
    const renamed = await accountApi(`/agents/${buildAgent.id}`, "PATCH", cookie, {
      handle: "builder-v2",
      name: "Builder",
      profilePublic: false,
    });
    expect(renamed.status).toBe(200);
    const renamedPayload = z.object({ data: AgentSchema }).parse(await renamed.json());
    expect(renamedPayload.data).toMatchObject({
      handle: "builder-v2",
      name: "Builder",
      profilePath: `/${user.identifier}/@builder-v2`,
    });
    const previousProfile = await auth.fetch(
      new Request(`https://auth.test/agent-profiles/${user.identifier}/build-assistant`),
      authEnv
    );
    expect(previousProfile.status).toBe(404);
    const privateProfile = await auth.fetch(
      new Request(`https://auth.test/agent-profiles/${user.identifier}/builder-v2`),
      authEnv
    );
    expect(privateProfile.status).toBe(404);
    const ownerProfile = await auth.fetch(
      accountRequest(`/agent-profiles/${user.identifier}/builder-v2`, "GET", cookie),
      authEnv
    );
    expect(ownerProfile.status).toBe(200);
    expect(await ownerProfile.json()).toMatchObject({
      data: { owner: user.identifier, handle: "builder-v2", name: "Builder" },
    });
    const secondRegistration = await auth.fetch(
      new Request("https://auth.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://auth.test" },
        body: JSON.stringify({
          identifier: `other-${crypto.randomUUID().slice(0, 8)}`,
          password: "a-long-test-password-2026",
        }),
      }),
      authEnv
    );
    const secondCookie = cookieFrom(secondRegistration);
    const foreignProfile = await auth.fetch(
      accountRequest(`/agent-profiles/${user.identifier}/builder-v2`, "GET", secondCookie),
      authEnv
    );
    expect(foreignProfile.status).toBe(404);
    const publicUpdate = await accountApi(`/agents/${buildAgent.id}`, "PATCH", cookie, {
      profilePublic: true,
    });
    expect(publicUpdate.status).toBe(200);
    const publicProfile = await auth.fetch(
      new Request(`https://auth.test/agent-profiles/${user.identifier}/builder-v2`),
      authEnv
    );
    expect(publicProfile.status).toBe(200);
    expect(await publicProfile.json()).toMatchObject({
      data: { owner: user.identifier, handle: "builder-v2", name: "Builder" },
    });
    await accountApi(`/agents/${buildAgent.id}`, "PATCH", cookie, { profilePublic: false });

    let webhookFetches = 0;
    let capturedSignature = "";
    let capturedBody = "";
    let largeBodyCancelled = false;
    const webhookDeliveryIds: string[] = [];
    const pendingBeforeFetch: boolean[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      webhookFetches += 1;
      const headers = new Headers(init?.headers);
      capturedSignature = headers.get("X-GitEdge-Signature-256") ?? "";
      capturedBody = String(init?.body ?? "");
      const deliveryId = headers.get("GitEdge-Delivery") ?? "";
      webhookDeliveryIds.push(deliveryId);
      const recorded = await env.DB.prepare(
        "SELECT status FROM auth_agent_webhook_deliveries WHERE id = ?"
      )
        .bind(deliveryId)
        .first<{ status: string }>();
      pendingBeforeFetch.push(recorded?.status === "pending");
      if (webhookFetches === 3) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(4_097));
            },
            cancel() {
              largeBodyCancelled = true;
            },
          }),
          { status: 200 }
        );
      }
      return new Response(null, { status: webhookFetches === 1 ? 500 : 204 });
    });
    try {
      const noKeyEnv = { ...authEnv, WEBHOOK_ENCRYPTION_KEY: undefined };
      const noKeyResponse = await auth.fetch(
        accountRequest(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
          url: "https://hooks.example.com/gitedge",
          events: ["agent.assigned"],
          enabled: true,
        }),
        noKeyEnv
      );
      expect(noKeyResponse.status).toBe(503);
      const settings = await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://hooks.example.com/gitedge",
        events: ["agent.assigned"],
        enabled: true,
      });
      expect(settings.status).toBe(201);
      const settingsPayload = z
        .object({ data: z.object({ secret: z.string() }) })
        .parse(await settings.json());
      const webhookSecret = settingsPayload.data.secret;
      expect(webhookSecret).toMatch(/^ge_webhook_[0-9a-f]{64}$/);
      const encrypted = await env.DB.prepare(
        "SELECT secret_ciphertext FROM auth_agent_webhooks WHERE agent_id = ?"
      )
        .bind(buildAgent.id)
        .first<{ secret_ciphertext: string }>();
      expect(encrypted?.secret_ciphertext).not.toContain(webhookSecret);
      const getSettings = await accountApi(`/agents/${buildAgent.id}/webhook`, "GET", cookie);
      expect(JSON.stringify(await getSettings.json())).not.toContain(webhookSecret);

      const rejectedInternalHost = await auth.fetch(
        new Request("https://auth.test/_internal/agent-events", {
          method: "POST",
          body: JSON.stringify({
            agentId: buildAgent.id,
            repositoryId,
            actorUserId: user.id,
            event: "agent.assigned",
            data: { action: "assigned" },
          }),
        }),
        authEnv
      );
      expect(rejectedInternalHost.status).toBe(404);
      const queuedEvent = await auth.fetch(
        new Request("https://auth.internal/_internal/agent-events", {
          method: "POST",
          body: JSON.stringify({
            agentId: buildAgent.id,
            repositoryId,
            actorUserId: user.id,
            event: "agent.assigned",
            data: { action: "assigned" },
          }),
        }),
        authEnv
      );
      expect(queuedEvent.status).toBe(202);
      expect(webhookFetches).toBe(0);
      await drainAgentEventOutbox(authEnv);
      expect(webhookFetches).toBe(1);
      expect(pendingBeforeFetch[0]).toBe(true);
      const deliveries = await accountApi(
        `/agents/${buildAgent.id}/webhook/deliveries`,
        "GET",
        cookie
      );
      const deliveryPayload = z
        .object({
          data: z.array(z.object({ id: z.string(), status: z.string(), attemptCount: z.number() })),
        })
        .parse(await deliveries.json());
      expect(deliveryPayload.data[0]).toMatchObject({ status: "failed", attemptCount: 1 });
      const expectedKey = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const expectedSignatureBytes = new Uint8Array(
        await crypto.subtle.sign("HMAC", expectedKey, new TextEncoder().encode(capturedBody))
      );
      const expectedSignature = Array.from(expectedSignatureBytes, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      expect(capturedSignature).toBe(`sha256=${expectedSignature}`);
      const retried = await accountApi(
        `/agents/${buildAgent.id}/webhook/deliveries/${deliveryPayload.data[0]?.id}/retry`,
        "POST",
        cookie,
        {}
      );
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ data: { status: "success", attemptCount: 2 } });
      expect(webhookDeliveryIds.slice(0, 2)).toHaveLength(2);
      expect(webhookDeliveryIds[0]).toBe(webhookDeliveryIds[1]);
      await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://hooks.example.com/gitedge",
        events: ["agent.assigned"],
        enabled: false,
      });
      const countBeforeDisabled = webhookFetches;
      await auth.fetch(
        new Request("https://auth.internal/_internal/agent-events", {
          method: "POST",
          body: JSON.stringify({
            agentId: buildAgent.id,
            repositoryId,
            actorUserId: user.id,
            event: "agent.assigned",
            data: { action: "assigned" },
          }),
        }),
        authEnv
      );
      expect(webhookFetches).toBe(countBeforeDisabled);
      const unsafeUrl = await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://127.0.0.1/hook",
        events: ["agent.assigned"],
        enabled: true,
      });
      expect(unsafeUrl.status).toBe(400);
      await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://hooks.example.com/gitedge",
        events: ["agent.assigned"],
        enabled: true,
      });
      await auth.fetch(
        new Request("https://auth.internal/_internal/agent-events", {
          method: "POST",
          body: JSON.stringify({
            agentId: buildAgent.id,
            repositoryId,
            actorUserId: user.id,
            event: "agent.assigned",
            data: { action: "assigned" },
          }),
        }),
        authEnv
      );
      await drainAgentEventOutbox(authEnv);
      expect(largeBodyCancelled).toBe(true);
      const largeBodyOutboxEvent = await env.DB.prepare(
        "SELECT id FROM auth_agent_events WHERE agent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      )
        .bind(buildAgent.id)
        .first<{ id: string }>();
      if (largeBodyOutboxEvent) {
        await env.DB.prepare("UPDATE auth_agent_events SET status = 'dropped' WHERE id = ?")
          .bind(largeBodyOutboxEvent.id)
          .run();
      }

      for (const url of [
        "https://localhost./",
        "https://LOCALHOST./",
        "https://service.local./",
        "https://service.INTERNAL./",
        "https://service.localdomain./",
        "https://service.home.arpa./",
        "http://hooks.example.com/x",
        "https://user:pw@hooks.example.com/x",
        "https://hooks.example.com:8443/x",
        "https://[::1]/x",
        "https://203.0.113.9/x",
        "https://metadata.google.internal/x",
      ]) {
        const rejected = await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
          url,
          events: ["agent.assigned"],
          enabled: true,
        });
        expect(rejected.status).toBe(400);
      }

      async function queueEvent(action: string, actorUserId = user.id) {
        const payload = { testAction: action, repositoryId, agentId: buildAgent.id };
        const result = await auth.fetch(
          new Request("https://auth.internal/_internal/agent-events", {
            method: "POST",
            body: JSON.stringify({
              agentId: buildAgent.id,
              repositoryId,
              actorUserId,
              event: "agent.assigned",
              data: { testAction: action },
            }),
          }),
          authEnv
        );
        expect(result.status).toBe(202);
        const queued = await env.DB.prepare(
          "SELECT id, agent_id AS agentId, repository_id AS repositoryId, actor_user_id AS actorUserId, event, payload, created_at AS createdAt, next_attempt_at AS nextAttemptAt, attempts, delivery_id AS deliveryId, status, lease_until AS leaseUntil, error_code AS errorCode FROM auth_agent_events WHERE agent_id = ? AND payload = ?"
        )
          .bind(buildAgent.id, JSON.stringify(payload))
          .first<{
            id: string;
            agentId: string;
            repositoryId: string;
            actorUserId: string;
            event: string;
            payload: string;
            createdAt: number;
            nextAttemptAt: number;
            attempts: number;
            deliveryId: string;
            status: string;
            leaseUntil: number | null;
            errorCode: string | null;
          }>();
        if (!queued) throw new Error("Internal event was not written to the outbox.");
        return queued;
      }

      await env.DB.prepare("UPDATE repositories SET agents_enabled = 0 WHERE id = ?")
        .bind(repositoryId)
        .run();
      const disabledFeature = await queueEvent("agents-disabled");
      const fetchesBeforeDisabledFeature = webhookFetches;
      await drainAgentEventOutbox(authEnv);
      expect(webhookFetches).toBe(fetchesBeforeDisabledFeature);
      const droppedFeature = await env.DB.prepare(
        "SELECT status, error_code AS errorCode FROM auth_agent_events WHERE id = ?"
      )
        .bind(disabledFeature.id)
        .first<{ status: string; errorCode: string | null }>();
      expect(droppedFeature).toEqual({ status: "dropped", errorCode: "event_scope_lost" });
      await env.DB.prepare("UPDATE repositories SET agents_enabled = 1 WHERE id = ?")
        .bind(repositoryId)
        .run();

      const otherUser = await env.DB.prepare(
        "SELECT id FROM users WHERE identifier LIKE 'other-%' ORDER BY created_at DESC LIMIT 1"
      ).first<{ id: string }>();
      if (!otherUser) throw new Error("Second user fixture was not found.");
      const actorRoleLost = await queueEvent("actor-role-lost", otherUser.id);
      const fetchesBeforeActorRoleCheck = webhookFetches;
      await drainAgentEventOutbox(authEnv);
      expect(webhookFetches).toBe(fetchesBeforeActorRoleCheck);
      const droppedActorRole = await env.DB.prepare(
        "SELECT status FROM auth_agent_events WHERE id = ?"
      )
        .bind(actorRoleLost.id)
        .first<{ status: string }>();
      expect(droppedActorRole?.status).toBe("dropped");
      await env.DB.prepare(
        "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, 'write', ?)"
      )
        .bind(repositoryId, otherUser.id, Date.now())
        .run();
      await env.DB.prepare(
        "DELETE FROM namespace_memberships WHERE namespace_id = ? AND user_id = ?"
      )
        .bind(namespace.id, user.id)
        .run();
      const ownerRoleLost = await queueEvent("owner-role-lost", otherUser.id);
      const fetchesBeforeOwnerRoleCheck = webhookFetches;
      await drainAgentEventOutbox(authEnv);
      expect(webhookFetches).toBe(fetchesBeforeOwnerRoleCheck);
      const droppedOwnerRole = await env.DB.prepare(
        "SELECT status FROM auth_agent_events WHERE id = ?"
      )
        .bind(ownerRoleLost.id)
        .first<{ status: string }>();
      expect(droppedOwnerRole?.status).toBe("dropped");
      await env.DB.prepare(
        "INSERT INTO namespace_memberships (namespace_id, user_id, created_at) VALUES (?, ?, ?)"
      )
        .bind(namespace.id, user.id, Date.now())
        .run();
      await env.DB.prepare(
        "DELETE FROM repository_collaborators WHERE repository_id = ? AND user_id = ?"
      )
        .bind(repositoryId, otherUser.id)
        .run();
      await env.DB.prepare("UPDATE auth_agents SET disabled_at = ? WHERE id = ?")
        .bind(Date.now(), buildAgent.id)
        .run();
      const disabledAgentEvent = await queueEvent("agent-disabled");
      const fetchesBeforeAgentCheck = webhookFetches;
      await drainAgentEventOutbox(authEnv);
      expect(webhookFetches).toBe(fetchesBeforeAgentCheck);
      const droppedDisabledAgent = await env.DB.prepare(
        "SELECT status FROM auth_agent_events WHERE id = ?"
      )
        .bind(disabledAgentEvent.id)
        .first<{ status: string }>();
      expect(droppedDisabledAgent?.status).toBe("dropped");
      await env.DB.prepare("UPDATE auth_agents SET disabled_at = NULL WHERE id = ?")
        .bind(buildAgent.id)
        .run();

      const concurrentEvent = await queueEvent("concurrent-claim");
      let concurrentFetches = 0;
      let concurrentDeliveryId = "";
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        concurrentFetches += 1;
        concurrentDeliveryId = new Headers(init?.headers).get("GitEdge-Delivery") ?? "";
        return new Response(null, { status: 204 });
      });
      const concurrentNow = Date.now();
      await Promise.all([
        drainAgentEventOutbox(authEnv, concurrentNow),
        drainAgentEventOutbox(authEnv, concurrentNow),
      ]);
      expect(concurrentFetches).toBe(1);
      expect(concurrentDeliveryId).toBe(concurrentEvent.deliveryId);
      const deliveredConcurrent = await env.DB.prepare(
        "SELECT status FROM auth_agent_events WHERE id = ?"
      )
        .bind(concurrentEvent.id)
        .first<{ status: string }>();
      expect(deliveredConcurrent?.status).toBe("delivered");

      const retryIds: string[] = [];
      let retryFetchCount = 0;
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        retryFetchCount += 1;
        retryIds.push(new Headers(init?.headers).get("GitEdge-Delivery") ?? "");
        return new Response(null, { status: retryFetchCount < 3 ? 500 : 204 });
      });
      const retryEvent = await queueEvent("backoff-retry");
      let retryNow = Date.now();
      await drainAgentEventOutbox(authEnv, retryNow);
      let retryRow = await env.DB.prepare(
        "SELECT status, attempts, next_attempt_at AS nextAttemptAt FROM auth_agent_events WHERE id = ?"
      )
        .bind(retryEvent.id)
        .first<{ status: string; attempts: number; nextAttemptAt: number }>();
      expect(retryRow).toMatchObject({ status: "pending", attempts: 1 });
      if (!retryRow) throw new Error("First webhook retry state was not recorded.");
      expect(retryRow.nextAttemptAt - retryNow).toBeGreaterThanOrEqual(60_000);
      retryNow = retryRow.nextAttemptAt;
      await drainAgentEventOutbox(authEnv, retryNow);
      retryRow = await env.DB.prepare(
        "SELECT status, attempts, next_attempt_at AS nextAttemptAt FROM auth_agent_events WHERE id = ?"
      )
        .bind(retryEvent.id)
        .first<{ status: string; attempts: number; nextAttemptAt: number }>();
      expect(retryRow).toMatchObject({ status: "pending", attempts: 2 });
      if (!retryRow) throw new Error("Second webhook retry state was not recorded.");
      expect(retryRow.nextAttemptAt - retryNow).toBeGreaterThanOrEqual(120_000);
      retryNow = retryRow.nextAttemptAt;
      await drainAgentEventOutbox(authEnv, retryNow);
      const deliveredRetry = await env.DB.prepare(
        "SELECT status, attempts FROM auth_agent_events WHERE id = ?"
      )
        .bind(retryEvent.id)
        .first<{ status: string; attempts: number }>();
      expect(deliveredRetry).toEqual({ status: "delivered", attempts: 3 });
      expect(retryFetchCount).toBe(3);
      expect(new Set(retryIds)).toEqual(new Set([retryEvent.deliveryId]));

      const exhaustedEvent = await queueEvent("attempt-limit");
      retryFetchCount = 0;
      retryIds.length = 0;
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        retryFetchCount += 1;
        retryIds.push(new Headers(init?.headers).get("GitEdge-Delivery") ?? "");
        return new Response(null, { status: 500 });
      });
      retryNow = Date.now();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await drainAgentEventOutbox(authEnv, retryNow);
        const state = await env.DB.prepare(
          "SELECT status, attempts, next_attempt_at AS nextAttemptAt FROM auth_agent_events WHERE id = ?"
        )
          .bind(exhaustedEvent.id)
          .first<{ status: string; attempts: number; nextAttemptAt: number }>();
        if (!state) throw new Error("Retry limit event disappeared.");
        if (state.status === "dead") break;
        retryNow = state.nextAttemptAt;
      }
      const deadEvent = await env.DB.prepare(
        "SELECT status, attempts FROM auth_agent_events WHERE id = ?"
      )
        .bind(exhaustedEvent.id)
        .first<{ status: string; attempts: number }>();
      expect(deadEvent).toEqual({ status: "dead", attempts: 5 });
      expect(retryFetchCount).toBe(5);
      expect(new Set(retryIds)).toEqual(new Set([exhaustedEvent.deliveryId]));

      let bodyTimedOut = false;
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => {
                  bodyTimedOut = true;
                  controller.error(signal.reason);
                },
                { once: true }
              );
            },
          }),
          { status: 200 }
        );
      });
      const timeoutEvent = await queueEvent("body-timeout");
      await drainAgentEventOutbox(authEnv);
      expect(bodyTimedOut).toBe(true);
      const timedOutDelivery = await env.DB.prepare(
        "SELECT status, error_code AS errorCode FROM auth_agent_webhook_deliveries WHERE id = ?"
      )
        .bind(timeoutEvent.deliveryId)
        .first<{ status: string; errorCode: string | null }>();
      expect(timedOutDelivery).toEqual({ status: "failed", errorCode: "timeout" });

      let standaloneFetchCount = 0;
      vi.stubGlobal("fetch", async () => {
        standaloneFetchCount += 1;
        return new Response(null, { status: 500 });
      });
      const standaloneTest = await accountApi(
        `/agents/${buildAgent.id}/webhook/test`,
        "POST",
        cookie,
        {}
      );
      expect(standaloneTest.status).toBe(502);
      const standaloneDelivery = z
        .object({ data: z.object({ id: z.string(), attemptCount: z.number() }) })
        .parse(await standaloneTest.json()).data;
      expect(standaloneDelivery.attemptCount).toBe(1);

      let fetchStarted!: () => void;
      let releaseFetch!: () => void;
      const started = new Promise<void>((resolve) => {
        fetchStarted = resolve;
      });
      const responseGate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      vi.stubGlobal("fetch", async () => {
        standaloneFetchCount += 1;
        fetchStarted();
        await responseGate;
        return new Response(null, { status: 500 });
      });
      const retryPath = `/agents/${buildAgent.id}/webhook/deliveries/${standaloneDelivery.id}/retry`;
      const firstRetryPromise = accountApi(retryPath, "POST", cookie, {});
      await started;
      const concurrentRetry = await accountApi(retryPath, "POST", cookie, {});
      expect(concurrentRetry.status).toBe(409);
      releaseFetch();
      const firstRetry = await firstRetryPromise;
      expect(firstRetry.status).toBe(502);
      expect(standaloneFetchCount).toBe(2);

      await env.DB.prepare(
        "UPDATE auth_agent_webhook_deliveries SET attempt_count = 4 WHERE id = ? AND agent_id = ? AND status = 'failed'"
      )
        .bind(standaloneDelivery.id, buildAgent.id)
        .run();
      vi.stubGlobal("fetch", async () => {
        standaloneFetchCount += 1;
        return new Response(null, { status: 500 });
      });
      const finalRetry = await accountApi(retryPath, "POST", cookie, {});
      expect(finalRetry.status).toBe(502);
      expect(await finalRetry.json()).toMatchObject({
        data: { id: standaloneDelivery.id, attemptCount: 5, status: "failed" },
      });
      const overLimitRetry = await accountApi(retryPath, "POST", cookie, {});
      expect(overLimitRetry.status).toBe(409);
      expect(standaloneFetchCount).toBe(3);
    } finally {
      vi.unstubAllGlobals();
    }

    const firstSessionResponse = await accountApi(
      `/agents/${buildAgent.id}/sessions`,
      "POST",
      cookie,
      { repositoryId, baseRef: "main", permission: "read", ttlSeconds: 300 }
    );
    const secondSessionResponse = await accountApi(
      `/agents/${reviewAgent.id}/sessions`,
      "POST",
      cookie,
      { repositoryId, baseRef: "main", permission: "write", ttlSeconds: 900 }
    );
    expect(firstSessionResponse.status).toBe(201);
    expect(secondSessionResponse.status).toBe(201);
    const firstSession = CreatedSessionSchema.parse(await firstSessionResponse.json()).data;
    const secondSession = CreatedSessionSchema.parse(await secondSessionResponse.json()).data;
    expect(firstSession.permission).toBe("read");
    expect(secondSession.permission).toBe("write");
    expect(firstSession.workspaceName).not.toBe(secondSession.workspaceName);
    expect(firstSession.remote).not.toBe(secondSession.remote);

    for (const session of [firstSession, secondSession]) {
      const snapshot = artifacts.snapshot(session.workspaceName);
      expect(snapshot.info.source).toBe(`artifacts:${source.name}`);
      expect(snapshot.tokens).toHaveLength(2);
      expect(snapshot.tokens[0]?.state).toBe("revoked");
      const activeToken = snapshot.tokens.find((token) => token.state === "active");
      expect(activeToken?.scope).toBe(session.permission);
      expect(Date.parse(activeToken?.expiresAt ?? "") - Date.now()).toBeGreaterThan(0);
      expect(session.expiresAt).toBe(Date.parse(activeToken?.expiresAt ?? ""));
    }
    expect(artifacts.snapshot(firstSession.workspaceName).info.readOnly).toBe(true);
    expect(artifacts.snapshot(secondSession.workspaceName).info.readOnly).toBe(false);

    const sessionRows = await env.DB.prepare(
      "SELECT id, token_hash, git_token_id, workspace_name, permission, status FROM auth_agent_sessions WHERE user_id = ? ORDER BY created_at"
    )
      .bind(user.id)
      .all<{
        id: string;
        token_hash: string;
        git_token_id: string;
        workspace_name: string;
        permission: string;
        status: string;
      }>();
    expect(sessionRows.results).toHaveLength(2);
    for (const session of [firstSession, secondSession]) {
      const stored = sessionRows.results.find((row) => row.id === session.id);
      expect(stored?.token_hash).toBe(await sha256Hex(session.token));
      expect(stored?.token_hash).not.toBe(session.token);
      expect(stored?.git_token_id).not.toBe(session.gitToken);
      expect(JSON.stringify(stored)).not.toContain(session.gitToken);
    }

    for (const session of [firstSession, secondSession]) {
      const authenticated = await auth.fetch(
        new Request("https://auth.test/session", {
          headers: { Authorization: `Bearer ${session.token}` },
        }),
        authEnv
      );
      expect(authenticated.status).toBe(200);
      expect(await authenticated.json()).toMatchObject({
        data: {
          id: user.id,
          identifier: user.identifier,
          agentSession: {
            id: session.id,
            repositoryId,
            permission: session.permission,
          },
        },
      });
    }

    const sessionList = await accountApi(`/agents/${buildAgent.id}/sessions`, "GET", cookie);
    expect(sessionList.status).toBe(200);
    const sessionListPayload = JSON.stringify(await sessionList.json());
    expect(sessionListPayload).not.toContain(firstSession.token);
    expect(sessionListPayload).not.toContain(firstSession.gitToken);

    const revoked = await accountApi(
      `/agents/${buildAgent.id}/sessions/${firstSession.id}`,
      "DELETE",
      cookie
    );
    expect(revoked.status).toBe(200);
    expect(
      artifacts
        .snapshot(firstSession.workspaceName)
        .tokens.every((token) => token.state === "revoked")
    ).toBe(true);
    const revokedSession = await env.DB.prepare(
      "SELECT status FROM auth_agent_sessions WHERE id = ?"
    )
      .bind(firstSession.id)
      .first<{ status: string }>();
    expect(revokedSession?.status).toBe("revoked");
    const invalidSession = await auth.fetch(
      new Request("https://auth.test/session", {
        headers: { Authorization: `Bearer ${firstSession.token}` },
      }),
      authEnv
    );
    expect(invalidSession.status).toBe(401);

    const gitTokenResponse = await accountApi("/tokens", "POST", cookie, {
      repositoryId,
      name: "test read token",
      permission: "read",
      ttlSeconds: 300,
    });
    expect(gitTokenResponse.status).toBe(201);
    const gitToken = CreatedGitTokenSchema.parse(await gitTokenResponse.json()).data;
    const gitTokenRow = await env.DB.prepare(
      "SELECT token_hash, permission FROM auth_git_tokens WHERE id = ?"
    )
      .bind(gitToken.id)
      .first<{ token_hash: string; permission: string }>();
    expect(gitTokenRow?.token_hash).toBe(await sha256Hex(gitToken.token));
    expect(gitTokenRow?.permission).toBe("read");
    const listedTokens = await accountApi("/tokens", "GET", cookie);
    expect(JSON.stringify(await listedTokens.json())).not.toContain(gitToken.token);
    const gitSession = await auth.fetch(
      new Request(`https://auth.test/git-session?owner=${user.identifier}&repo=agent-source`, {
        headers: { Authorization: `Basic ${btoa(`${user.identifier}:${gitToken.token}`)}` },
      }),
      authEnv
    );
    expect(gitSession.status).toBe(200);
    expect(await gitSession.json()).toMatchObject({
      data: { repositoryId, permission: "read", user: { id: user.id } },
    });
    const revokedGitToken = await accountApi(`/tokens/${gitToken.id}`, "DELETE", cookie);
    expect(revokedGitToken.status).toBe(200);
    const invalidGitSession = await auth.fetch(
      new Request(`https://auth.test/git-session?owner=${user.identifier}&repo=agent-source`, {
        headers: { Authorization: `Bearer ${gitToken.token}` },
      }),
      authEnv
    );
    expect(invalidGitSession.status).toBe(401);

    const disabled = await accountApi(`/agents/${reviewAgent.id}`, "DELETE", cookie);
    expect(disabled.status).toBe(200);
    const disabledSession = await env.DB.prepare(
      "SELECT status FROM auth_agent_sessions WHERE id = ?"
    )
      .bind(secondSession.id)
      .first<{ status: string }>();
    expect(disabledSession?.status).toBe("revoked");
    expect(
      artifacts
        .snapshot(secondSession.workspaceName)
        .tokens.every((token) => token.state === "revoked")
    ).toBe(true);
    const disabledAuth = await auth.fetch(
      new Request("https://auth.test/session", {
        headers: { Authorization: `Bearer ${secondSession.token}` },
      }),
      authEnv
    );
    expect(disabledAuth.status).toBe(401);
  }, 15_000);
});

describe("Agent delivery mode and session renewal", () => {
  async function fixture() {
    const identifier = `renew-${crypto.randomUUID().slice(0, 8)}`;
    const registration = await auth.fetch(
      new Request("https://auth.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://auth.test" },
        body: JSON.stringify({ identifier, password: "a-long-test-password-2026" }),
      }),
      authEnv
    );
    const cookie = cookieFrom(registration);
    const user = await env.DB.prepare("SELECT id FROM users WHERE identifier = ?")
      .bind(identifier)
      .first<{ id: string }>();
    const namespace = await env.DB.prepare("SELECT id FROM namespaces WHERE slug = ?")
      .bind(identifier)
      .first<{ id: string }>();
    if (!user || !namespace) throw new Error("Fixture account is missing.");
    const source = await artifacts.create(`repo-${crypto.randomUUID()}`, {
      setDefaultBranch: "main",
    });
    const repositoryId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, 'renewal', ?, ?, ?, 'main', 'private', '', 1, 1)"
    )
      .bind(repositoryId, namespace.id, user.id, `repo:${repositoryId}`, source.name, source.remote)
      .run();
    const agentResponse = await accountApi("/agents", "POST", cookie, { name: "Renewer" });
    const agent = z.object({ data: AgentSchema }).parse(await agentResponse.json()).data;
    const sessionResponse = await accountApi(`/agents/${agent.id}/sessions`, "POST", cookie, {
      repositoryId,
      baseRef: "main",
      permission: "write",
      ttlSeconds: 3600,
    });
    expect(sessionResponse.status).toBe(201);
    const session = CreatedSessionSchema.parse(await sessionResponse.json()).data;
    return { cookie, agent, session };
  }

  const renew = (token: string, body: unknown = {}) =>
    auth.fetch(
      new Request("https://auth.test/agent-session/renew", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      authEnv
    );
  const RenewedSchema = z.object({
    data: z.object({
      id: z.string(),
      gitToken: z.string(),
      expiresAt: z.number(),
      maxExpiresAt: z.number(),
      renewalCount: z.number(),
    }),
  });

  it("stores the delivery mode per agent and rejects unknown modes", async () => {
    const { cookie, agent } = await fixture();
    expect(agent.deliveryMode).toBe("webhook");
    const updated = await accountApi(`/agents/${agent.id}`, "PATCH", cookie, {
      deliveryMode: "both",
    });
    expect(z.object({ data: AgentSchema }).parse(await updated.json()).data.deliveryMode).toBe(
      "both"
    );
    expect(
      (await accountApi(`/agents/${agent.id}`, "PATCH", cookie, { deliveryMode: "smoke" })).status
    ).toBe(400);
  });

  it("renews a session, keeps the fork and session token, and rotates the Git credential", async () => {
    const { session } = await fixture();
    const before = artifacts.snapshot(session.workspaceName).tokens;
    expect(before.filter((token) => token.state === "active")).toHaveLength(1);
    const response = await renew(session.token, { ttlSeconds: 7200 });
    expect(response.status).toBe(200);
    const renewed = RenewedSchema.parse(await response.json()).data;
    expect(renewed.id).toBe(session.id);
    expect(renewed.gitToken).not.toBe(session.gitToken);
    expect(renewed.expiresAt).toBeGreaterThan(session.expiresAt);
    expect(renewed.renewalCount).toBe(1);
    const after = artifacts.snapshot(session.workspaceName).tokens;
    expect(after.filter((token) => token.state === "revoked").map((token) => token.id)).toContain(
      before.find((token) => token.state === "active")?.id
    );
    expect(after.filter((token) => token.state === "active")).toHaveLength(1);
    const identity = await auth.fetch(
      new Request("https://auth.test/session", {
        headers: { Authorization: `Bearer ${session.token}` },
      }),
      authEnv
    );
    expect(identity.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT expires_at AS expiresAt, renewal_count AS renewals FROM auth_agent_sessions WHERE id = ?"
    )
      .bind(session.id)
      .first();
    expect(row).toEqual({ expiresAt: renewed.expiresAt, renewals: 1 });
  });

  it("caps renewal at the maximum session lifetime and then refuses", async () => {
    const { session } = await fixture();
    const created = await env.DB.prepare(
      "SELECT created_at AS createdAt FROM auth_agent_sessions WHERE id = ?"
    )
      .bind(session.id)
      .first<{ createdAt: number }>();
    const maxLifetime = session.maxExpiresAt - (created?.createdAt ?? 0);
    const newCreatedAt = Date.now() - maxLifetime + 2 * 3_600_000;
    await env.DB.prepare("UPDATE auth_agent_sessions SET created_at = ? WHERE id = ?")
      .bind(newCreatedAt, session.id)
      .run();
    const capped = RenewedSchema.parse(
      await (await renew(session.token, { ttlSeconds: 86_400 })).json()
    ).data;
    expect(capped.maxExpiresAt).toBe(newCreatedAt + maxLifetime);
    expect(capped.expiresAt).toBeLessThanOrEqual(newCreatedAt + maxLifetime);
    expect(newCreatedAt + maxLifetime - capped.expiresAt).toBeLessThan(5_000);
    await env.DB.prepare("UPDATE auth_agent_sessions SET expires_at = ? WHERE id = ?")
      .bind(newCreatedAt + maxLifetime, session.id)
      .run();
    const refused = await renew(session.token);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "session_lifetime_exceeded" } });
  });

  it("explains expired sessions and rejects revoked sessions and bad tokens", async () => {
    const { cookie, agent, session } = await fixture();
    expect((await renew("not-a-session-token")).status).toBe(401);
    await env.DB.prepare("UPDATE auth_agent_sessions SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, session.id)
      .run();
    const expired = await renew(session.token);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      error: { code: "session_expired", message: expect.stringContaining("create a new session") },
    });
    const second = await fixture();
    expect(
      (
        await accountApi(
          `/agents/${second.agent.id}/sessions/${second.session.id}`,
          "DELETE",
          second.cookie
        )
      ).status
    ).toBe(200);
    expect((await renew(second.session.token)).status).toBe(401);
    expect(agent.id).not.toBe(second.agent.id);
    expect(cookie).not.toBe(second.cookie);
  });

  it("lets the agent owner renew a session from the account UI", async () => {
    const { cookie, agent, session } = await fixture();
    const response = await accountApi(
      `/agents/${agent.id}/sessions/${session.id}/renew`,
      "POST",
      cookie,
      { ttlSeconds: 7200 }
    );
    expect(response.status).toBe(200);
    expect(RenewedSchema.parse(await response.json()).data.renewalCount).toBe(1);
    const other = await fixture();
    expect(
      (
        await accountApi(
          `/agents/${agent.id}/sessions/${session.id}/renew`,
          "POST",
          other.cookie,
          {}
        )
      ).status
    ).toBe(404);
  });
});
