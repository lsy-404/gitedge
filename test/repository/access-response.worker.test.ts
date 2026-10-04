import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleGatewayRequest, type GatewayEnv } from "../../workers/gateway/src/index";
import forge from "../../workers/forge/src/index";
import { handleGitApi } from "../../workers/git/src/api";
import { proxyGitTransport } from "../../workers/git/src/transport";
import { REPOSITORY_ACCESS_DENIED_HEADER } from "../../packages/contracts/src/trust";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
const gitService = {
  fetch: (request: Request) =>
    new URL(request.url).pathname.includes(".git/")
      ? proxyGitTransport(request, gitEnv)
      : handleGitApi(request, gitEnv),
};
const forgeEnv = { ...gitEnv, GIT: gitService };
const owner = { id: "owner-id", identifier: "owner", groupKey: "free" };
const outsider = { id: "outsider-id", identifier: "outsider", groupKey: "free" };

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of [owner, outsider]) {
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'salt','hash',1)"
    )
      .bind(user.id, user.identifier)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('namespace','owner','owner-id',1,'personal')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('namespace','owner-id','owner',1)"
  ).run();
  const created = await artifacts.create("private-source", { setDefaultBranch: "main" });
  using handle = await artifacts.get(created.name);
  await handle.revokeToken(created.token);
  await env.DB.prepare(
    "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,artifact_name,remote,created_at,updated_at) VALUES('private-id','namespace','owner-id','private-repo','repo:private','private','private-description',?,?,1,1)"
  )
    .bind(created.name, created.remote)
    .run();
  await env.DB.prepare(
    "INSERT INTO repository_paths(namespace_id,slug,repository_id) VALUES('namespace','old-name','private-id')"
  ).run();
});

type Viewer = "anonymous" | "guest" | "outsider" | "owner";
function gateway(policy: string | undefined, viewer: Viewer): GatewayEnv {
  return {
    PRIVATE_REPOSITORY_RESPONSE: policy,
    AUTH: {
      fetch: async () =>
        Response.json({
          data: viewer === "owner" ? owner : viewer === "outsider" ? outsider : null,
          ...(viewer === "guest" ? { view: "guest" } : {}),
        }),
    },
    FORGE: { fetch: (request) => forge.fetch(request, forgeEnv) },
    GIT: gitService,
    ASSETS: {
      fetch: async () =>
        new Response("<html>GitEdge</html>", { headers: { "Content-Type": "text/html" } }),
    },
    RATE_LIMITER: {
      getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
  };
}
const privatePaths = [
  "/api/forge/repositories/private-id",
  "/api/forge/repositories/by-name/owner/private-repo",
  "/api/forge/repositories/by-name/owner/old-name",
  "/api/forge/repositories/private-id/issues",
  "/api/git/repositories/private-id/tree",
  "/owner/private-repo.git/info/refs?service=git-upload-pack",
  "/owner/old-name.git/info/refs?service=git-upload-pack",
];
const missingPaths = [
  "/api/forge/repositories/missing",
  "/api/forge/repositories/by-name/owner/missing",
  "/api/git/repositories/missing/tree",
  "/owner/missing.git/info/refs?service=git-upload-pack",
];

describe("Server repository denial policy", () => {
  for (const viewer of ["anonymous", "guest", "outsider"] satisfies Viewer[]) {
    it.each([undefined, "not_found", "invalid", "forbidden"])(
      "uses policy %s consistently for " + viewer,
      async (policy) => {
        const bindings = gateway(policy, viewer);
        for (const path of privatePaths) {
          const response = await handleGatewayRequest(
            new Request("https://forge.test" + path),
            bindings
          );
          expect(response.status, path).toBe(policy === "forbidden" ? 403 : 404);
          expect(response.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)).toBe(false);
          expect(response.headers.get("Location")).toBeNull();
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(await response.json()).toEqual({
            error:
              policy === "forbidden"
                ? { code: "forbidden", message: "Repository access is denied." }
                : { code: "not_found", message: "Repository was not found." },
          });
        }
        for (const path of missingPaths) {
          const response = await handleGatewayRequest(
            new Request("https://forge.test" + path),
            bindings
          );
          expect(response.status).toBe(404);
          expect(response.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)).toBe(false);
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(await response.json()).toEqual({
            error: { code: "not_found", message: "Repository was not found." },
          });
        }
      }
    );
  }
  it.each(["not_found", "forbidden"])(
    "sets actual HTML status and never redirects private aliases in %s mode",
    async (policy) => {
      for (const path of ["/owner/private-repo", "/owner/old-name/issues/1", "/owner/missing"]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await handleGatewayRequest(
            new Request("https://forge.test" + path, { method }),
            gateway(policy, "anonymous")
          );
          expect(response.status).toBe(
            policy === "forbidden" && !path.endsWith("missing") ? 403 : 404
          );
          expect(response.headers.get("Location")).toBeNull();
          expect(response.headers.get("Cache-Control")).toBe("no-store");
          expect(response.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)).toBe(false);
          expect(await response.text()).toBe(method === "HEAD" ? "" : "<html>GitEdge</html>");
        }
      }
    }
  );
  it("does not let request headers change policy or disclose a private name in lists", async () => {
    const bindings = gateway(undefined, "outsider");
    const denied = await handleGatewayRequest(
      new Request("https://forge.test" + privatePaths[0], {
        headers: {
          [REPOSITORY_ACCESS_DENIED_HEADER]: "1",
          PRIVATE_REPOSITORY_RESPONSE: "forbidden",
          "X-GitEdge-User-Id": owner.id,
        },
      }),
      bindings
    );
    expect(denied.status).toBe(404);
    const list = await handleGatewayRequest(
      new Request("https://forge.test/api/forge/repositories"),
      gateway("forbidden", "outsider")
    );
    expect(await list.json()).toEqual({ data: [] });
  });
  it.each(["not_found", "forbidden"])(
    "preserves owner reads and canonical redirects in %s mode",
    async (policy) => {
      const bindings = gateway(policy, "owner");
      const repo = await handleGatewayRequest(
        new Request("https://forge.test" + privatePaths[0]),
        bindings
      );
      expect(repo.status).toBe(200);
      expect(await repo.json()).toMatchObject({ data: { id: "private-id", canWrite: true } });
      const refs = await handleGatewayRequest(
        new Request("https://forge.test/api/git/repositories/private-id/refs"),
        bindings
      );
      expect(refs.status).toBe(200);
      const alias = await handleGatewayRequest(
        new Request("https://forge.test/owner/old-name"),
        bindings
      );
      expect(alias.status).toBe(308);
      expect(alias.headers.get("Location")).toBe("https://forge.test/owner/private-repo");
    }
  );
});
