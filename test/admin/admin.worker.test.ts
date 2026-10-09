import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  sha256Hex,
  type AdminGroup,
  type AdminPage,
  type AdminRepository,
  type AdminStats,
  type AdminUser,
  type AuditPage,
  type CreatedAccessToken,
} from "../../packages/contracts/src/index";
import {
  authCall,
  createPerson,
  createRepository,
  data,
  expireRecentAuth,
  migrate,
  type Person,
} from "../support/stack";

const password = "a-long-enough-test-password";
let root: Person;
let flagged: Person;
let plain: Person;

async function register(identifier: string): Promise<Person> {
  const response = await authCall(null, "/register", "POST", { identifier, password });
  expect(response.status).toBe(201);
  const body = await data<{ id: string; groupKey: string }>(response);
  const cookie = response.headers.get("Set-Cookie")?.match(/gitedge_session=[^;]+/)?.[0] ?? "";
  return { id: body.id, identifier, groupKey: body.groupKey, cookie };
}

async function bearer(path: string, token: string): Promise<Response> {
  return authCall(null, path, "GET", undefined, { Authorization: `Bearer ${token}` });
}

beforeAll(async () => {
  await migrate();
  root = await createPerson("root");
  flagged = await createPerson("flagged-admin");
  plain = await createPerson("plain-user");
  await env.DB.prepare("UPDATE users SET is_site_admin = 1 WHERE id = ?").bind(flagged.id).run();
});

describe("site administrator access", () => {
  it("grants administration to configured usernames and flagged users only", async () => {
    expect((await data<{ siteAdmin?: true }>(await authCall(root, "/session"))).siteAdmin).toBe(
      true
    );
    expect((await data<{ siteAdmin?: true }>(await authCall(flagged, "/session"))).siteAdmin).toBe(
      true
    );
    expect(
      (await data<{ siteAdmin?: true }>(await authCall(plain, "/session"))).siteAdmin
    ).toBeUndefined();
    expect((await authCall(plain, "/admin/users")).status).toBe(403);
    expect((await authCall(plain, "/admin/stats")).status).toBe(403);
    expect((await authCall(null, "/admin/users")).status).toBe(401);
    expect((await authCall(root, "/admin/users")).status).toBe(200);
    expect((await authCall(flagged, "/admin/repositories")).status).toBe(200);
  });

  it("refuses personal access tokens on admin routes", async () => {
    const minted = await data<CreatedAccessToken>(
      await authCall(root, "/access-tokens", "POST", {
        name: "all",
        scopes: ["admin"],
        expiresInDays: 7,
      })
    );
    expect((await bearer("/admin/users", minted.token)).status).toBe(403);
  });

  it("lists, searches and pages users and repositories and reports site statistics", async () => {
    await createRepository(plain, "listed-repo", "public");
    const everyone = await data<AdminPage<AdminUser>>(await authCall(root, "/admin/users?limit=2"));
    expect(everyone.items).toHaveLength(2);
    expect(everyone.nextCursor).not.toBeNull();
    const rest = await data<AdminPage<AdminUser>>(
      await authCall(root, `/admin/users?limit=2&cursor=${everyone.nextCursor}`)
    );
    expect(rest.items.map((user) => user.id)).not.toContain(everyone.items[0].id);
    const found = await data<AdminPage<AdminUser>>(await authCall(root, "/admin/users?q=plain"));
    expect(found.items).toEqual([
      expect.objectContaining({ identifier: "plain-user", siteAdmin: false }),
    ]);
    const rootRow = (
      await data<AdminPage<AdminUser>>(await authCall(root, "/admin/users?q=root"))
    ).items.find((user) => user.identifier === "root");
    expect(rootRow?.configuredAdmin).toBe(true);
    expect((await authCall(root, "/admin/users?q=%25")).status).toBe(200);
    expect(
      (await data<AdminPage<AdminUser>>(await authCall(root, "/admin/users?q=%25"))).items
    ).toEqual([]);

    const repositories = await data<AdminPage<AdminRepository>>(
      await authCall(root, "/admin/repositories?q=plain-user")
    );
    expect(repositories.items).toEqual([
      expect.objectContaining({ owner: "plain-user", name: "listed-repo", visibility: "public" }),
    ]);
    const stats = await data<AdminStats>(await authCall(root, "/admin/stats"));
    expect(stats.users.total).toBeGreaterThanOrEqual(3);
    expect(stats.repositories.public).toBeGreaterThanOrEqual(1);
    expect((await authCall(root, "/admin/users?cursor=bad")).status).toBe(400);
  });

  it("assigns existing user groups and the administrator flag", async () => {
    const groups = await data<AdminGroup[]>(await authCall(root, "/admin/groups"));
    expect(groups.map((group) => group.key)).toEqual(
      expect.arrayContaining(["free", "team", "admin"])
    );
    expect(
      (await authCall(root, `/admin/users/${plain.id}`, "PATCH", { groupKey: "team" })).status
    ).toBe(200);
    expect((await data<{ groupKey: string }>(await authCall(plain, "/session"))).groupKey).toBe(
      "team"
    );
    expect(
      (await authCall(root, `/admin/users/${plain.id}`, "PATCH", { groupKey: "nonexistent" }))
        .status
    ).toBe(400);
    expect((await authCall(root, `/admin/users/${plain.id}`, "PATCH", {})).status).toBe(400);
    expect(
      (await authCall(root, `/admin/users/${root.id}`, "PATCH", { siteAdmin: false })).status
    ).toBe(409);
    expect(
      (await authCall(root, `/admin/users/${plain.id}`, "PATCH", { siteAdmin: true })).status
    ).toBe(200);
    expect((await authCall(plain, "/admin/stats")).status).toBe(200);
    expect(
      (await authCall(root, `/admin/users/${plain.id}`, "PATCH", { siteAdmin: false })).status
    ).toBe(200);
    expect((await authCall(plain, "/admin/stats")).status).toBe(403);
  });

  it("requires recent authentication and a same-origin request for mutations", async () => {
    const target = await createPerson("admin-target");
    await expireRecentAuth(root);
    const stale = await authCall(root, `/admin/users/${target.id}/disable`, "POST");
    expect(stale.status).toBe(403);
    expect((await stale.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "reauth_required" },
    });
    expect((await authCall(root, "/admin/users")).status).toBe(200);
    await env.DB.prepare("UPDATE auth_sessions SET recent_auth_at = ? WHERE user_id = ?")
      .bind(Date.now(), root.id)
      .run();
    expect(
      (
        await authCall(root, `/admin/users/${target.id}/disable`, "POST", undefined, {
          Origin: "https://evil.test",
        })
      ).status
    ).toBe(403);
    expect((await authCall(root, `/admin/users/${root.id}/disable`, "POST")).status).toBe(409);
    expect((await authCall(root, `/admin/users/${target.id}/disable`, "POST")).status).toBe(200);
    expect((await authCall(root, `/admin/users/${target.id}/disable`, "POST")).status).toBe(404);
    expect((await authCall(root, `/admin/users/${target.id}/enable`, "POST")).status).toBe(200);
  });
});

describe("disabled accounts", () => {
  it("rejects every credential type and sign-in, and recovers on enable", async () => {
    const victim = await register("victim");
    const repositoryId = await createRepository(victim, "victim-repo", "public");
    const pat = await data<CreatedAccessToken>(
      await authCall(victim, "/access-tokens", "POST", {
        name: "ci",
        scopes: ["repo:write"],
        expiresInDays: 7,
      })
    );
    const agentToken = `ge_session_${"1".repeat(64)}`;
    const gitToken = `ge_token_${"2".repeat(64)}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_agents(id,user_id,name,description,created_at) VALUES('victim-agent',?,'bot','',1)"
      ).bind(victim.id),
      env.DB.prepare(
        "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,permission,status,created_at,expires_at) VALUES('victim-session','victim-agent',?,?,?,'t','fork-victim','https://r.test','main','write','active',1,?)"
      ).bind(victim.id, repositoryId, await sha256Hex(agentToken), Date.now() + 600_000),
      env.DB.prepare(
        "INSERT INTO auth_git_tokens(id,user_id,repository_id,name,token_hash,permission,expires_at,created_at) VALUES('victim-git',?,?,'laptop',?,'write',?,1)"
      ).bind(victim.id, repositoryId, await sha256Hex(gitToken), Date.now() + 600_000),
    ]);
    const gitSession = (token: string) =>
      authCall(null, "/git-session?owner=victim&repo=victim-repo", "GET", undefined, {
        Authorization: `Basic ${btoa(`victim:${token}`)}`,
      });

    expect((await authCall(victim, "/session")).status).toBe(200);
    expect((await bearer("/session", pat.token)).status).toBe(200);
    expect((await bearer("/session", agentToken)).status).toBe(200);
    expect((await gitSession(gitToken)).status).toBe(200);
    expect((await gitSession(pat.token)).status).toBe(200);
    expect((await gitSession(agentToken)).status).toBe(200);

    expect((await authCall(root, `/admin/users/${victim.id}/disable`, "POST")).status).toBe(200);

    expect((await authCall(victim, "/session")).status).toBe(401);
    expect((await authCall(victim, "/browser-session")).status).toBe(200);
    expect(
      (await data<{ user: unknown }>(await authCall(victim, "/browser-session"))).user
    ).toBeNull();
    expect((await bearer("/session", pat.token)).status).toBe(401);
    expect((await bearer("/session", agentToken)).status).toBe(401);
    expect((await gitSession(gitToken)).status).toBe(401);
    expect((await gitSession(pat.token)).status).toBe(401);
    expect((await gitSession(agentToken)).status).toBe(401);
    const login = await authCall(null, "/login", "POST", { identifier: "victim", password });
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ error: { code: "account_disabled" } });
    expect(
      (
        await authCall(null, "/login", "POST", {
          identifier: "victim",
          password: "wrong-password-xx",
        })
      ).status
    ).toBe(401);
    expect((await authCall(victim, "/audit-log")).status).toBe(401);

    expect((await authCall(root, `/admin/users/${victim.id}/enable`, "POST")).status).toBe(200);
    const again = await authCall(null, "/login", "POST", { identifier: "victim", password });
    expect(again.status).toBe(200);
    expect((await bearer("/session", pat.token)).status).toBe(200);
    expect((await bearer("/session", agentToken)).status).toBe(200);
    expect((await gitSession(gitToken)).status).toBe(200);

    const cookie = again.headers.get("Set-Cookie")?.match(/gitedge_session=[^;]+/)?.[0] ?? "";
    const log = await data<AuditPage>(await authCall({ cookie }, "/audit-log"));
    expect(log.events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["admin.user_disabled", "admin.user_enabled"])
    );
  });
});
