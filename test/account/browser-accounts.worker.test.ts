import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";
import auth from "../../workers/auth/src/index";
import { issueSession, hashToken } from "../../workers/auth/src/session";
import { rememberBrowserLogin } from "../../workers/auth/src/browser-accounts";
import type { BrowserAccounts } from "../../packages/contracts/src/browser-accounts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const origin = "https://accounts.test";
const authEnv = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};
class Browser {
  cookies = new Map<string, string>();
  header() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  accept(response: Response) {
    for (const value of response.headers.getSetCookie()) {
      const entry = value.split(";", 1)[0];
      const index = entry.indexOf("=");
      const key = entry.slice(0, index);
      if (value.includes("Max-Age=0")) this.cookies.delete(key);
      else this.cookies.set(key, entry.slice(index + 1));
    }
  }
  async call(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
    const result = await auth.fetch(
      new Request(origin + path, {
        method,
        headers: { Cookie: this.header(), Origin: origin, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      authEnv
    );
    this.accept(result);
    return result;
  }
  async add(userId: string) {
    const token = await issueSession(authEnv, userId);
    const response = await rememberBrowserLogin(
      new Request(origin + "/login", { headers: { Cookie: this.header() } }),
      authEnv,
      userId,
      token,
      Response.json({ data: { id: userId } })
    );
    this.accept(response);
    return response;
  }
  async accounts(): Promise<BrowserAccounts> {
    const result = await this.call("/accounts");
    expect(result.status).toBe(200);
    const payload: { data: BrowserAccounts } = await result.json();
    return payload.data;
  }
}
async function user() {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)"
  )
    .bind(id, `account-${id.slice(0, 8)}`, "", "", Date.now())
    .run();
  return id;
}
async function agentFixture(userId: string, permission = "write") {
  const namespaceId = crypto.randomUUID(),
    repoId = crypto.randomUUID(),
    agentId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO namespaces(id,slug,created_by,created_at) VALUES(?,?,?,?)").bind(
      namespaceId,
      `ns-${namespaceId}`,
      userId,
      1
    ),
    env.DB.prepare(
      "INSERT INTO namespace_memberships(namespace_id,user_id,created_at,role) VALUES(?,?,1,'owner')"
    ).bind(namespaceId, userId),
    env.DB.prepare(
      "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES(?,?,?,'code',?,'private','',1,1)"
    ).bind(repoId, namespaceId, userId, repoId),
    env.DB.prepare(
      "INSERT INTO auth_agents(id,user_id,name,handle,description,created_at) VALUES(?,?,?,'reviewer','',1)"
    ).bind(agentId, userId, `Agent ${agentId}`),
    env.DB.prepare(
      "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,permission,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?)"
    ).bind(
      sessionId,
      agentId,
      userId,
      repoId,
      sessionId,
      sessionId,
      sessionId,
      "https://git.test/repo",
      "main",
      permission,
      Date.now(),
      Date.now() + 60000
    ),
  ]);
  return { namespaceId, repoId, agentId, sessionId };
}
beforeAll(async () => {
  for (const key of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[key]);
});

describe("Browser account isolation", () => {
  it("retains independent accounts and switches without exposing tokens", async () => {
    const browser = new Browser(),
      a = await user(),
      b = await user();
    const first = await browser.add(a);
    expect(
      first.headers
        .getSetCookie()
        .some(
          (value) =>
            value.includes("Path=/api/auth") &&
            value.includes("HttpOnly") &&
            value.includes("SameSite=None")
        )
    ).toBe(true);
    await browser.add(b);
    expect((await browser.accounts()).accounts.map((account) => account.id)).toEqual([b, a]);
    const token = browser.cookies.get("gitedge_session");
    expect(JSON.stringify(await browser.accounts())).not.toContain(token);
    expect((await browser.call("/accounts/switch", "POST", { userId: a })).status).toBe(200);
    expect(await (await browser.call("/session")).json()).toMatchObject({ data: { id: a } });
    expect(
      (await browser.call("/accounts/switch", "POST", { userId: crypto.randomUUID() })).status
    ).toBe(401);
  });
  it("keeps the previous login after a failed password attempt and rejects login CSRF", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    expect(
      (
        await browser.call("/login", "POST", {
          identifier: "not-present",
          password: "a-long-fixture-password",
        })
      ).status
    ).toBe(401);
    expect((await browser.accounts()).activeAccountId).toBe(a);
    expect(
      (await browser.call("/login", "POST", {}, { Origin: "https://outside.test" })).status
    ).toBe(403);
    expect(
      (await browser.call("/logout", "POST", {}, { Origin: "https://outside.test" })).status
    ).toBe(403);
  });
  it("caps saved accounts and revokes the unused new credential", async () => {
    const browser = new Browser();
    for (let i = 0; i < 5; i++) await browser.add(await user());
    const extra = await user();
    expect((await browser.add(extra)).status).toBe(409);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?"
    )
      .bind(extra)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });
  it("logs out only the active account and supports logout of every saved login", async () => {
    const browser = new Browser(),
      a = await user(),
      b = await user();
    await browser.add(a);
    await browser.add(b);
    expect((await browser.call("/logout", "POST")).status).toBe(200);
    expect((await browser.accounts()).accounts.map((account) => account.id)).toEqual([a]);
    expect((await browser.call("/accounts/switch", "POST", { userId: a })).status).toBe(200);
    await browser.call("/accounts/logout-all", "POST");
    expect((await browser.accounts()).accounts).toEqual([]);
  });
  it("never reactivates expired or revoked saved logins", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    await env.DB.prepare("UPDATE auth_sessions SET expires_at=0 WHERE user_id=?").bind(a).run();
    expect((await browser.accounts()).accounts).toEqual([]);
    expect((await browser.call("/accounts/switch", "POST", { userId: a })).status).toBe(401);
  });
  it("refreshes the same account without retaining its old token", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    const previous = browser.cookies.get("gitedge_session") ?? "";
    await browser.add(a);
    expect((await browser.accounts()).accounts).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT user_id FROM auth_sessions WHERE token_hash=?")
        .bind(await hashToken(previous))
        .first()
    ).toBeNull();
  });
  it("guards cross-tab account changes and rejects cross-origin selection", async () => {
    const browser = new Browser(),
      a = await user(),
      b = await user();
    await browser.add(a);
    await browser.add(b);
    expect(
      (await browser.call("/profile", "GET", undefined, { "X-GitEdge-Expected-User": a })).status
    ).toBe(409);
    expect(
      (
        await browser.call(
          "/accounts/switch",
          "POST",
          { userId: a },
          { Origin: "https://outside.test" }
        )
      ).status
    ).toBe(403);
  });
  it("restricts agent views to existing owned sessions and rechecks revocation", async () => {
    const browser = new Browser(),
      a = await user(),
      b = await user();
    await browser.add(a);
    const own = await agentFixture(a),
      foreign = await agentFixture(b);
    expect((await browser.accounts()).agentViews.map((view) => view.sessionId)).toEqual([
      own.sessionId,
    ]);
    expect(
      (
        await browser.call("/accounts/view", "POST", {
          kind: "agent",
          sessionId: foreign.sessionId,
        })
      ).status
    ).toBe(403);
    expect(
      (await browser.call("/accounts/view", "POST", { kind: "agent", sessionId: own.sessionId }))
        .status
    ).toBe(200);
    expect(await (await browser.call("/session")).json()).toMatchObject({
      data: { id: a, agentSession: { id: own.sessionId, repositoryId: own.repoId } },
    });
    expect((await browser.call("/tokens", "POST", {})).status).toBe(403);
    await env.DB.prepare("UPDATE auth_agent_sessions SET status='revoked' WHERE id=?")
      .bind(own.sessionId)
      .run();
    expect((await browser.call("/session")).status).toBe(401);
    expect((await browser.call("/accounts/view", "POST", { kind: "account" })).status).toBe(200);
    expect(await (await browser.call("/session")).json()).toMatchObject({ data: { id: a } });
  });
  it("rechecks membership and feature gates", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    const own = await agentFixture(a);
    await browser.call("/accounts/view", "POST", { kind: "agent", sessionId: own.sessionId });
    await env.DB.prepare("UPDATE repositories SET agents_enabled=0 WHERE id=?")
      .bind(own.repoId)
      .run();
    expect((await browser.call("/session")).status).toBe(401);
    await env.DB.prepare("UPDATE repositories SET agents_enabled=1 WHERE id=?")
      .bind(own.repoId)
      .run();
    await env.DB.prepare("DELETE FROM namespace_memberships WHERE namespace_id=?")
      .bind(own.namespaceId)
      .run();
    expect((await browser.call("/session")).status).toBe(401);
  });
});
