import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import auth from "../../workers/auth/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};
const origin = "https://account.test";

function cookie(response: Response): string {
  const token = response.headers.get("Set-Cookie")?.match(/gitedge_session=([^;]+)/)?.[1];
  if (!token) throw new Error("Expected an authenticated session cookie.");
  return `gitedge_session=${token}`;
}

function call(path: string, method = "GET", sessionCookie = "", body?: unknown): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    authEnv
  );
}

async function register(identifier: string) {
  const response = await call("/register", "POST", "", {
    identifier,
    password: "a-valid-account-test-password",
  });
  expect(response.status).toBe(201);
  return { cookie: cookie(response), data: (await response.json()) as { data: { id: string } } };
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
});

describe("human account profile and login sessions", () => {
  it("requires authentication and changes the account name with its personal namespace", async () => {
    expect((await call("/profile")).status).toBe(401);
    const account = await register("account-owner");
    const initial = await (await call("/profile", "GET", account.cookie)).json();
    expect(initial.data).toMatchObject({
      identifier: "account-owner",
      displayName: "account-owner",
      bio: "",
      preferences: {
        theme: "system",
        locale: "zh-CN",
        density: "comfortable",
        tabSize: 2,
        lineWrap: false,
      },
    });
    const updated = await call("/profile", "PATCH", account.cookie, {
      identifier: "renamed-owner",
      displayName: "Renamed Owner",
      bio: "Hello",
      preferences: { theme: "dark", tabSize: 8 },
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({
      identifier: "renamed-owner",
      displayName: "Renamed Owner",
      bio: "Hello",
      preferences: {
        theme: "dark",
        tabSize: 8,
        locale: "zh-CN",
        density: "comfortable",
        lineWrap: false,
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT users.id, namespaces.slug FROM users JOIN namespaces ON namespaces.created_by = users.id WHERE users.id = ? AND namespaces.kind = 'personal'"
      )
        .bind(account.data.data.id)
        .first()
    ).toMatchObject({ id: account.data.data.id, slug: "renamed-owner" });
    expect((await call("/session", "GET", account.cookie)).status).toBe(200);
  });

  it("rejects namespace and reserved-route collisions without changing ownership", async () => {
    const first = await register("profile-first");
    await register("profile-taken");
    expect(
      (await call("/profile", "PATCH", first.cookie, { identifier: "profile-taken" })).status
    ).toBe(409);
    expect((await call("/profile", "PATCH", first.cookie, { identifier: "api" })).status).toBe(409);
    expect((await (await call("/profile", "GET", first.cookie)).json()).data.identifier).toBe(
      "profile-first"
    );
  });

  it("serializes concurrent claims for the same personal namespace", async () => {
    const first = await register("claim-first");
    const second = await register("claim-second");
    const results = await Promise.all([
      call("/profile", "PATCH", first.cookie, { identifier: "shared-claim" }),
      call("/profile", "PATCH", second.cookie, { identifier: "shared-claim" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const owners = await env.DB.prepare("SELECT COUNT(*) AS count FROM namespaces WHERE slug = ?")
      .bind("shared-claim")
      .first<{ count: number }>();
    expect(owners?.count).toBe(1);
  });

  it("lists browser sessions and revokes only sessions owned by the account", async () => {
    const account = await register("web-session-owner");
    const secondLogin = await call("/login", "POST", "", {
      identifier: "web-session-owner",
      password: "a-valid-account-test-password",
    });
    const secondCookie = cookie(secondLogin);
    const listed = await (await call("/web-sessions", "GET", account.cookie)).json();
    expect(listed.data).toHaveLength(2);
    expect(listed.data.filter((session: { isCurrent: boolean }) => session.isCurrent)).toHaveLength(
      1
    );
    const secondSession = listed.data.find((session: { isCurrent: boolean }) => !session.isCurrent);
    const other = await register("web-session-other");
    const otherRows = await (await call("/web-sessions", "GET", other.cookie)).json();
    expect(
      (await call(`/web-sessions/${otherRows.data[0].id}`, "DELETE", account.cookie)).status
    ).toBe(404);
    expect((await call(`/web-sessions/${secondSession.id}`, "DELETE", account.cookie)).status).toBe(
      200
    );
    expect((await call("/session", "GET", secondCookie)).status).toBe(401);
    const currentSession = listed.data.find((session: { isCurrent: boolean }) => session.isCurrent);
    const revoked = await call(`/web-sessions/${currentSession.id}`, "DELETE", account.cookie);
    expect(await revoked.json()).toEqual({ data: { revoked: true, isCurrent: true } });
    expect(revoked.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("/session", "GET", account.cookie)).status).toBe(401);
  });
});
