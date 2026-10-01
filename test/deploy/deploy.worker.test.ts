import { runSqlScript } from "../support/database";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env as workerEnv } from "cloudflare:workers";
import { DeployManifestSchema } from "../../packages/contracts/src/deploy";
import type { DeployEnv } from "../../workers/deploy/src/deploy";
import { handleDeploy } from "../../workers/deploy/src/deploy";

const migrations = import.meta.glob<string>("../../migrations/000*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const repositoryId = "1234567890abcdef1234567890abcdef";
const accountId = "a".repeat(32);
const token = "cf-test-secret-token-value-which-must-not-escape";
const manifestText = JSON.stringify({
  schema: 1,
  name: "Example",
  license: { id: "MIT", text: "MIT License" },
  terms: { required: true, text: "Deploy under these terms." },
  worker: {
    name: "example-worker",
    entrypoint: "worker/index.js",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    vars: {},
  },
  resources: {
    d1: [{ id: "db", binding: "DB", name: "example-db", migrations: [] }],
    r2: [],
    kv: [],
  },
});

const gitRequests: Array<{
  method: string;
  path: string | null;
  ref: string | null;
  userId: string | null;
}> = [];

async function prepareRepository(): Promise<void> {
  for (const path of Object.keys(migrations).sort())
    await runSqlScript(workerEnv.DB, migrations[path]);
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      "INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    ).bind("deploy-user", "deploy-owner", "salt", "hash", 1),
    workerEnv.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES (?, ?, ?, ?, 'personal', ?, '')"
    ).bind("deploy-namespace", "deploy-owner", "deploy-user", 1, "Deploy Owner"),
    workerEnv.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) VALUES (?, ?, ?, 'owner')"
    ).bind("deploy-namespace", "deploy-user", 1),
    workerEnv.DB.prepare(
      "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, visibility, description, created_at, updated_at, artifact_name, remote, default_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      repositoryId,
      "deploy-namespace",
      "deploy-user",
      "deploy-repo",
      "repo:deploy-test",
      "private",
      "",
      1,
      1,
      "deploy-test-artifact",
      "artifact://deploy-test-artifact",
      "main"
    ),
  ]);
}

function testEnv(
  moduleSource: () => string = () => "export default { fetch() { return new Response('ok') } }"
): DeployEnv {
  return {
    DB: workerEnv.DB,
    GIT: {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        const path = url.searchParams.get("path");
        gitRequests.push({
          method: request.method,
          path,
          ref: url.searchParams.get("ref"),
          userId: request.headers.get("X-GitEdge-User-Id"),
        });
        const content =
          path === "gitedge.deploy.json"
            ? () => manifestText
            : path === "worker/index.js"
              ? moduleSource
              : undefined;
        if (!content) return new Response("File was not found.", { status: 404 });
        const body = content();
        return new Response(body, {
          headers: {
            "Content-Type": path === "gitedge.deploy.json" ? "application/json" : "text/javascript",
            "Content-Length": String(new TextEncoder().encode(body).byteLength),
            "Content-Disposition": "attachment",
          },
        });
      },
    },
    DEPLOY_SESSION_KEY: "test-deploy-session-encryption-key-32-bytes-minimum",
  };
}

beforeAll(prepareRepository);

function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  extra: Record<string, string> = {}
): Request {
  return new Request(`https://gitedge.test/${path}?repositoryId=${repositoryId}&ref=main`, {
    method,
    headers: {
      Origin: "https://gitedge.test",
      "Content-Type": "application/json",
      "X-GitEdge-User-Id": "deploy-user",
      "X-GitEdge-User-Name": "deploy-owner",
      "X-GitEdge-User-Group": "free",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("repository deployment", () => {
  it("reads the manifest and declared modules from raw Git file responses", async () => {
    gitRequests.length = 0;
    const response = await handleDeploy(request("plan"), testEnv(), logger);
    const payload = (await response.json()) as {
      data: { manifest: { name: string }; manifestDigest: string };
    };
    expect(response.status).toBe(200);
    expect(payload.data.manifest.name).toBe("Example");
    expect(payload.data.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(gitRequests).toEqual([
      { method: "GET", path: "gitedge.deploy.json", ref: "main", userId: "deploy-user" },
      { method: "GET", path: "worker/index.js", ref: "main", userId: "deploy-user" },
    ]);
  });

  it("validates a strict manifest and rejects executable recipe fields", () => {
    expect(DeployManifestSchema.safeParse(JSON.parse(manifestText)).success).toBe(true);
    expect(
      DeployManifestSchema.safeParse({
        ...JSON.parse(manifestText),
        resources: {
          d1: [
            {
              id: "db",
              binding: "DB",
              name: "example-db",
              migrations: ["migrations/0001_init.sql"],
            },
          ],
          r2: [],
          kv: [],
        },
      }).success
    ).toBe(true);
    expect(
      DeployManifestSchema.safeParse({ ...JSON.parse(manifestText), recipe: "deploy.js" }).success
    ).toBe(false);
    expect(
      DeployManifestSchema.safeParse({
        ...JSON.parse(manifestText),
        worker: { ...JSON.parse(manifestText).worker, entrypoint: "../escape.js" },
      }).success
    ).toBe(false);
    expect(
      DeployManifestSchema.safeParse({
        ...JSON.parse(manifestText),
        resources: {
          d1: [{ id: "db", binding: "DB", name: "example-db", migrations: ["../escape.sql"] }],
          r2: [],
          kv: [],
        },
      }).success
    ).toBe(false);
  });

  it("rejects agent identity headers before any Cloudflare credential is accepted", async () => {
    const response = await handleDeploy(
      request("session", "POST", { token, manifestDigest: "x" }, undefined, {
        "X-GitEdge-Agent-Session": "malformed-but-present",
      }),
      testEnv(),
      logger
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(token);
  });

  it("binds the reviewed plan to the module contents on the selected ref", async () => {
    let source = "export default { fetch() { return new Response('first') } }";
    const env = testEnv(() => source);
    const planResponse = await handleDeploy(request("plan"), env, logger);
    const plan = ((await planResponse.json()) as { data: { manifestDigest: string } }).data;
    source = "export default { fetch() { return new Response('changed') } }";
    const response = await handleDeploy(
      request("session", "POST", { token, manifestDigest: plan.manifestDigest }),
      env,
      logger
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain(token);
  });

  it("keeps the token out of responses and reuses a named resource on retry", async () => {
    const resources = new Map<string, { id: string; name: string }[]>();
    const created: string[] = [];
    const calls: string[] = [];
    let subdomainReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      if (url.pathname === "/client/v4/accounts")
        return Response.json({ success: true, result: [{ id: accountId, name: "Test account" }] });
      if (url.pathname.endsWith("/d1/database") && (init?.method ?? "GET") === "GET")
        return Response.json({ success: true, result: resources.get(url.pathname) ?? [] });
      if (url.pathname.endsWith("/d1/database") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string };
        const resource = { id: "db-1", name: body.name };
        resources.set(url.pathname, [resource]);
        created.push(body.name);
        return Response.json({ success: true, result: resource });
      }
      if (url.pathname.endsWith("/workers/scripts/example-worker") && init?.method === "PUT") {
        expect(init.body).toBeInstanceOf(FormData);
        if (!(init.body instanceof FormData))
          throw new Error("Worker upload must use multipart form data.");
        expect(new Headers(init.headers).has("Content-Type")).toBe(false);
        const metadataPart = init.body.get("metadata");
        expect(typeof metadataPart).toBe("string");
        if (typeof metadataPart !== "string")
          throw new Error("Worker upload metadata must be JSON text.");
        const metadata = JSON.parse(metadataPart) as { main_module?: string };
        expect(metadata.main_module).toBe("worker/index.js");
        expect(init.body.get("worker/index.js")).not.toBeNull();
        return Response.json({ success: true, result: { id: "version-1" } });
      }
      if (
        url.pathname.endsWith("/workers/scripts/example-worker/subdomain") &&
        init?.method === "POST"
      ) {
        expect(new Headers(init.headers).get("Cloudflare-Workers-Script-Api-Date")).toBe(
          "2025-08-01"
        );
        expect(JSON.parse(String(init.body))).toEqual({ enabled: true, previews_enabled: false });
        return Response.json({ success: true, result: { enabled: true, previews_enabled: false } });
      }
      if (url.pathname.endsWith("/workers/workers/example-worker")) {
        subdomainReads += 1;
        return Response.json({
          success: true,
          result: {
            subdomain: {
              enabled: subdomainReads > 1,
              previews_enabled: false,
              url: "https://example-worker.test-account.workers.dev",
            },
          },
        });
      }
      throw new Error(`Unexpected Cloudflare API request ${url.pathname}`);
    });

    const env = testEnv();
    const planResponse = await handleDeploy(request("plan"), env, logger);
    const plan = ((await planResponse.json()) as { data: { manifestDigest: string } }).data;
    const sessionResponse = await handleDeploy(
      request("session", "POST", { token, manifestDigest: plan.manifestDigest }),
      env,
      logger
    );
    const sessionPayload = ((await sessionResponse.clone().json()) as { data: { nonce: string } })
      .data;
    const sessionCookie = sessionResponse.headers.get("Set-Cookie")?.split(";")[0];
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.text()).not.toContain(token);
    expect(sessionCookie).toContain("ge_deploy_session=");
    expect(sessionCookie).not.toContain(token);
    expect(sessionCookie?.length ?? 0).toBeLessThan(4096);

    const invalidNonce = await handleDeploy(
      request("account", "POST", { accountId, nonce: "wrong-session-nonce" }, sessionCookie),
      env,
      logger
    );
    expect(invalidNonce.status).toBe(403);

    const accountResponse = await handleDeploy(
      request("account", "POST", { accountId, nonce: sessionPayload.nonce }, sessionCookie),
      env,
      logger
    );
    const selectedCookie = accountResponse.headers.get("Set-Cookie")?.split(";")[0];
    expect(accountResponse.status).toBe(200);
    const firstProvision = await handleDeploy(
      request(
        "provision",
        "POST",
        { nonce: sessionPayload.nonce, resourceNames: { db: "example-db" } },
        selectedCookie
      ),
      env,
      logger
    );
    const retryCookie = firstProvision.headers.get("Set-Cookie")?.split(";")[0];
    const retryProvision = await handleDeploy(
      request(
        "provision",
        "POST",
        { nonce: sessionPayload.nonce, resourceNames: { db: "example-db" } },
        retryCookie
      ),
      env,
      logger
    );
    expect(firstProvision.status).toBe(200);
    expect(retryProvision.status).toBe(200);
    expect(created).toEqual(["example-db"]);

    const failedActivation = await handleDeploy(
      request(
        "deploy",
        "POST",
        {
          workerName: "example-worker",
          confirmDigest: plan.manifestDigest,
          nonce: sessionPayload.nonce,
        },
        retryProvision.headers.get("Set-Cookie")?.split(";")[0]
      ),
      env,
      logger
    );
    const failurePayload = (await failedActivation.json()) as {
      error: { code: string; uploadStatus: string; activationStatus: string };
    };
    expect(failedActivation.status).toBe(502);
    expect(failurePayload.error.code).toBe("activation_failed");
    expect(failurePayload.error.uploadStatus).toBe("upload_succeeded");
    expect(failurePayload.error.activationStatus).toBe("activation_failed");
    const activationRetryCookie = failedActivation.headers.get("Set-Cookie")?.split(";")[0];
    expect(activationRetryCookie).toContain("ge_deploy_session=");
    expect(failedActivation.headers.get("Set-Cookie")).toContain("Max-Age=900");

    const deployed = await handleDeploy(
      request(
        "deploy",
        "POST",
        {
          workerName: "example-worker",
          confirmDigest: plan.manifestDigest,
          nonce: sessionPayload.nonce,
        },
        activationRetryCookie
      ),
      env,
      logger
    );
    const output = await deployed.text();
    expect(deployed.status).toBe(200);
    expect(output).toContain("https://example-worker.test-account.workers.dev");
    expect(output).not.toContain(token);
    expect(deployed.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(2);
    expect(
      calls.filter((call) => call.startsWith("POST ") && call.includes("/subdomain"))
    ).toHaveLength(2);
    expect(
      calls.filter(
        (call) => call.startsWith("GET ") && call.endsWith("/workers/workers/example-worker")
      )
    ).toHaveLength(2);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(token);
  });
});
