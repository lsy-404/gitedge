import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import auth from "../../workers/auth/src/index";
import forge from "../../workers/forge/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { rememberBrowserLogin } from "../../workers/auth/src/browser-accounts";
import { mentionAgents } from "../../workers/forge/src/agent-events";
import type { RepositoryRow } from "../../workers/forge/src/common";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";
import { countingRateLimiter, unlimitedRateLimiter } from "../support/rate-limiter";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const origin = "https://hardening.test";
const password = "a-valid-hardening-test-password";

class UnreachableArtifacts extends FixtureArtifacts {
  override async get(): Promise<never> {
    throw new Error("artifacts unavailable");
  }
}

const artifacts = new FixtureArtifacts();
const baseEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
  LOG_LEVEL: "error",
};

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  environment = baseEnv
): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    environment
  );
}

function patchProfile(cookie: string, identifier: string): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}/profile`, {
      method: "PATCH",
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ identifier }),
    }),
    baseEnv
  );
}

async function login(identifier: string) {
  const response = await post("/login", { identifier, password });
  expect(response.status).toBe(200);
  const session = response.headers.getSetCookie().find((v) => v.startsWith("gitedge_session="));
  if (!session) throw new Error("Expected a session cookie.");
  return { cookie: session.split(";")[0] };
}

async function register(identifier: string, headers: Record<string, string> = {}) {
  const response = await post("/register", { identifier, password }, headers);
  expect(response.status).toBe(201);
  const setCookie = response.headers.getSetCookie();
  const session = setCookie.find((value) => value.startsWith("gitedge_session="));
  if (!session) throw new Error("Expected a session cookie.");
  const saved = setCookie
    .filter((value) => value.startsWith("gitedge_account_") && !value.includes("Max-Age=0"))
    .map((value) => value.split(";")[0]);
  return {
    cookie: session.split(";")[0],
    saved,
    id: ((await response.json()) as { data: { id: string } }).data.id,
  };
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
});

describe("authentication throttling and body limits", () => {
  it("limits login attempts per identifier without affecting other identifiers", async () => {
    const limited = { ...baseEnv, RATE_LIMITER: countingRateLimiter() };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await post(
        "/login",
        { identifier: "Throttle-Target", password },
        {},
        limited
      );
      expect(response.status).toBe(401);
    }
    const blocked = await post("/login", { identifier: "throttle-target", password }, {}, limited);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    const other = await post("/login", { identifier: "someone-else", password }, {}, limited);
    expect(other.status).toBe(401);
  });

  it("limits registrations per client address before any account is created", async () => {
    const limited = { ...baseEnv, RATE_LIMITER: countingRateLimiter() };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post(
        "/register",
        { identifier: `throttle-reg-${attempt}`, password },
        { "CF-Connecting-IP": "203.0.113.9" },
        limited
      );
      expect(response.status).toBe(201);
    }
    const blocked = await post(
      "/register",
      { identifier: "throttle-reg-blocked", password },
      { "CF-Connecting-IP": "203.0.113.9" },
      limited
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    const created = await env.DB.prepare("SELECT id FROM users WHERE identifier = ?")
      .bind("throttle-reg-blocked")
      .first();
    expect(created).toBeNull();
  });

  it("shares one login bucket across padded and re-cased identifiers", async () => {
    const limited = { ...baseEnv, RATE_LIMITER: countingRateLimiter() };
    const variants = ["pad-target", " pad-target", "pad-target ", "\tPad-Target", "pad-target\n\n"];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await post(
        "/login",
        { identifier: variants[attempt % variants.length], password },
        {},
        limited
      );
      expect(response.status).toBe(401);
    }
    const blocked = await post("/login", { identifier: "  pad-target   ", password }, {}, limited);
    expect(blocked.status).toBe(429);
  });

  it("rejects a login body over the size limit even when its fields are valid", async () => {
    await register("body-limit-user");
    const response = await post("/login", {
      identifier: "body-limit-user",
      password,
      padding: "x".repeat(70_000),
    });
    expect(response.status).toBe(400);
    const accepted = await post("/login", { identifier: "body-limit-user", password });
    expect(accepted.status).toBe(200);
  });
});

describe("retired personal namespace names", () => {
  it("keeps a renamed account's old name reserved for its owner only", async () => {
    const owner = await register("rename-origin");
    expect((await patchProfile(owner.cookie, "rename-moved")).status).toBe(200);

    const claimed = await post("/register", { identifier: "rename-origin", password });
    expect(claimed.status).toBe(409);
    const organization = env.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at, kind) VALUES (?, ?, ?, ?, 'organization')"
    ).bind(crypto.randomUUID(), "rename-origin", owner.id, Date.now());
    await expect(organization.run()).rejects.toThrow();

    const other = await register("rename-other");
    expect((await patchProfile(other.cookie, "rename-origin")).status).toBe(409);

    expect((await patchProfile(owner.cookie, "rename-origin")).status).toBe(200);
    const reclaimed = await env.DB.prepare("SELECT slug FROM namespace_slug_history WHERE slug = ?")
      .bind("rename-origin")
      .first();
    expect(reclaimed).toBeNull();
    const retired = await env.DB.prepare("SELECT slug FROM namespace_slug_history WHERE slug = ?")
      .bind("rename-moved")
      .first();
    expect(retired).not.toBeNull();
  });
});

describe("browser account limit during redirect sign-in", () => {
  it("redirects to the add-account sign-in page and drops the new session", async () => {
    let saved: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const account = await register(`limit-account-${index}`, { Cookie: saved.join("; ") });
      saved = [...saved, ...account.saved];
    }
    const other = await register("limit-account-extra");
    const response = await rememberBrowserLogin(
      new Request(`${origin}/github/callback`, { headers: { Cookie: saved.join("; ") } }),
      baseEnv,
      other.id,
      other.cookie.slice("gitedge_session=".length),
      new Response(null, { status: 302, headers: { Location: "/dashboard?tab=a" } })
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(
      "/login?add=1&redirect=%2Fdashboard%3Ftab%3Da&error=account_limit"
    );
    const remaining = await env.DB.prepare("SELECT 1 AS found FROM auth_sessions WHERE user_id = ?")
      .bind(other.id)
      .first();
    expect(remaining).toBeNull();
  });
});

describe("agent session revocation", () => {
  async function seedSession(slug: string) {
    const owner = await register(`${slug}-owner`);
    const member = await register(`${slug}-member`);
    const namespace = await env.DB.prepare("SELECT id FROM namespaces WHERE slug = ?")
      .bind(`${slug}-owner`)
      .first<{ id: string }>();
    if (!namespace) throw new Error("Namespace is missing.");
    const source = await artifacts.create(`repo-${crypto.randomUUID()}`);
    const repositoryId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'main', 'private', '', ?, ?)"
    )
      .bind(
        repositoryId,
        namespace.id,
        owner.id,
        "revocable",
        `repo:${repositoryId}`,
        source.name,
        source.remote,
        Date.now(),
        Date.now()
      )
      .run();
    const agentId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO auth_agents (id, user_id, name, handle, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(agentId, member.id, "Fixture agent", `${slug}-bot`, Date.now())
      .run();
    using repo = await artifacts.get(source.name);
    const token = await repo.createToken("write", 3600);
    const sessionId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO auth_agent_sessions (id, agent_id, user_id, repository_id, token_hash, git_token_id, workspace_name, remote, base_ref, permission, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'main', 'write', 'active', ?, ?)"
    )
      .bind(
        sessionId,
        agentId,
        member.id,
        repositoryId,
        `hash-${sessionId}`,
        token.id,
        source.name,
        source.remote,
        Date.now(),
        Date.now() + 3_600_000
      )
      .run();
    return { sessionId, repositoryId, memberId: member.id, tokenId: token.id, source: source.name };
  }

  function revoke(body: unknown, environment = baseEnv): Promise<Response> {
    return auth.fetch(
      new Request("https://auth.internal/_internal/agent-sessions/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      environment
    );
  }

  async function sessionStatus(id: string): Promise<string | undefined> {
    const row = await env.DB.prepare("SELECT status FROM auth_agent_sessions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status;
  }

  it("revokes the Artifacts token and the session of a removed member", async () => {
    const seeded = await seedSession("revoke-ok");
    const response = await revoke({ repositoryId: seeded.repositoryId, userId: seeded.memberId });
    expect(response.status).toBe(200);
    expect(await sessionStatus(seeded.sessionId)).toBe("revoked");
    using repo = await artifacts.get(seeded.source);
    const tokens = await repo.listTokens();
    expect(tokens.tokens.find((token) => token.id === seeded.tokenId)?.state).toBe("revoked");
  });

  it("keeps the session active for retry when the Artifacts revocation fails", async () => {
    const seeded = await seedSession("revoke-fail");
    const failing = { ...baseEnv, ARTIFACTS: new UnreachableArtifacts() };
    const response = await revoke({ repositoryId: seeded.repositoryId }, failing);
    expect(response.status).toBe(503);
    expect(await sessionStatus(seeded.sessionId)).toBe("active");
  });

  it("rejects public requests and invalid scopes", async () => {
    const publicRequest = await post("/_internal/agent-sessions/revoke", { repositoryId: "any" });
    expect(publicRequest.status).toBe(404);
    expect((await revoke({})).status).toBe(400);
  });
});

describe("forge-triggered agent session revocation", () => {
  const authBinding = {
    fetch: (request: Request) => auth.fetch(request, baseEnv),
  };
  const forgeEnv = {
    DB: env.DB,
    ARTIFACTS: artifacts,
    GIT: { fetch: async () => new Response(null, { status: 204 }) },
    AUTH: authBinding,
    LOG_LEVEL: "error",
  };

  async function seed(slug: string) {
    const owner = await register(`${slug}-owner`);
    const member = await register(`${slug}-member`);
    const namespace = await env.DB.prepare("SELECT id FROM namespaces WHERE slug = ?")
      .bind(`${slug}-owner`)
      .first<{ id: string }>();
    if (!namespace) throw new Error("Namespace is missing.");
    const sessions = [] as { repositoryId: string; sessionId: string; source: string }[];
    const agentId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO auth_agents (id, user_id, name, handle, created_at) VALUES (?, ?, 'Fixture agent', ?, ?)"
    )
      .bind(agentId, member.id, `${slug}-bot`, Date.now())
      .run();
    for (const name of ["one", "two"]) {
      const source = await artifacts.create(`repo-${crypto.randomUUID()}`);
      const repositoryId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'main', 'private', '', ?, ?)"
      )
        .bind(
          repositoryId,
          namespace.id,
          owner.id,
          name,
          `repo:${repositoryId}`,
          source.name,
          source.remote,
          Date.now(),
          Date.now()
        )
        .run();
      using repo = await artifacts.get(source.name);
      const token = await repo.createToken("write", 3600);
      const sessionId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO auth_agent_sessions (id, agent_id, user_id, repository_id, token_hash, git_token_id, workspace_name, remote, base_ref, permission, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'main', 'write', 'active', ?, ?)"
      )
        .bind(
          sessionId,
          agentId,
          member.id,
          repositoryId,
          `hash-${sessionId}`,
          token.id,
          source.name,
          source.remote,
          Date.now(),
          Date.now() + 3_600_000
        )
        .run();
      sessions.push({ repositoryId, sessionId, source: source.name });
    }
    return { owner, member, namespaceId: namespace.id, sessions, agentId };
  }

  function callForge(
    path: string,
    method: string,
    user: { id: string; identifier: string },
    body?: unknown,
    environment: typeof forgeEnv = forgeEnv
  ): Promise<Response> {
    const headers = trustedHeaders({ id: user.id, identifier: user.identifier, groupKey: "free" });
    headers.set("Content-Type", "application/json");
    return forge.fetch(
      new Request(`https://forge.test${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      environment
    );
  }

  async function status(id: string): Promise<string | undefined> {
    const row = await env.DB.prepare("SELECT status FROM auth_agent_sessions WHERE id = ?")
      .bind(id)
      .first<{ status: string }>();
    return row?.status;
  }

  it("revokes a removed collaborator's sessions but keeps them while membership remains", async () => {
    const seeded = await seed("forge-collab");
    const target = seeded.sessions[0];
    await env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, 'write', ?)"
    )
      .bind(target.repositoryId, seeded.member.id, Date.now())
      .run();
    const removed = await callForge(
      `/repositories/${target.repositoryId}/collaborators/${seeded.member.id}`,
      "DELETE",
      seeded.owner
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ data: { revocationIncomplete: false } });
    expect(await status(target.sessionId)).toBe("revoked");
    expect(await status(seeded.sessions[1].sessionId)).toBe("active");
  });

  it("revokes sessions across an organization on member removal except collaborator repositories", async () => {
    const seeded = await seed("forge-org");
    await env.DB.prepare("UPDATE namespaces SET kind = 'organization' WHERE id = ?")
      .bind(seeded.namespaceId)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO namespace_memberships (namespace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?), (?, ?, 'member', ?)"
    )
      .bind(
        seeded.namespaceId,
        seeded.owner.id,
        Date.now(),
        seeded.namespaceId,
        seeded.member.id,
        Date.now()
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, 'write', ?)"
    )
      .bind(seeded.sessions[1].repositoryId, seeded.member.id, Date.now())
      .run();
    const removed = await callForge(
      `/organizations/forge-org-owner/members/forge-org-member`,
      "DELETE",
      seeded.owner
    );
    expect(removed.status).toBe(204);
    expect(await status(seeded.sessions[0].sessionId)).toBe("revoked");
    expect(await status(seeded.sessions[1].sessionId)).toBe("active");
  });

  it("revokes repository sessions when agents are disabled", async () => {
    const seeded = await seed("forge-agents-off");
    const target = seeded.sessions[0];
    const response = await callForge(
      `/repositories/${target.repositoryId}/settings`,
      "PATCH",
      seeded.owner,
      { agentsEnabled: false }
    );
    expect(response.status).toBe(200);
    expect(await status(target.sessionId)).toBe("revoked");
    expect(await status(seeded.sessions[1].sessionId)).toBe("active");
  });

  it("reports incomplete revocation instead of plain success", async () => {
    const seeded = await seed("forge-incomplete");
    const target = seeded.sessions[0];
    await env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id, user_id, role, created_at) VALUES (?, ?, 'write', ?)"
    )
      .bind(target.repositoryId, seeded.member.id, Date.now())
      .run();
    const failingAuth = {
      fetch: (request: Request) =>
        auth.fetch(request, { ...baseEnv, ARTIFACTS: new UnreachableArtifacts() }),
    };
    const removed = await callForge(
      `/repositories/${target.repositoryId}/collaborators/${seeded.member.id}`,
      "DELETE",
      seeded.owner,
      undefined,
      { ...forgeEnv, AUTH: failingAuth }
    );
    expect(await removed.json()).toMatchObject({ data: { revocationIncomplete: true } });
    expect(await status(target.sessionId)).toBe("active");
  });

  it("returns 503 from agent deletion when one session cannot be revoked", async () => {
    const seeded = await seed("forge-agent-delete");
    const failing = {
      ...baseEnv,
      ARTIFACTS: new (class extends FixtureArtifacts {
        override async get(name: string) {
          if (name === seeded.sessions[0].source) throw new Error("artifacts unavailable");
          return artifacts.get(name);
        }
      })(),
    };
    const response = await auth.fetch(
      new Request(`${origin}/agents/${seeded.agentId}`, {
        method: "DELETE",
        headers: { Origin: origin, Cookie: (await login("forge-agent-delete-member")).cookie },
      }),
      failing
    );
    expect(response.status).toBe(503);
    expect(await status(seeded.sessions[0].sessionId)).toBe("active");
    expect(await status(seeded.sessions[1].sessionId)).toBe("revoked");
  });
});

describe("agent mention delivery", () => {
  it("queues a mention only when the agent owner can access the repository", async () => {
    const owner = await register("mention-owner");
    const outsider = await register("mention-outsider");
    const namespace = await env.DB.prepare("SELECT id FROM namespaces WHERE slug = ?")
      .bind("mention-owner")
      .first<{ id: string }>();
    if (!namespace) throw new Error("Namespace is missing.");
    const repositoryId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, 'public-repo', ?, 'https://artifacts.test/x', 'main', 'public', '', ?, ?)"
    )
      .bind(repositoryId, namespace.id, owner.id, `repo:${repositoryId}`, Date.now(), Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO auth_agents (id, user_id, name, handle, created_at) VALUES (?, ?, 'Outsider bot', 'outsider-bot', ?)"
    )
      .bind(crypto.randomUUID(), outsider.id, Date.now())
      .run();
    await env.DB.prepare(
      "INSERT INTO auth_agents (id, user_id, name, handle, created_at) VALUES (?, ?, 'Owner bot', 'owner-bot', ?)"
    )
      .bind(crypto.randomUUID(), owner.id, Date.now())
      .run();
    const events: string[] = [];
    const forgeEnv = {
      DB: env.DB,
      ARTIFACTS: artifacts,
      GIT: { fetch: async () => new Response(null, { status: 204 }) },
      AUTH: {
        fetch: async (request: Request) => {
          events.push(((await request.json()) as { agentId: string }).agentId);
          return new Response(null, { status: 202 });
        },
      },
    };
    const repository: RepositoryRow = {
      id: repositoryId,
      namespace_id: namespace.id,
      owner: "mention-owner",
      slug: "public-repo",
      visibility: "public",
      description: "",
    };
    await mentionAgents(
      forgeEnv,
      repository,
      { id: owner.id, identifier: "mention-owner", groupKey: "free" },
      "ping mention-outsider/@outsider-bot and mention-owner/@owner-bot",
      { targetKind: "issue" }
    );
    const ownerAgent = await env.DB.prepare(
      "SELECT id FROM auth_agents WHERE handle = 'owner-bot'"
    ).first<{ id: string }>();
    expect(events).toEqual([ownerAgent?.id]);
  });
});
