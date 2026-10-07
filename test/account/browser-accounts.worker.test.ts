import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { unlimitedRateLimiter } from "../support/rate-limiter";
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
  RATE_LIMITER: unlimitedRateLimiter,
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
  it("cancels pending browser authentication when the selected account changes", async () => {
    const browser = new Browser(),
      a = await user(),
      b = await user();
    await browser.add(a);
    await browser.add(b);
    browser.cookies.set("gitedge_sso", "pending-link-proof");
    browser.cookies.set("gitedge_github_flow", "pending-login-proof");
    await browser.call("/accounts/switch", "POST", { userId: a });
    expect(browser.cookies.has("gitedge_sso")).toBe(false);
    expect(browser.cookies.has("gitedge_github_flow")).toBe(false);
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
  it("removes only this browser login while preserving another browser session", async () => {
    const browser = new Browser(),
      otherBrowser = new Browser(),
      a = await user(),
      b = await user();
    await browser.add(a);
    await otherBrowser.add(a);
    await browser.add(b);
    expect(await (await browser.call(`/accounts/${a}`, "DELETE")).json()).toEqual({
      data: { removed: true, isCurrent: false },
    });
    expect((await browser.accounts()).accounts.map((account) => account.id)).toEqual([b]);
    expect((await otherBrowser.call("/session")).status).toBe(200);
    await browser.call("/accounts/logout-all", "POST");
    expect((await otherBrowser.call("/session")).status).toBe(200);
  });
  it("never reactivates expired or revoked saved logins", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    await env.DB.prepare("UPDATE auth_sessions SET expires_at=0 WHERE user_id=?").bind(a).run();
    expect((await browser.accounts()).accounts).toEqual([]);
    expect((await browser.call("/accounts/switch", "POST", { userId: a })).status).toBe(401);
  });
  it("prunes expired saved cookies so later valid accounts remain reachable", async () => {
    const browser = new Browser();
    for (let i = 0; i < 5; i++) {
      const id = await user();
      await browser.add(id);
      await env.DB.prepare("UPDATE auth_sessions SET expires_at=0 WHERE user_id=?").bind(id).run();
    }
    const survivor = await user();
    await browser.add(survivor);
    expect((await browser.accounts()).accounts.map((account) => account.id)).toEqual([survivor]);
    expect(
      [...browser.cookies.keys()].filter((name) => name.startsWith("gitedge_account_"))
    ).toHaveLength(1);
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
  it("previews anonymously without revoking the human sign-in", async () => {
    const browser = new Browser(),
      a = await user();
    await browser.add(a);
    const token = browser.cookies.get("gitedge_session");
    expect((await browser.call("/accounts/view", "POST", { kind: "guest" })).status).toBe(200);
    expect(browser.cookies.get("gitedge_session")).toBe(token);
    expect(await (await browser.call("/session")).json()).toEqual({ data: null, view: "guest" });
    expect(await (await browser.call("/browser-session")).json()).toEqual({
      data: { user: null, view: { kind: "guest" } },
    });
    expect((await browser.call("/profile")).status).toBe(403);
    expect((await browser.call("/tokens", "POST", {})).status).toBe(403);
    expect((await browser.accounts()).view.kind).toBe("guest");
    expect((await browser.call("/accounts/view", "POST", { kind: "account" })).status).toBe(200);
    expect(await (await browser.call("/session")).json()).toMatchObject({ data: { id: a } });
  });
  it("rejects the removed agent perspective and cross-origin preview changes", async () => {
    const browser = new Browser();
    await browser.add(await user());
    expect(
      (
        await browser.call("/accounts/view", "POST", {
          kind: "agent",
          sessionId: crypto.randomUUID(),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await browser.call(
          "/accounts/view",
          "POST",
          { kind: "guest" },
          { Origin: "https://outside.test" }
        )
      ).status
    ).toBe(403);
  });
  it("requires sign-in to enter preview but permits clearing it after expiry", async () => {
    const browser = new Browser();
    expect((await browser.call("/accounts/view", "POST", { kind: "guest" })).status).toBe(401);
    const a = await user();
    await browser.add(a);
    await browser.call("/accounts/view", "POST", { kind: "guest" });
    await env.DB.prepare("UPDATE auth_sessions SET expires_at=0 WHERE user_id=?").bind(a).run();
    expect(await (await browser.call("/session")).json()).toEqual({ data: null, view: "guest" });
    expect((await browser.call("/accounts/view", "POST", { kind: "account" })).status).toBe(200);
    expect((await browser.call("/session")).status).toBe(401);
  });
});
