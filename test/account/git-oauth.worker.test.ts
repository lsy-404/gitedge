import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { gitOAuthAuthorize, gitOAuthToken } from "../../workers/auth/src/git-oauth";
import { authenticateAccessToken } from "../../workers/auth/src/access-tokens";
import { runSqlScript } from "../support/database";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const user = {
  id: "oauth-user",
  identifier: "oauth-user",
  groupKey: "free",
  recentAuthAt: Date.now(),
};
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
let params: Record<string, string>;
function authorization(method: string, body?: unknown, origin = "https://auth.test") {
  const url = new URL("https://auth.test/git-oauth/authorize");
  if (method === "GET") url.search = new URLSearchParams(params).toString();
  return gitOAuthAuthorize(
    new Request(url, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    user
  );
}
function token(body: Record<string, string>) {
  const form = new URLSearchParams({ client_id: "gitedge-gcm", ...body }).toString();
  return gitOAuthToken(
    new Request("https://auth.test/git-oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(form.length),
      },
      body: form,
    }),
    env
  );
}
async function code() {
  const response = await authorization("POST", { ...params, approve: true });
  expect(response.status).toBe(200);
  const json = (await response.json()) as { data: { redirectUrl: string } };
  return new URL(json.data.redirectUrl).searchParams.get("code")!;
}
beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  await runSqlScript(
    env.DB,
    "INSERT INTO users (id,identifier,password_salt,password_hash,created_at) VALUES ('oauth-user','oauth-user','x','x',1);"
  );
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  params = {
    client_id: "gitedge-gcm",
    redirect_uri: "http://127.0.0.1:49200/",
    response_type: "code",
    scope: "repo:read repo:write",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
});
describe("Git OAuth", () => {
  it("authorizes, rotates once and revokes access and refresh together", async () => {
    expect((await authorization("GET")).status).toBe(200);
    expect(
      (await authorization("POST", { ...params, approve: true }, "https://evil.test")).status
    ).toBe(403);
    const authorizationCode = await code();
    const form = {
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: params.redirect_uri,
      code_verifier: verifier,
    };
    const first = await token(form);
    expect(first.status).toBe(200);
    const result = (await first.json()) as { access_token: string; refresh_token: string };
    expect(await authenticateAccessToken(env, result.access_token)).not.toBeNull();
    expect((await token(form)).status).toBe(400);
    const rotated = await token({
      grant_type: "refresh_token",
      refresh_token: result.refresh_token,
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    expect(await authenticateAccessToken(env, result.access_token)).toBeNull();
    expect(await authenticateAccessToken(env, next.access_token)).not.toBeNull();
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: result.refresh_token })).status
    ).toBe(400);
    await env.DB.prepare("UPDATE auth_access_tokens SET revoked_at=? WHERE user_id=?")
      .bind(Date.now(), user.id)
      .run();
    expect(
      (await token({ grant_type: "refresh_token", refresh_token: next.refresh_token })).status
    ).toBe(400);
  });
  it("rejects untrusted redirects and scopes", async () => {
    expect(
      (
        await authorization("POST", {
          ...params,
          redirect_uri: "http://127.0.0.1:49200/evil",
          approve: true,
        })
      ).status
    ).toBe(400);
    expect((await authorization("POST", { ...params, scope: "admin", approve: true })).status).toBe(
      400
    );
  });
});

describe("Git OAuth replay protection", () => {
  it("allows one concurrent code redemption and rejects invalid PKCE", async () => {
    const authCode = await code();
    const form = {
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: params.redirect_uri,
      code_verifier: verifier,
    };
    const responses = await Promise.all([token(form), token(form)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const nextCode = await code();
    expect((await token({ ...form, code: nextCode, code_verifier: "x".repeat(43) })).status).toBe(
      400
    );
    expect((await token({ ...form, code: nextCode })).status).toBe(400);
  });
});
