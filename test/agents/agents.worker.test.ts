import { runSqlScript } from "../support/database";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSchema, sha256Hex, type Agent } from "../../packages/contracts/src/index";
import auth from "../../workers/auth/src/index";
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
    }
  }
}

const artifacts = new FixtureArtifacts();
const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
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
});

describe("Auth agents, Artifact sessions, and Git credentials", () => {
  it("owns registration, isolates two agents and sessions, revokes scoped tokens, and manages Git tokens", async () => {
    const registration = await auth.fetch(
      new Request("https://auth.test/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      webhookFetches += 1;
      capturedSignature = new Headers(init?.headers).get("X-GitEdge-Signature-256") ?? "";
      capturedBody = String(init?.body ?? "");
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

      await auth.fetch(
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
      await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://hooks.example.com/gitedge",
        events: ["agent.assigned"],
        enabled: false,
      });
      const countBeforeDisabled = webhookFetches;
      await auth.fetch(
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
      expect(webhookFetches).toBe(countBeforeDisabled);
      const unsafeUrl = await accountApi(`/agents/${buildAgent.id}/webhook`, "PUT", cookie, {
        url: "https://127.0.0.1/hook",
        events: ["agent.assigned"],
        enabled: true,
      });
      expect(unsafeUrl.status).toBe(400);
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
  });
});
