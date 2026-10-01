import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import auth from "../../workers/auth/src/index";
import { FixtureArtifacts } from "../support/artifacts";
import { runSqlScript } from "../support/database";
import { FixtureOidc } from "../support/oidc";

const migrations = import.meta.glob<string>("../../migrations/000*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const origin = "https://gitedge.example.test";
let fixture: FixtureOidc;
const userSchema = z.object({ data: z.object({ id: z.string(), identifier: z.string() }) });
const identityListSchema = z.object({
  data: z.array(z.object({ id: z.string(), providerId: z.string(), email: z.string().nullable() })),
});
const environment: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: new FixtureArtifacts(),
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
};

function configured(allowSignup = true): Parameters<typeof auth.fetch>[1] {
  return {
    ...environment,
    SSO_PROVIDERS_JSON: JSON.stringify([
      {
        id: "enterprise",
        label: "Enterprise",
        protocol: "oidc",
        issuer: fixture.issuer,
        clientId: fixture.clientId,
        tokenAuthMethod: "none",
        allowSignup,
      },
    ]),
  };
}
function cookie(response: Response, name = "gitedge_session"): string {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${name}=`))
      ?.split(";")[0] ?? ""
  );
}
function call(
  path: string,
  method = "GET",
  sessionCookie = "",
  body?: unknown,
  config = configured()
): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    config
  );
}
async function flow(
  subject: string,
  options: {
    sessionCookie?: string;
    link?: boolean;
    claims?: Record<string, string | number | boolean>;
    allowSignup?: boolean;
  } = {}
) {
  vi.stubGlobal("fetch", fixture.fetch);
  const config = configured(options.allowSignup ?? true);
  const response = await call(
    options.link ? "/sso/enterprise/link" : "/sso/enterprise/start?returnTo=/dashboard",
    options.link ? "POST" : "GET",
    options.sessionCookie,
    options.link ? { returnTo: "/settings/account" } : undefined,
    config
  );
  expect(response.status).toBe(options.link ? 200 : 302);
  const authorize = options.link
    ? z.object({ data: z.object({ url: z.string() }) }).parse(await response.json()).data.url
    : response.headers.get("Location");
  if (!authorize) throw new Error("Missing authorization redirect");
  const authorization = new URL(authorize);
  const state = authorization.searchParams.get("state");
  const proof = cookie(response, "gitedge_sso");
  fixture.idToken = await fixture.sign({
    iss: fixture.issuer,
    sub: subject,
    aud: fixture.clientId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: authorization.searchParams.get("nonce") ?? "",
    name: "Fixture User",
    email: "shared@example.test",
    email_verified: true,
    ...options.claims,
  });
  const callback = (browserCookie = proof) =>
    auth.fetch(
      new Request(`${origin}/sso/enterprise/callback?code=one-time-code&state=${state}`, {
        headers: { Cookie: browserCookie },
      }),
      config
    );
  return { response, callback, proof, state };
}
async function user(response: Response) {
  const sessionCookie = cookie(response);
  expect(sessionCookie).not.toBe("");
  return {
    sessionCookie,
    ...userSchema.parse(await (await call("/session", "GET", sessionCookie)).json()).data,
  };
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  fixture = await FixtureOidc.create();
});
afterEach(() => vi.unstubAllGlobals());

describe("SSO account and callback boundaries", () => {
  it("lists configured protocols without credentials and validates return paths", async () => {
    expect(await (await call("/sso/providers")).json()).toEqual({
      data: [{ id: "enterprise", label: "Enterprise", protocol: "oidc" }],
    });
    expect((await call("/sso/enterprise/start?returnTo=https://outside.test")).status).toBe(400);
    expect(
      (
        await call("/sso/providers", "GET", "", undefined, {
          ...environment,
          SSO_PROVIDERS_JSON: "bad config",
        })
      ).status
    ).toBe(503);
  });
  it("binds callbacks to their browser and consumes authorization once under concurrency", async () => {
    const started = await flow("first-subject");
    expect((await started.callback("")).status).toBe(400);
    expect((await started.callback("gitedge_sso=another-browser")).status).toBe(400);
    const count = fixture.tokenRequests.length;
    const results = await Promise.all([started.callback(), started.callback()]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 400]);
    expect(fixture.tokenRequests.length - count).toBe(1);
    const accepted = results.find((r) => r.status === 303);
    if (!accepted) throw new Error("No successful callback");
    const account = await user(accepted);
    const membership = await env.DB.prepare(
      "SELECT role FROM namespace_memberships WHERE user_id = ?"
    )
      .bind(account.id)
      .first<{ role: string }>();
    expect(membership?.role).toBe("owner");
    expect((await started.callback()).status).toBe(400);
    const again = await flow("first-subject", { claims: { name: "Changed display name" } });
    expect((await user(await again.callback())).id).toBe(account.id);
    const sameEmail = await flow("another-subject");
    expect((await user(await sameEmail.callback())).id).not.toBe(account.id);
  });
  it.each([
    { name: "issuer", claim: { iss: "https://wrong.example.test" } },
    { name: "audience", claim: { aud: "wrong-client" } },
    { name: "nonce", claim: { nonce: "wrong-nonce" } },
    { name: "expiry", claim: { exp: 1 } },
  ])("rejects a signed token with wrong $name", async ({ name, claim }) => {
    const started = await flow(`invalid-${name}`, { claims: claim });
    const response = await started.callback();
    expect(response.headers.get("Location")).toBe("/dashboard?error=sso_invalid_response");
    expect(cookie(response)).toBe("");
  });
  it("rejects expired state and token signatures without creating a login", async () => {
    const expired = await flow("expired-state");
    await env.DB.prepare("UPDATE auth_sso_requests SET expires_at=0").run();
    expect((await expired.callback()).status).toBe(400);
    const forged = await flow("forged-signature");
    const segments = fixture.idToken.split(".");
    segments[2] = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
    fixture.idToken = segments.join(".");
    const response = await forged.callback();
    expect(response.headers.get("Location")).toContain("sso_invalid_response");
    expect(cookie(response)).toBe("");
  });
  it("keeps existing account ownership when linking and requires a remaining login method", async () => {
    const registered = await call("/register", "POST", "", {
      identifier: "sso-existing-owner",
      password: "a-valid-fixture-password",
    });
    const account = await user(registered);
    const passwordLogin = await call("/login", "POST", "", {
      identifier: "sso-existing-owner",
      password: "a-valid-fixture-password",
    });
    expect((await user(passwordLogin)).id).toBe(account.id);

    const linked = await flow("linked-subject", {
      link: true,
      sessionCookie: account.sessionCookie,
    });
    expect((await linked.callback()).headers.get("Location")).toBe("/settings/account?sso=linked");
    const login = await flow("linked-subject");
    expect((await user(await login.callback())).id).toBe(account.id);
    const ids = identityListSchema.parse(
      await (await call("/sso/identities", "GET", account.sessionCookie)).json()
    ).data;
    expect(ids).toHaveLength(1);
    expect(
      (await call(`/sso/identities/${ids[0].id}`, "DELETE", account.sessionCookie)).status
    ).toBe(200);
    const fresh = await flow("passwordless-subject");
    const passwordless = await user(await fresh.callback());
    const only = identityListSchema.parse(
      await (await call("/sso/identities", "GET", passwordless.sessionCookie)).json()
    ).data[0];
    expect(
      (await call(`/sso/identities/${only.id}`, "DELETE", passwordless.sessionCookie)).status
    ).toBe(409);
    const second = await flow("second-passwordless-subject", {
      link: true,
      sessionCookie: passwordless.sessionCookie,
    });
    expect((await second.callback()).status).toBe(303);
    const identities = identityListSchema.parse(
      await (await call("/sso/identities", "GET", passwordless.sessionCookie)).json()
    ).data;
    const concurrent = await Promise.all(
      identities.map((identity) =>
        call(`/sso/identities/${identity.id}`, "DELETE", passwordless.sessionCookie)
      )
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("rejects takeover, cross-site links, agent identities, and logged-out linking sessions", async () => {
    const existing = await flow("already-owned");
    const owner = await user(await existing.callback());
    const registered = await call("/register", "POST", "", {
      identifier: "sso-other-owner",
      password: "another-valid-fixture-password",
    });
    const other = await user(registered);
    const conflicting = await flow("already-owned", {
      link: true,
      sessionCookie: other.sessionCookie,
    });
    expect((await conflicting.callback()).headers.get("Location")).toContain("sso_identity_in_use");
    const original = await env.DB.prepare(
      "SELECT user_id FROM auth_sso_identities WHERE subject='already-owned'"
    ).first<{ user_id: string }>();
    expect(original?.user_id).toBe(owner.id);
    expect(
      (
        await auth.fetch(
          new Request(`${origin}/sso/enterprise/link`, {
            method: "POST",
            headers: { Origin: "https://outside.test", Cookie: other.sessionCookie },
          }),
          configured()
        )
      ).status
    ).toBe(403);
    expect(
      (
        await auth.fetch(
          new Request(`${origin}/sso/identities`, {
            headers: { Cookie: other.sessionCookie, Authorization: "Bearer ge_session_not-human" },
          }),
          configured()
        )
      ).status
    ).toBe(401);
    const stale = await flow("stale-link", { link: true, sessionCookie: other.sessionCookie });
    await call("/logout", "POST", other.sessionCookie);
    expect((await stale.callback()).headers.get("Location")).toContain("sso_expired");
  });
  it("allows established identities while disabled signup prevents new provisioning", async () => {
    const denied = await flow("new-disabled-subject", { allowSignup: false });
    expect((await denied.callback()).headers.get("Location")).toContain("sso_signup_disabled");
    const established = await flow("first-subject", { allowSignup: false });
    expect(cookie(await established.callback())).not.toBe("");
  });
});

it("ends the local session before provider logout and accepts the return state once", async () => {
  const started = await flow("logout-subject");
  const account = await user(await started.callback());
  const identities = identityListSchema.parse(
    await (await call("/sso/identities", "GET", account.sessionCookie)).json()
  ).data;
  const response = await call("/sso/enterprise/logout", "POST", account.sessionCookie, {
    identityId: identities[0].id,
  });
  expect(response.status).toBe(200);
  const data = z
    .object({ data: z.object({ url: z.string(), providerLogoutUnavailable: z.boolean() }) })
    .parse(await response.json()).data;
  expect(data.providerLogoutUnavailable).toBe(false);
  const target = new URL(data.url);
  expect(target.origin).toBe(fixture.issuer);
  expect(target.searchParams.get("post_logout_redirect_uri")).toBe(
    `${origin}/api/auth/sso/enterprise/logout-callback`
  );
  expect((await call("/session", "GET", account.sessionCookie)).status).toBe(401);
  expect(
    response.headers
      .getSetCookie()
      .some((value) => value.startsWith("gitedge_session=;") && value.includes("Max-Age=0"))
  ).toBe(true);
  const callback = () =>
    call(
      `/sso/enterprise/logout-callback?state=${target.searchParams.get("state")}`,
      "GET",
      cookie(response, "gitedge_sso")
    );
  expect((await callback()).headers.get("Location")).toBe("/login");
  expect((await callback()).status).toBe(400);
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = ?")
        .bind(account.id)
        .first<{ count: number }>()
    )?.count
  ).toBe(0);
});

it("keeps local logout effective when the provider cannot be reached", async () => {
  const started = await flow("logout-unavailable");
  const account = await user(await started.callback());
  const identities = identityListSchema.parse(
    await (await call("/sso/identities", "GET", account.sessionCookie)).json()
  ).data;
  vi.stubGlobal("fetch", async () => {
    throw new Error("Provider unavailable");
  });
  const response = await call("/sso/enterprise/logout", "POST", account.sessionCookie, {
    identityId: identities[0].id,
  });
  expect(await response.json()).toEqual({ data: { url: null, providerLogoutUnavailable: true } });
  expect((await call("/session", "GET", account.sessionCookie)).status).toBe(401);
});

it("rejects unusable usernames and leaves no account behind on namespace collision", async () => {
  for (const identifier of ["person@example.test", "nested/name", "with space"])
    expect(
      (await call("/register", "POST", "", { identifier, password: "a-valid-fixture-password" }))
        .status
    ).toBe(400);
  const owner = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
  if (!owner) throw new Error("Missing fixture owner");
  await env.DB.prepare(
    "INSERT INTO namespaces (id,slug,created_by,created_at,kind,display_name,description) VALUES ('collision','existing-organization',?,1,'organization','Existing','')"
  )
    .bind(owner.id)
    .run();
  expect(
    (
      await call("/register", "POST", "", {
        identifier: "existing-organization",
        password: "a-valid-fixture-password",
      })
    ).status
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT id FROM users WHERE identifier='existing-organization'").first()
  ).toBeNull();
});
