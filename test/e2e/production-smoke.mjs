import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gatewayConfig = JSON.parse(
  await readFile(path.join(projectRoot, "workers/gateway/wrangler.jsonc"), "utf8")
);
const configuredHost = gatewayConfig.routes?.find(
  (route) => route.custom_domain && typeof route.pattern === "string"
)?.pattern;
assert.ok(configuredHost, "Gateway wrangler.jsonc must define a custom HTTPS domain route.");

const origin = new URL(process.env.GITEDGE_PRODUCTION_URL ?? `https://${configuredHost}`);
assert.equal(origin.protocol, "https:", "Production smoke requires an HTTPS Gateway URL.");
assert.equal(origin.hostname, configuredHost, "Target must match the Gateway custom domain.");
assert.equal(origin.username, "");
assert.equal(origin.password, "");
assert.equal(origin.port, "");
assert.equal(origin.pathname, "/", "Production URL must be an origin without a path.");
assert.equal(origin.search, "");
assert.equal(origin.hash, "");

const visibility = process.env.GITEDGE_REPOSITORY_VISIBILITY ?? "private";
assert.ok(["private", "public"].includes(visibility), "Visibility must be private or public.");
const suffix = randomBytes(6).toString("hex");
const identifier = `acceptance-${suffix}`;
const password = randomBytes(32).toString("base64url");
const repositorySlug = `production-smoke-${suffix}`;
const rootDirectory = path.join(projectRoot, "work", "production-smoke", suffix);
const credentialsPath = path.join(rootDirectory, "credentials.json");
const resultPath = path.join(rootDirectory, "result.json");
const secrets = [password];
const result = {
  startedAt: new Date().toISOString(),
  origin: origin.origin,
  visibility,
  checks: {},
};
let cookie = "";
let credentials = { identifier, password, cookie, token: null, tokenId: null };
let repositoryUrl = null;

function redact(text) {
  return secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
}

async function persistCredentials() {
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
}

async function persistResult() {
  result.finishedAt = new Date().toISOString();
  if (repositoryUrl) result.repositoryUrl = repositoryUrl;
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await chmod(resultPath, 0o600);
}

async function api(endpoint, method = "GET", body, options = {}) {
  const headers = { Accept: "application/json", Origin: origin.origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (options.anonymous !== true && cookie) headers.Cookie = cookie;
  const response = await fetch(new URL(endpoint, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";", 1)[0];
    credentials.cookie = cookie;
    secrets.push(cookie);
    await persistCredentials();
  }
  const text = await response.text();
  if (options.status !== undefined) {
    assert.equal(response.status, options.status, `${method} ${endpoint}: ${redact(text)}`);
  } else {
    assert.ok(response.ok, `${method} ${endpoint}: HTTP ${response.status} ${redact(text)}`);
  }
  if (!text) return undefined;
  const payload = JSON.parse(text);
  return "data" in payload ? payload.data : payload;
}

function basicAuthorization(token) {
  const authorization = `Basic ${Buffer.from(`${identifier}:${token}`).toString("base64")}`;
  secrets.push(token, authorization);
  return authorization;
}

async function git(args, cwd, token) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: token ? "1" : "0",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: token ? `Authorization: ${basicAuthorization(token)}` : "",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_TRACE") || key === "GIT_CURL_VERBOSE") delete env[key];
  }
  try {
    return (await exec("git", args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const message = error.stderr || error.message;
    throw new Error(redact(message));
  }
}

async function expectGitFailure(args, cwd, token) {
  await assert.rejects(git(args, cwd, token));
}

function skipRegistrationClosed(status, text) {
  return status === 403 && /registration is disabled/i.test(text);
}

await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
await chmod(rootDirectory, 0o700);
await persistCredentials();

try {
  const registerResponse = await fetch(new URL("/api/auth/register", origin), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: origin.origin,
    },
    body: JSON.stringify({ identifier, password }),
  });
  const registerText = await registerResponse.text();
  if (skipRegistrationClosed(registerResponse.status, registerText)) {
    result.blocked = "Production registration is disabled; no account or repository was created.";
    await persistResult();
    console.log(`BLOCKED registration-disabled; result=${resultPath}`);
    process.exitCode = 2;
  } else {
    assert.equal(registerResponse.status, 201, `Registration failed: ${redact(registerText)}`);
    const registration = JSON.parse(registerText).data;
    assert.equal(typeof registration.id, "string");
    const setCookie = registerResponse.headers.get("set-cookie");
    assert.ok(setCookie, "Registration did not create a session cookie.");
    cookie = setCookie.split(";", 1)[0];
    credentials.cookie = cookie;
    secrets.push(cookie);
    result.checks.syntheticAccountRegistered = true;
    await persistCredentials();

    const repository = await api(
      "/api/forge/repositories",
      "POST",
      {
        owner: identifier,
        slug: repositorySlug,
        visibility,
        description: "Synthetic production acceptance repository.",
      },
      { status: 201 }
    );
    assert.equal(repository.visibility, visibility);
    repositoryUrl = `${origin.origin}/${identifier}/${repositorySlug}.git`;
    result.repository = { id: repository.id, owner: identifier, slug: repositorySlug, visibility };
    result.checks.artifactsRepositoryCreated = true;

    const credential = await api(
      "/api/auth/tokens",
      "POST",
      {
        repositoryId: repository.id,
        name: "production acceptance smoke",
        permission: "write",
        ttlSeconds: 1800,
      },
      { status: 201 }
    );
    assert.equal(credential.repositoryId, repository.id);
    assert.equal(credential.permission, "write");
    credentials.token = credential.token;
    credentials.tokenId = credential.id;
    secrets.push(credential.token);
    await persistCredentials();
    result.checks.shortLivedPatIssued = true;

    const sourceDirectory = path.join(rootDirectory, "source");
    const cloneDirectory = path.join(rootDirectory, "clone");
    await mkdir(sourceDirectory, { mode: 0o700 });
    await git(["init", "-b", "main"], sourceDirectory);
    await git(["remote", "add", "origin", repositoryUrl], sourceDirectory);
    await writeFile(
      path.join(sourceDirectory, "README.md"),
      "# Production smoke\n\nGitEdge readback.\n",
      {
        mode: 0o600,
      }
    );
    await git(["add", "README.md"], sourceDirectory);
    await git(
      [
        "-c",
        "user.name=GitEdge Production Smoke",
        "-c",
        "user.email=production-smoke@example.invalid",
        "commit",
        "-m",
        "Add production smoke fixture",
      ],
      sourceDirectory
    );
    await git(["push", "origin", "main"], sourceDirectory, credential.token);
    result.checks.basicGitPush = true;

    await git(["clone", repositoryUrl, cloneDirectory], rootDirectory, credential.token);
    const cloneContent = await readFile(path.join(cloneDirectory, "README.md"), "utf8");
    assert.equal(cloneContent, "# Production smoke\n\nGitEdge readback.\n");
    const tree = await api(`/api/git/repositories/${repository.id}/tree?ref=main`, "GET");
    assert.ok(tree.entries.some((entry) => entry.name === "README.md"));
    const file = await api(
      `/api/git/repositories/${repository.id}/file?ref=main&path=README.md`,
      "GET"
    );
    assert.equal(file.content, cloneContent);
    result.checks.independentCloneAndFileTreeReadback = true;

    const issue = await api(
      `/api/forge/repositories/${repository.id}/issues`,
      "POST",
      { title: "Production smoke issue", body: "Synthetic issue write/read acceptance." },
      { status: 201 }
    );
    const issues = await api(`/api/forge/repositories/${repository.id}/issues`);
    assert.ok(issues.some((item) => item.id === issue.id && item.title === issue.title));
    result.checks.issueWriteAndReadback = true;

    const anonymousRepository = await api(
      `/api/forge/repositories/by-name/${identifier}/${repositorySlug}`,
      "GET",
      undefined,
      { anonymous: true, status: visibility === "private" ? 404 : 200 }
    );
    if (visibility === "public") assert.equal(anonymousRepository.slug, repositorySlug);
    const anonymousTree = await api(
      `/api/git/repositories/${repository.id}/tree?ref=main`,
      "GET",
      undefined,
      { anonymous: true, status: visibility === "private" ? 404 : 200 }
    );
    if (visibility === "public")
      assert.ok(anonymousTree.entries.some((entry) => entry.name === "README.md"));
    if (visibility === "private") {
      const privateAdvertisement = await fetch(
        `${repositoryUrl}/info/refs?service=git-upload-pack`
      );
      assert.equal(privateAdvertisement.status, 404);
      await expectGitFailure(["ls-remote", repositoryUrl], rootDirectory);
    } else {
      assert.match(await git(["ls-remote", repositoryUrl], rootDirectory), /refs\/heads\/main/);
    }
    result.checks.anonymousVisibilityBoundary = visibility;

    await api(`/api/auth/tokens/${credential.id}`, "DELETE", undefined, { status: 200 });
    result.checks.patRevoked = true;
    const rejectedToken = await fetch(`${repositoryUrl}/info/refs?service=git-upload-pack`, {
      headers: { Authorization: basicAuthorization(credential.token) },
    });
    assert.equal(rejectedToken.status, 401);
    await expectGitFailure(["ls-remote", "origin"], cloneDirectory, credential.token);
    result.checks.revokedPatRejectedByGitTransport = true;
    result.completed = true;
    await persistResult();
    console.log(
      `PASS repository=${repositoryUrl} visibility=${visibility} checks=${Object.keys(result.checks).length} result=${resultPath} credentials=${credentialsPath}`
    );
  }
} catch (error) {
  result.completed = false;
  result.error = redact(error instanceof Error ? error.message : String(error));
  await persistResult();
  console.error(`FAIL repository=${repositoryUrl ?? "not-created"} result=${resultPath}`);
  console.error(result.error);
  process.exitCode = 1;
}
