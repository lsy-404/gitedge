import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const credentialsPath = process.env.VOIDCARVE_TEST_CREDENTIALS;
assert.ok(
  credentialsPath,
  "Set VOIDCARVE_TEST_CREDENTIALS to a synthetic account credential file."
);
const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
assert.match(credentials.username, /^gitedge_sso_[a-f0-9]+$/);
const gitOrigin = "https://gitedge.voidcarve.com";
const idOrigin = "https://id.voidcarve.com";
const cookies = new Map();
const result = { startedAt: new Date().toISOString(), checks: {} };
const stage = process.env.VOIDCARVE_TEST_STAGE ?? "full";
assert.ok(["denied", "login", "full"].includes(stage));
const resultPath = process.env.VOIDCARVE_TEST_RESULT;
assert.ok(resultPath, "Set VOIDCARVE_TEST_RESULT to a private output file.");

async function request(url, body) {
  const target = new URL(url);
  assert.ok([gitOrigin, idOrigin].includes(target.origin), "Unexpected request origin.");
  const jar = cookies.get(target.origin) ?? new Map();
  const headers = { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; ") };
  if (body !== undefined) {
    headers.Origin = target.origin;
    headers["Content-Type"] =
      target.origin === idOrigin ? "application/x-www-form-urlencoded" : "application/json";
  }
  const response = await fetch(target, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body:
      body === undefined
        ? undefined
        : target.origin === idOrigin
          ? new URLSearchParams(body)
          : JSON.stringify(body),
    redirect: "manual",
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const key = pair.slice(0, separator);
    const content = pair.slice(separator + 1);
    if (!content || /max-age=0/i.test(value)) jar.delete(key);
    else jar.set(key, content);
  }
  cookies.set(target.origin, jar);
  return response;
}

try {
  const providers = await (await request(`${gitOrigin}/api/auth/sso/providers`)).json();
  assert.ok(providers.data.some((provider) => provider.id === "voidcarve"));
  result.checks.providerVisible = true;
  const login = await request(`${idOrigin}/auth/password`, {
    username: credentials.username,
    password: credentials.password,
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).ok, true);
  const start = await request(`${gitOrigin}/api/auth/sso/voidcarve/start`);
  assert.equal(start.status, 302);
  const authorization = new URL(start.headers.get("location"));
  assert.equal(authorization.origin, idOrigin);
  assert.equal(authorization.pathname, "/oauth/authorize");
  assert.equal(authorization.searchParams.get("client_id"), "gitedge-production");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("scope"), "openid profile email");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    `${gitOrigin}/api/auth/sso/voidcarve/callback`
  );
  result.checks.pkceAndExactCallback = true;
  const badRedirect = new URL(authorization);
  badRedirect.searchParams.set("redirect_uri", "https://example.invalid/callback");
  const rejected = await request(badRedirect);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers.get("location"), null);
  result.checks.unregisteredRedirectRejected = true;
  const authorized = await request(authorization);
  if (stage === "denied") {
    assert.equal(authorized.status, 302);
    const denial = new URL(authorized.headers.get("location"));
    assert.equal(denial.origin, gitOrigin);
    assert.equal(denial.searchParams.get("error"), "access_denied");
    assert.equal(denial.searchParams.has("code"), false);
    result.checks.unassignedAccountDenied = true;
  } else {
    assert.equal(authorized.status, 302);
    const callback = new URL(authorized.headers.get("location"));
    assert.equal(callback.origin, gitOrigin);
    assert.equal(callback.pathname, "/api/auth/sso/voidcarve/callback");
    assert.ok(callback.searchParams.get("code"));
    const completed = await request(callback);
    assert.equal(completed.status, 303);
    assert.equal(completed.headers.get("location"), "/dashboard");
    const session = await request(`${gitOrigin}/api/auth/session`);
    assert.equal(session.status, 200);
    const account = (await session.json()).data;
    result.accountId = account.id;
    const identities = (await (await request(`${gitOrigin}/api/auth/sso/identities`)).json()).data;
    const identity = identities.find((entry) => entry.providerId === "voidcarve");
    assert.ok(identity);
    result.checks.productionLoginAndLinkedIdentity = true;
    const services = await request(`${idOrigin}/auth/services`);
    assert.equal(services.status, 200);
    const catalog = await services.json();
    assert.ok(JSON.stringify(catalog).includes("gitedge-production"));
    result.checks.identityServiceCatalog = true;
    if (stage === "full") {
      const logoutResponse = await request(`${gitOrigin}/api/auth/sso/voidcarve/logout`, {
        identityId: identity.id,
      });
      assert.equal(logoutResponse.status, 200);
      const target = (await logoutResponse.json()).data.url;
      const confirmation = await request(target);
      assert.equal(confirmation.status, 200);
      const html = await confirmation.text();
      const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
      assert.ok(action);
      const confirmationUrl = new URL(action);
      assert.equal(confirmationUrl.searchParams.get("client_id"), "gitedge-production");
      assert.equal(
        confirmationUrl.searchParams.get("post_logout_redirect_uri"),
        `${gitOrigin}/api/auth/sso/voidcarve/logout-callback`
      );
      assert.equal(
        confirmationUrl.searchParams.get("state"),
        new URL(target).searchParams.get("state")
      );
      const signedOut = await request(confirmationUrl, {});
      assert.equal(signedOut.status, 302);
      const logoutCallback = new URL(signedOut.headers.get("location"));
      assert.equal(logoutCallback.origin, gitOrigin);
      const logoutCompleted = await request(logoutCallback);
      assert.equal(logoutCompleted.status, 303);
      assert.equal(logoutCompleted.headers.get("location"), "/login");
      assert.equal((await request(`${gitOrigin}/api/auth/session`)).status, 401);
      assert.equal((await request(`${idOrigin}/auth/session`)).status, 401);
      result.checks.productionSingleLogout = true;
    }
  }
  result.completed = true;
} catch (error) {
  result.completed = false;
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await request(`${gitOrigin}/api/auth/logout`, {});
  await request(`${idOrigin}/auth/logout`, {});
  result.finishedAt = new Date().toISOString();
  await writeFile(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
