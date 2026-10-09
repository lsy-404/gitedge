import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AccessTokenIdentitySchema,
  sha256Hex,
  type AccessTokenIdentity,
} from "../../packages/contracts/src/index";
import {
  REPOSITORY_ACCESS_DENIED_HEADER,
  trustedHeaders,
} from "../../packages/contracts/src/trust";
import actions from "../../workers/actions/src/index";
import auth from "../../workers/auth/src/index";
import { parseGitAuthorization } from "../../workers/auth/src/agents";
import { handleAccessTokenManagement } from "../../workers/auth/src/access-tokens";
import { issueSession } from "../../workers/auth/src/session";
import forge from "../../workers/forge/src/index";
import git from "../../workers/git/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";
import { unlimitedRateLimiter } from "../support/rate-limiter";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: { fetch: async () => Response.json({ data: [] }) },
};

const CreatedSchema = z.object({
  data: z.object({
    id: z.string(),
    token: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    repositories: z
      .array(z.object({ id: z.string(), owner: z.string(), slug: z.string() }))
      .nullable(),
    expiresAt: z.number(),
  }),
});
const ListSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), prefix: z.string(), lastUsedAt: z.number().nullable() })
  ),
});

let aliceCookie = "";
let bobCookie = "";

async function cookieFor(userId: string): Promise<string> {
  return `gitedge_session=${await issueSession(env, userId)}`;
}

function account(path: string, method: string, cookie: string, body?: unknown): Promise<Response> {
  const headers = new Headers({ Cookie: cookie, Origin: "https://auth.test" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return auth.fetch(
    new Request(`https://auth.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    authEnv
  );
}

async function mint(
  cookie: string,
  scopes: string[],
  extra: Record<string, unknown> = {}
): Promise<z.infer<typeof CreatedSchema>["data"]> {
  const response = await account("/access-tokens", "POST", cookie, {
    name: "ci",
    scopes,
    expiresInDays: 30,
    ...extra,
  });
  expect(response.status).toBe(201);
  return CreatedSchema.parse(await response.json()).data;
}

async function sessionFor(token: string): Promise<Response> {
  return auth.fetch(
    new Request("https://auth.test/session", { headers: { Authorization: `Bearer ${token}` } }),
    authEnv
  );
}

function basic(username: string, token: string): string {
  return `Basic ${btoa(`${username}:${token}`)}`;
}

async function gitSession(authorization: string, repo: string): Promise<Response> {
  return auth.fetch(
    new Request(`https://auth.test/git-session?owner=alice&repo=${repo}`, {
      headers: { Authorization: authorization },
    }),
    authEnv
  );
}

function identity(token: AccessTokenIdentity) {
  return { id: "alice-id", identifier: "alice", groupKey: "free", token };
}

function forgeRequest(
  path: string,
  method: string,
  token: AccessTokenIdentity,
  body?: unknown
): Promise<Response> {
  const headers = trustedHeaders(identity(token));
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('alice-id','alice','x','x',1), ('bob-id','bob','x','x',1);
INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('n1','alice','alice-id',1,'personal','Alice',''), ('n2','bob','bob-id',1,'personal','Bob','');
INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('n1','alice-id',1,'owner'), ('n2','bob-id',1,'owner');
INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,artifact_name,remote,visibility,description,created_at,updated_at) VALUES ('r1','n1','alice-id','demo','repo:r1','a1','https://a.test/r1.git','private','',1,1), ('r2','n1','alice-id','other','repo:r2','a2','https://a.test/r2.git','private','',1,1), ('r3','n2','bob-id','secret','repo:r3','a3','https://a.test/r3.git','private','',1,1);`
  );
  aliceCookie = await cookieFor("alice-id");
  bobCookie = await cookieFor("bob-id");
});

describe("personal access token lifecycle", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    const created = await mint(aliceCookie, ["repo:read"]);
    expect(created.token).toMatch(/^gep_[0-9a-f]{64}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const row = await env.DB.prepare(
      "SELECT token_hash AS hash, prefix FROM auth_access_tokens WHERE id = ?"
    )
      .bind(created.id)
      .first<{ hash: string; prefix: string }>();
    expect(row?.hash).toBe(await sha256Hex(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const listed = await account("/access-tokens", "GET", aliceCookie);
    const text = await listed.text();
    expect(text).not.toContain(created.token);
    expect(ListSchema.parse(JSON.parse(text)).data.some((item) => item.id === created.id)).toBe(
      true
    );

    const other = await account("/access-tokens", "GET", bobCookie);
    expect(await other.text()).not.toContain(created.id);
  });

  it("enforces required expiry within one year", async () => {
    for (const body of [
      { name: "x", scopes: ["repo:read"] },
      { name: "x", scopes: ["repo:read"], expiresInDays: 366 },
      { name: "x", scopes: ["repo:read"], expiresInDays: 0 },
      { name: "x", scopes: [], expiresInDays: 7 },
      { name: "x", scopes: ["root"], expiresInDays: 7 },
    ])
      expect((await account("/access-tokens", "POST", aliceCookie, body)).status).toBe(400);
    const created = await mint(aliceCookie, ["repo:read"]);
    expect(created.expiresAt - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(created.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it("rejects repositories the creator cannot access", async () => {
    const response = await account("/access-tokens", "POST", aliceCookie, {
      name: "x",
      scopes: ["repo:read"],
      repositoryIds: ["r3"],
      expiresInDays: 7,
    });
    expect(response.status).toBe(404);
  });

  it("authenticates, touches last use at most once a minute, and rejects revoked or expired tokens", async () => {
    const created = await mint(aliceCookie, ["repo:read", "issues:write"], {
      repositoryIds: ["r1"],
    });
    const response = await sessionFor(created.token);
    expect(response.status).toBe(200);
    const payload = z
      .object({ data: z.object({ id: z.string(), token: AccessTokenIdentitySchema }) })
      .parse(await response.json());
    expect(payload.data.id).toBe("alice-id");
    expect(payload.data.token).toEqual({
      id: created.id,
      scopes: ["repo:read", "issues:write"],
      repositoryIds: ["r1"],
    });
    const first = await env.DB.prepare(
      "SELECT last_used_at AS usedAt FROM auth_access_tokens WHERE id = ?"
    )
      .bind(created.id)
      .first<{ usedAt: number }>();
    expect(first?.usedAt).toBeGreaterThan(0);
    await sessionFor(created.token);
    const second = await env.DB.prepare(
      "SELECT last_used_at AS usedAt FROM auth_access_tokens WHERE id = ?"
    )
      .bind(created.id)
      .first<{ usedAt: number }>();
    expect(second?.usedAt).toBe(first?.usedAt);

    await env.DB.prepare("UPDATE auth_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, created.id)
      .run();
    expect((await sessionFor(created.token)).status).toBe(401);
    await env.DB.prepare("UPDATE auth_access_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() + 60_000, created.id)
      .run();
    expect((await sessionFor(created.token)).status).toBe(200);

    expect((await account(`/access-tokens/${created.id}`, "DELETE", bobCookie)).status).toBe(404);
    expect((await account(`/access-tokens/${created.id}`, "DELETE", aliceCookie)).status).toBe(200);
    expect((await sessionFor(created.token)).status).toBe(401);
    expect((await sessionFor(`gep_${"0".repeat(64)}`)).status).toBe(401);
  });

  it("cannot be minted by tokens or agent sessions", async () => {
    const created = await mint(aliceCookie, ["admin"]);
    const withToken = await auth.fetch(
      new Request("https://auth.test/access-tokens", {
        method: "POST",
        headers: {
          Cookie: aliceCookie,
          Authorization: `Bearer ${created.token}`,
          Origin: "https://auth.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x", scopes: ["admin"], expiresInDays: 7 }),
      }),
      authEnv
    );
    expect(withToken.status).toBe(403);
    const tokenOnly = await auth.fetch(
      new Request("https://auth.test/access-tokens", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.token}`,
          Origin: "https://auth.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "x", scopes: ["admin"], expiresInDays: 7 }),
      }),
      authEnv
    );
    expect(tokenOnly.status).toBe(401);

    const agentSession = {
      id: "s1",
      agentId: "a1",
      agentName: "Agent",
      repositoryId: "r1",
      workspaceName: "ws",
      permission: "write" as const,
    };
    const agentRequest = new Request("https://auth.test/access-tokens", {
      method: "POST",
      headers: { Origin: "https://auth.test", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", scopes: ["admin"], expiresInDays: 7 }),
    });
    const denied = await handleAccessTokenManagement(agentRequest, authEnv, {
      id: "alice-id",
      identifier: "alice",
      groupKey: "free",
      agentSession,
    });
    expect(denied.status).toBe(403);
    expect((await account("/access-tokens", "POST", "gitedge_session=none", {})).status).toBe(401);
  });

  it("caps active tokens per user", async () => {
    const now = Date.now();
    const rows = Array.from(
      { length: 100 },
      (_, index) =>
        `('cap-${index}','bob-id','cap','cap-hash-${index}','gep_cap','["repo:read"]',NULL,${now + 86_400_000},NULL,NULL,${now})`
    ).join(",");
    await runSqlScript(
      env.DB,
      `INSERT INTO auth_access_tokens (id,user_id,name,token_hash,prefix,scopes_json,repository_ids_json,expires_at,last_used_at,revoked_at,created_at) VALUES ${rows};`
    );
    const refused = await account("/access-tokens", "POST", bobCookie, {
      name: "x",
      scopes: ["repo:read"],
      expiresInDays: 7,
    });
    expect(refused.status).toBe(409);
    await env.DB.prepare("UPDATE auth_access_tokens SET revoked_at = ? WHERE id = 'cap-0'")
      .bind(now)
      .run();
    await mint(bobCookie, ["repo:read"]);
    await env.DB.prepare("DELETE FROM auth_access_tokens WHERE id LIKE 'cap-%'").run();
  });
});

describe("Git credentials from personal access tokens", () => {
  it("parses Bearer and Basic credentials with any username", () => {
    expect(parseGitAuthorization("Bearer gep_x")).toEqual({ username: null, token: "gep_x" });
    expect(parseGitAuthorization(basic("whoever", "gep_x"))).toEqual({
      username: "whoever",
      token: "gep_x",
    });
    expect(parseGitAuthorization(basic("", "gep_x"))).toEqual({ username: "", token: "gep_x" });
    expect(parseGitAuthorization(`Basic ${btoa("a:b:c")}`)).toEqual({
      username: "a",
      token: "b:c",
    });
    expect(parseGitAuthorization("Basic !!!")).toBeNull();
    expect(parseGitAuthorization(`Basic ${btoa("nocolon")}`)).toBeNull();
    expect(parseGitAuthorization("Digest abc")).toBeNull();
    expect(parseGitAuthorization(null)).toBeNull();
  });

  it("grants write only to write-scoped tokens, enforces the allowlist, and ignores the username", async () => {
    const writer = await mint(aliceCookie, ["repo:write"]);
    const reader = await mint(aliceCookie, ["repo:read"]);
    const issuesOnly = await mint(aliceCookie, ["issues:write"]);
    const scoped = await mint(aliceCookie, ["repo:write"], { repositoryIds: ["r2"] });

    const grant = z.object({
      data: z.object({ permission: z.string(), repositoryId: z.string() }),
    });
    const write = await gitSession(basic("anything", writer.token), "demo");
    expect(write.status).toBe(200);
    expect(grant.parse(await write.json()).data).toEqual({
      permission: "write",
      repositoryId: "r1",
    });
    expect(
      grant.parse(await (await gitSession(basic("", reader.token), "demo")).json()).data.permission
    ).toBe("read");
    expect(
      grant.parse(await (await gitSession(basic("x", issuesOnly.token), "demo")).json()).data
        .permission
    ).toBe("read");
    expect((await gitSession(basic("x", scoped.token), "other")).status).toBe(200);
    expect((await gitSession(`Bearer ${writer.token}`, "demo")).status).toBe(200);
  });

  it("challenges only invalid credentials so Git keeps valid tokens in its helper", async () => {
    const scoped = await mint(aliceCookie, ["repo:write"], { repositoryIds: ["r2"] });
    const orgOnly = await mint(aliceCookie, ["org:read"]);
    const outsideAllowlist = await gitSession(basic("x", scoped.token), "demo");
    expect(outsideAllowlist.status).toBe(403);
    expect(await outsideAllowlist.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect((await gitSession(basic("x", orgOnly.token), "demo")).status).toBe(403);
    expect((await gitSession(basic("x", `gep_${"1".repeat(64)}`), "demo")).status).toBe(401);
    expect((await gitSession(basic("x", `gep_${"1".repeat(64)}`), "missing")).status).toBe(401);

    const bobToken = await mint(bobCookie, ["repo:write"]);
    const privateRepository = await gitSession(basic("bob", bobToken.token), "demo");
    const missingRepository = await gitSession(basic("bob", bobToken.token), "missing");
    expect(privateRepository.status).toBe(404);
    expect(missingRepository.status).toBe(404);
    expect(privateRepository.headers.get(REPOSITORY_ACCESS_DENIED_HEADER)).toBe("1");
    expect(missingRepository.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)).toBe(false);
    expect(await privateRepository.json()).toEqual(await missingRepository.json());
  });
});

describe("scope enforcement in privileged services", () => {
  const readOnly: AccessTokenIdentity = { id: "t1", scopes: ["repo:read"] };
  const issues: AccessTokenIdentity = { id: "t2", scopes: ["issues:write"] };
  const pulls: AccessTokenIdentity = { id: "t3", scopes: ["pulls:write"] };
  const admin: AccessTokenIdentity = { id: "t4", scopes: ["admin"] };
  const limited: AccessTokenIdentity = {
    id: "t5",
    scopes: ["admin"],
    repositoryIds: ["r2"],
  };

  it("lets read-only tokens read but not write through the Forge API", async () => {
    expect((await forgeRequest("/repositories/r1", "GET", readOnly)).status).toBe(200);
    const denied = await forgeRequest("/repositories/r1/issues", "POST", readOnly, {
      title: "t",
      body: "",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "insufficient_scope" } });
    expect((await forgeRequest("/organizations", "GET", readOnly)).status).toBe(403);
    expect(
      (await forgeRequest("/organizations", "POST", admin, { slug: "x-org", displayName: "X" }))
        .status
    ).not.toBe(403);
  });

  it("maps issue and pull request writes to their scopes", async () => {
    const issue = await forgeRequest("/repositories/r1/issues", "POST", issues, {
      title: "From token",
      body: "",
    });
    expect(issue.status).toBe(201);
    const pull = await forgeRequest("/repositories/r1/pull-requests", "POST", issues, {
      title: "x",
      body: "",
      baseRef: "main",
      headRef: "topic",
    });
    expect(pull.status).toBe(403);
    expect(
      (
        await forgeRequest("/repositories/r1/pull-requests", "POST", pulls, {
          title: "x",
          body: "",
          baseRef: "main",
          headRef: "topic",
        })
      ).status
    ).not.toBe(403);
    expect(
      (await forgeRequest("/repositories/r1/issues", "POST", pulls, { title: "x", body: "" }))
        .status
    ).toBe(403);
    expect((await forgeRequest("/repositories/r1/branch-rules", "POST", issues, {})).status).toBe(
      403
    );
  });

  it("limits allowlisted tokens to their repositories", async () => {
    expect((await forgeRequest("/repositories/r2", "GET", limited)).status).toBe(200);
    expect((await forgeRequest("/repositories/r1", "GET", limited)).status).toBe(403);
    expect((await forgeRequest("/repositories/by-name/alice/demo", "GET", limited)).status).toBe(
      404
    );
    expect(
      (await forgeRequest("/repositories/by-name/alice/other", "GET", limited)).status
    ).not.toBe(404);
    expect((await forgeRequest("/repositories", "GET", limited)).status).toBe(403);
  });

  it("blocks Git API writes and receive-pack for tokens without repo:write", async () => {
    const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
    const apiHeaders = trustedHeaders(identity(readOnly));
    apiHeaders.set("Content-Type", "application/json");
    const edit = await git.fetch(
      new Request("https://git.test/repositories/r1/edit", {
        method: "POST",
        headers: apiHeaders,
        body: "{}",
      }),
      gitEnv
    );
    expect(edit.status).toBe(403);
    expect(await edit.json()).toMatchObject({ error: { code: "insufficient_scope" } });

    const pushHeaders = trustedHeaders(identity(readOnly));
    pushHeaders.set(
      "X-GitEdge-Git-Grant",
      JSON.stringify({ repositoryId: "r1", permission: "write" })
    );
    const push = await git.fetch(
      new Request("https://git.test/alice/demo.git/git-receive-pack", {
        method: "POST",
        headers: pushHeaders,
        body: new Uint8Array(),
      }),
      gitEnv
    );
    expect(push.status).toBe(403);
    expect(push.headers.has("WWW-Authenticate")).toBe(false);
    expect(await push.text()).toContain("write credential");

    await env.DB.prepare("UPDATE repositories SET visibility = 'public' WHERE id = 'r2'").run();
    const anonymousPush = await git.fetch(
      new Request("https://git.test/alice/other.git/info/refs?service=git-receive-pack"),
      gitEnv
    );
    await env.DB.prepare("UPDATE repositories SET visibility = 'private' WHERE id = 'r2'").run();
    expect(anonymousPush.status).toBe(401);
    expect(anonymousPush.headers.get("WWW-Authenticate")).toBe('Basic realm="GitEdge"');
    await anonymousPush.body?.cancel();

    const otherRepo = trustedHeaders(identity(limited));
    const blocked = await git.fetch(
      new Request("https://git.test/alice/demo.git/info/refs?service=git-upload-pack", {
        headers: otherRepo,
      }),
      gitEnv
    );
    expect(blocked.status).toBe(404);
  });

  it("denies Actions pushes without repo:write and outside the allowlist", async () => {
    const actionsEnv = { DB: env.DB } as unknown as Parameters<typeof actions.fetch>[1];
    const push = (token: AccessTokenIdentity, repo: string) =>
      actions.fetch(
        new Request("https://actions.internal/internal/push", {
          method: "POST",
          headers: trustedHeaders(identity(token)),
          body: JSON.stringify({ repositoryId: repo, ref: "main", expectedOid: "a".repeat(40) }),
        }),
        actionsEnv
      );
    expect((await push(readOnly, "r1")).status).toBe(403);
    expect((await push(limited, "r1")).status).toBe(404);
    expect([403, 404]).not.toContain((await push(admin, "r1")).status);
  });
});
