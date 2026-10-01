import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const origin = process.env.GITEDGE_API || "http://localhost:8879";
const gatewayConfig = JSON.parse(await readFile("workers/gateway/wrangler.jsonc", "utf8"));
const cloudflareAccountId = gatewayConfig.account_id;
check(
  typeof cloudflareAccountId === "string" && /^[a-f0-9]{32}$/.test(cloudflareAccountId),
  "Gateway account_id is required for isolated verification."
);
const cloudflareApi = "https://api.cloudflare.com/client/v4";
const runId = randomBytes(10).toString("hex");
const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const resourcePrefix = `gitedge-verify-${suffix}`;
const workerName = resourcePrefix;
const identifier = `verify-${randomBytes(5).toString("hex")}`;
const repositorySlug = "deploy-verification";
const tableName = `deploy_verify_${runId}`;
const directory = await mkdtemp(path.join(tmpdir(), "gitedge-deploy-verify-"));
const cookies = new Map();
const secrets = [];
let phase = "startup";

function redact(value) {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, "[redacted]") : result),
    String(value)
  );
}

function safeText(value) {
  return redact(value)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300);
}

function recordCookies(headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("Set-Cookie")].filter(Boolean);
  for (const header of setCookies) {
    const [pair, ...attributes] = header.split(";");
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (attributes.some((attribute) => /^max-age=0$/i.test(attribute.trim()))) cookies.delete(name);
    else {
      cookies.set(name, value);
      secrets.push(value);
    }
  }
}

function responseError(payload, fallback) {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return fallback;
  const error = payload.error;
  if (typeof error !== "object" || error === null) return fallback;
  const code = "code" in error && typeof error.code === "string" ? error.code : "unknown";
  const message =
    "message" in error && typeof error.message === "string" ? error.message : fallback;
  return { code, message };
}

class ApiFailure extends Error {
  constructor(route, status, code, message) {
    super(`${route} returned HTTP ${status} (${code}): ${safeText(message)}`);
    this.name = "ApiFailure";
    this.route = route;
    this.status = status;
    this.code = code;
    this.detail = safeText(message);
  }
}

async function api(route, { method = "GET", body } = {}) {
  const headers = new Headers({ Accept: "application/json", Origin: origin });
  const cookie = Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; ");
  if (cookie) headers.set("Cookie", cookie);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(new URL(route, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  recordCookies(response.headers);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = responseError(payload, `Request failed at ${route}`);
    throw new ApiFailure(route, response.status, detail.code, detail.message);
  }
  if (typeof payload !== "object" || payload === null || !("data" in payload))
    throw new Error(`Unexpected API response at ${route}.`);
  return payload.data;
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(new URL("/api/auth/session", origin), {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 401 || response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Local Gateway was not ready at the configured loopback address.");
}

async function wranglerCredential() {
  const environment = { ...process.env };
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"])
    delete environment[name];
  let output;
  try {
    ({ stdout: output } = await exec(
      process.execPath,
      [path.resolve("node_modules/wrangler/bin/wrangler.js"), "auth", "token", "--json"],
      { cwd: process.cwd(), env: environment, maxBuffer: 1024 * 1024 }
    ));
  } catch {
    throw new Error("Wrangler could not load the local OAuth credential; output withheld.");
  }
  let credential;
  try {
    credential = JSON.parse(output);
  } catch {
    throw new Error("Wrangler returned an unsupported credential response; output withheld.");
  }
  if (
    !["oauth", "api_token"].includes(credential.type) ||
    typeof credential.token !== "string" ||
    credential.token.length < 20
  )
    throw new Error(`Wrangler returned unsupported credential type ${String(credential.type)}.`);
  secrets.push(credential.token);
  return { type: credential.type, token: credential.token };
}

async function cloudflareProbe(pathname, token) {
  try {
    const response = await fetch(`${cloudflareApi}${pathname}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json();
    const success = typeof payload === "object" && payload !== null && payload.success === true;
    const errors =
      typeof payload === "object" && payload !== null && Array.isArray(payload.errors)
        ? payload.errors
            .map((error) => {
              const code = typeof error?.code === "number" ? error.code : "unknown";
              const message = typeof error?.message === "string" ? safeText(error.message) : "";
              return `${code}${message ? `:${message}` : ""}`;
            })
            .join(";")
        : "";
    const accountAvailable =
      pathname.startsWith("/accounts?") &&
      success &&
      Array.isArray(payload.result) &&
      payload.result.some((account) => account?.id === cloudflareAccountId);
    console.log(
      `Cloudflare read-only probe ${pathname.split("?")[0]}: HTTP ${response.status}; success=${success}; authorizedTestAccount=${accountAvailable}; errors=${errors || "none"}`
    );
  } catch {
    console.log(
      `Cloudflare read-only probe ${pathname.split("?")[0]}: network failure; details withheld.`
    );
  }
}

async function diagnoseCredential(token) {
  await cloudflareProbe("/user/tokens/verify", token);
  await cloudflareProbe("/accounts?per_page=50&page=1", token);
  for (const resource of [
    `/accounts/${cloudflareAccountId}/d1/database?per_page=1`,
    `/accounts/${cloudflareAccountId}/storage/kv/namespaces?per_page=1&page=1`,
    `/accounts/${cloudflareAccountId}/r2/buckets?per_page=1`,
    `/accounts/${cloudflareAccountId}/workers/scripts?per_page=1`,
  ])
    await cloudflareProbe(resource, token);
}

async function git(args, cwd, token) {
  const environment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: token ? "1" : "0",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token ?? ""}`,
  };
  for (const name of Object.keys(environment))
    if (name.startsWith("GIT_TRACE") || name === "GIT_CURL_VERBOSE") delete environment[name];
  try {
    return (
      await exec("git", args, { cwd, env: environment, maxBuffer: 4 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(`Git operation failed during ${phase}; details withheld.`);
  }
}

function deploymentManifest() {
  return {
    schema: 1,
    name: "Isolated deployment E2E",
    license: { id: "MIT", text: "MIT License" },
    terms: { required: true, text: `Isolated verification ${runId}` },
    worker: {
      name: workerName,
      entrypoint: "worker.js",
      modules: ["worker.js"],
      compatibilityDate: "2026-10-01",
      compatibilityFlags: [],
      vars: { VERIFY_RUN_ID: runId },
    },
    resources: {
      d1: [
        {
          id: "VERIFY_DB",
          binding: "VERIFY_DB",
          name: `${resourcePrefix}-db`,
          migrations: ["migrations/001_verify.sql"],
        },
      ],
      r2: [{ id: "VERIFY_BUCKET", binding: "VERIFY_BUCKET", name: `${resourcePrefix}-r2` }],
      kv: [{ id: "VERIFY_KV", binding: "VERIFY_KV", name: `${resourcePrefix}-kv` }],
    },
  };
}

async function makeRepositorySource(directoryPath, credential, manifest) {
  const source = path.join(directoryPath, "source");
  await mkdir(path.join(source, "migrations"), { recursive: true });
  await git(["init", "-b", "main"], source, credential);
  await git(
    ["remote", "add", "origin", `${origin}/${identifier}/${repositorySlug}.git`],
    source,
    credential
  );
  await writeFile(
    path.join(source, "gitedge.deploy.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(source, "migrations/001_verify.sql"),
    `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY NOT NULL);\n`
  );
  const worker = `export default {\n  async fetch(_request, env) {\n    const migration = await env.VERIFY_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind("${tableName}").first();\n    await env.VERIFY_KV.get("gitedge-verify-missing");\n    await env.VERIFY_BUCKET.head("gitedge-verify-missing");\n    return Response.json({\n      ok: migration?.name === "${tableName}",\n      migrated: migration?.name === "${tableName}",\n      runId: env.VERIFY_RUN_ID\n    });\n  }\n};\n`;
  await writeFile(path.join(source, "worker.js"), worker);
  await git(["add", "."], source, credential);
  await git(
    [
      "-c",
      "user.name=GitEdge E2E",
      "-c",
      "user.email=verify@gitedge.invalid",
      "commit",
      "-m",
      "Add isolated deployment verification sources",
    ],
    source,
    credential
  );
  await git(["push", "origin", "main"], source, credential);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyWorker(url) {
  let lastStatus = "not reached";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) {
        const payload = await response.json();
        check(
          payload.ok === true && payload.migrated === true && payload.runId === runId,
          "Deployed Worker did not observe the expected D1 migration and test binding."
        );
        return;
      }
      if (response.status < 500 && response.status !== 404) break;
    } catch {
      lastStatus = "network unavailable";
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`workers.dev activation URL did not serve the Worker (${lastStatus}).`);
}

async function main() {
  const parsedOrigin = new URL(origin);
  check(
    ["127.0.0.1", "localhost"].includes(parsedOrigin.hostname),
    "Gateway URL must be loopback."
  );
  await waitForGateway();
  console.log("Local Gateway is reachable.");

  phase = "wrangler-credential";
  const cloudflareCredential = await wranglerCredential();
  console.log(`Wrangler credential type: ${cloudflareCredential.type}.`);

  phase = "account-and-repository";
  const password = randomBytes(24).toString("base64url");
  secrets.push(password);
  await api("/api/auth/register", {
    method: "POST",
    body: { identifier, password },
  });
  const repository = await api("/api/forge/repositories", {
    method: "POST",
    body: {
      owner: identifier,
      slug: repositorySlug,
      visibility: "private",
      description: "Isolated Cloudflare deployment verification",
    },
  });
  check(typeof repository.id === "string", "Repository creation did not return an id.");
  console.log(`Isolated Artifacts repository created: ${repository.id}.`);

  phase = "git-push";
  const gitCredential = await api("/api/auth/tokens", {
    method: "POST",
    body: {
      repositoryId: repository.id,
      name: "Isolated deployment verification",
      permission: "write",
      ttlSeconds: 3600,
    },
  });
  check(typeof gitCredential.token === "string", "Git transport credential was not issued.");
  secrets.push(gitCredential.token);
  const manifest = deploymentManifest();
  await makeRepositorySource(directory, gitCredential.token, manifest);
  const tree = await api(`/api/git/repositories/${repository.id}/tree?ref=main`);
  check(
    tree.entries.some((entry) => entry.name === "gitedge.deploy.json"),
    "Artifacts tree is missing the manifest."
  );
  console.log("Git push and remote Artifacts tree read passed.");

  phase = "deployment-plan";
  const plan = await api(`/api/deploy/plan?repositoryId=${repository.id}&ref=main`);
  check(
    plan.manifestDigest && plan.permissions.length > 0,
    "Deployment plan omitted its digest or permissions."
  );
  check(
    plan.manifest.resources.d1.length === 1,
    "D1 resource is missing from the deployment plan."
  );
  check(
    plan.manifest.resources.kv.length === 1,
    "KV resource is missing from the deployment plan."
  );
  check(
    plan.manifest.resources.r2.length === 1,
    "R2 resource is missing from the deployment plan."
  );
  console.log("Plan read the manifest and source modules from the remote Artifacts repository.");

  phase = "deployment-session";
  let deploymentSession;
  try {
    deploymentSession = await api(`/api/deploy/session?repositoryId=${repository.id}&ref=main`, {
      method: "POST",
      body: { token: cloudflareCredential.token, manifestDigest: plan.manifestDigest },
    });
  } catch (error) {
    if (error instanceof ApiFailure) {
      console.log(
        `Deploy credential gate: HTTP ${error.status}; code=${error.code}; message=${error.detail}`
      );
      await diagnoseCredential(cloudflareCredential.token);
    }
    throw error;
  }
  const account = deploymentSession.accounts.find((item) => item.id === cloudflareAccountId);
  check(account, "Authorized Cloudflare account was not available to the deployment session.");
  secrets.push(deploymentSession.nonce);
  console.log(
    "Deployment session accepted the credential and listed the authorized target account."
  );

  phase = "select-account";
  await api(`/api/deploy/account?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { accountId: cloudflareAccountId, nonce: deploymentSession.nonce },
  });
  const resourceNames = {
    VERIFY_DB: manifest.resources.d1[0].name,
    VERIFY_BUCKET: manifest.resources.r2[0].name,
    VERIFY_KV: manifest.resources.kv[0].name,
  };

  phase = "resource-availability";
  const available = await api(`/api/deploy/resources?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { nonce: deploymentSession.nonce, resourceNames },
  });
  check(
    available.resources.length === 3,
    "Resource availability response did not include D1, KV, and R2."
  );

  phase = "resource-provisioning";
  const firstProvision = await api(`/api/deploy/provision?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { nonce: deploymentSession.nonce, resourceNames },
  });
  check(
    firstProvision.resources.length === 3,
    "Provisioning did not create all declared resources."
  );
  for (const resource of firstProvision.resources)
    console.log(`Provisioned ${resource.key}: ${resource.id} (reused=${resource.reused}).`);

  const retryProvision = await api(`/api/deploy/provision?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { nonce: deploymentSession.nonce, resourceNames },
  });
  check(retryProvision.resources.length === 3, "Provision retry omitted resources.");
  check(
    retryProvision.resources.every((resource) => resource.reused),
    "Provision retry did not reuse all resources."
  );
  console.log("Resource retry reused the existing D1, KV, and R2 resources.");

  phase = "d1-migrations";
  const migration = await api(`/api/deploy/migrate?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { nonce: deploymentSession.nonce },
  });
  check(
    migration.completed.includes(`VERIFY_DB:migrations/001_verify.sql`),
    "D1 migration was not reported complete."
  );
  const migrationRetry = await api(`/api/deploy/migrate?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: { nonce: deploymentSession.nonce },
  });
  check(
    migrationRetry.completed.includes(`VERIFY_DB:migrations/001_verify.sql`),
    "D1 migration retry was not idempotent."
  );
  console.log("D1 migration applied and retry completed idempotently.");

  phase = "worker-upload-and-activation";
  const deployment = await api(`/api/deploy/deploy?repositoryId=${repository.id}&ref=main`, {
    method: "POST",
    body: {
      nonce: deploymentSession.nonce,
      workerName,
      confirmDigest: plan.manifestDigest,
    },
  });
  check(deployment.workerName === workerName, "Deployment returned a different Worker name.");
  check(
    typeof deployment.url === "string" && deployment.url.startsWith("https://"),
    "Deployment did not return an HTTPS workers.dev URL."
  );
  console.log(`Worker upload and workers.dev activation confirmed: ${deployment.url}`);

  phase = "workers-dev-readback";
  await verifyWorker(deployment.url);
  console.log("Live Worker invocation confirmed the D1 migration and all configured bindings.");
  console.log(`Repository id: ${repository.id}. Worker URL: ${deployment.url}`);
}

try {
  await main();
} catch (error) {
  console.error(
    `Deployment E2E stopped during ${phase}: ${safeText(error?.message ?? "unknown failure")}`
  );
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
