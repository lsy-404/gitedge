import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const upstream = new URL(process.env.GITEDGE_API ?? "http://127.0.0.1:8877");
assert.equal(upstream.protocol, "http:");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname));
assert.equal(upstream.pathname, "/");
assert.equal(upstream.search, "");
assert.equal(upstream.hash, "");
const scratchRoot = path.resolve("work");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(path.join(scratchRoot, "gcm-oauth-"));
let cookie;
let authorization;
let exchange;
let refreshCount = 0;
let serverError;

async function json(endpoint, method, body) {
  const response = await fetch(new URL(endpoint, upstream), {
    method,
    redirect: "manual",
    headers: {
      Origin: upstream.origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const session = response.headers
    .getSetCookie()
    .find((item) => item.startsWith("gitedge_session="));
  if (session) cookie = session.split(";")[0];
  assert.ok(response.ok, `${endpoint.split("?")[0]} returned HTTP ${response.status}`);
  return (await response.json()).data;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
    if (request.method === "GET" && url.pathname === "/git/authorize") {
      authorization = Object.fromEntries(url.searchParams);
      assert.equal(authorization.client_id, "gitedge-gcm");
      assert.equal(authorization.response_type, "code");
      assert.equal(authorization.code_challenge_method, "S256");
      assert.ok(authorization.state);
      const redirect = new URL(authorization.redirect_uri);
      assert.equal(redirect.protocol, "http:");
      assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname));
      const details = await json(`/api/auth/git-oauth/authorize${url.search}`, "GET");
      assert.ok(details.clientName);
      const approval = await json("/api/auth/git-oauth/authorize", "POST", {
        ...authorization,
        approve: true,
      });
      const destination = new URL(approval.redirectUrl);
      assert.equal(destination.origin, redirect.origin);
      assert.equal(destination.pathname, redirect.pathname);
      assert.equal(destination.searchParams.get("state"), authorization.state);
      assert.ok(destination.searchParams.get("code"));
      response.writeHead(302, { Location: destination.href, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/auth/git-oauth/token") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const form = new URLSearchParams(body);
      assert.equal(form.get("client_id"), "gitedge-gcm");
      assert.equal(request.headers.authorization, undefined);
      if (form.get("grant_type") === "authorization_code") {
        assert.ok(authorization);
        assert.equal(form.get("redirect_uri"), authorization.redirect_uri);
        const verifier = form.get("code_verifier");
        assert.ok(verifier);
        assert.equal(
          createHash("sha256").update(verifier).digest("base64url"),
          authorization.code_challenge
        );
        exchange = true;
      } else {
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.ok(form.get("refresh_token"));
        refreshCount++;
      }
      const result = await fetch(new URL(url.pathname, upstream), {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": request.headers["content-type"] },
        body,
      });
      response.writeHead(result.status, {
        "Content-Type": result.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await result.arrayBuffer()));
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    serverError = error;
    response.writeHead(500).end();
  }
});

function gcm(command, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["credential-manager", command], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(serverError ?? new Error(`GCM ${command} failed or timed out`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}

try {
  const identifier = `verify-${randomBytes(6).toString("hex")}`;
  await json("/api/auth/register", "POST", {
    identifier,
    password: randomBytes(24).toString("base64url"),
  });
  assert.ok(cookie, "Registration must issue a browser session");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const options = {
    "credential.provider": "generic",
    "credential.credentialStore": "dpapi",
    "credential.dpapiStorePath": scratch,
    "credential.namespace": `gcm-test-${randomBytes(8).toString("hex")}`,
    "credential.oauthClientId": "gitedge-gcm",
    "credential.oauthAuthorizeEndpoint": `${origin}/git/authorize`,
    "credential.oauthTokenEndpoint": `${origin}/api/auth/git-oauth/token`,
    "credential.oauthScopes": "repo:read repo:write",
    "credential.oauthUseClientAuthHeader": "false",
  };
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(scratch, "empty-config"),
    GCM_ALLOW_HTTP: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(Object.keys(options).length),
  };
  for (const key of Object.keys(env))
    if (/^(GIT_TRACE|GIT_CURL_VERBOSE|GCM_TRACE)/.test(key)) delete env[key];
  Object.entries(options).forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  const input = `protocol=http\nhost=127.0.0.1:${server.address().port}\n\n`;
  const credential = await gcm("get", input, env);
  assert.match(credential, /(?:^|\n)password=gep_[0-9a-f]+(?:\n|$)/);
  assert.ok(exchange, "GCM must exchange an authorization code");
  const second = await gcm("get", input, env);
  assert.match(second, /(?:^|\n)password=gep_[0-9a-f]+(?:\n|$)/);
  assert.ok(refreshCount > 0, "GCM must refresh its stored refresh token");
  console.log("GCM browser authorization, PKCE and refresh passed");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
