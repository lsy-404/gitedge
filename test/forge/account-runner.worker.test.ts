import { runSqlScript } from "../support/database";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import forge from "../../workers/forge/src/index";
import { parseRunnerWorkflow } from "../../workers/actions/src/runner-workflow";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const files = new Map<string, string>();
const heads = new Map<string, string>();
let nextOid = 0;
const gitEdits: Array<{ repositoryId: string; path: string; content: string }> = [];
const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    async fetch(request: Request) {
      const url = new URL(request.url);
      const [resource, repositoryId, operation] = url.pathname.split("/").filter(Boolean);
      if (resource === "repositories" && operation === "refs" && request.method === "GET")
        return Response.json({
          data: heads.has(repositoryId ?? "")
            ? [{ name: "refs/heads/main", oid: heads.get(repositoryId ?? "") }]
            : [],
        });
      if (resource === "repositories" && operation === "file" && request.method === "GET") {
        const content = files.get(`${repositoryId}:${url.searchParams.get("path")}`);
        return content === undefined
          ? Response.json({ error: { code: "not_found" } }, { status: 404 })
          : Response.json({ data: { content, binary: false } });
      }
      if (resource === "repositories" && operation === "edit" && request.method === "POST") {
        const input = (await request.json()) as {
          path: string;
          content: string;
          expectedOid: string | null;
        };
        if (input.expectedOid !== (heads.get(repositoryId ?? "") ?? null))
          return Response.json({ error: { code: "refs_changed" } }, { status: 409 });
        const oid = (++nextOid).toString(16).padStart(40, "0");
        files.set(`${repositoryId}:${input.path}`, input.content);
        heads.set(repositoryId ?? "", oid);
        gitEdits.push({ repositoryId: repositoryId ?? "", ...input });
        return Response.json({ data: { oid } });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
  },
};

function headers(userId: string, name: string): Headers {
  return new Headers({
    "X-GitEdge-User-Id": userId,
    "X-GitEdge-User-Name": name,
    "X-GitEdge-User-Group": "free",
    "Content-Type": "application/json",
  });
}

function call(path: string, method: string, userId = "owner", name = "owner", body?: unknown) {
  return forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers: headers(userId, name),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

beforeAll(async () => {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('owner','owner','x','x',1),('other','other','x','x',1),('conflict','conflict','x','x',1);
     INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('owner-ns','owner','owner',1,'personal','Owner',''),('other-ns','other','other',1,'personal','Other',''),('conflict-ns','conflict','conflict',1,'personal','Conflict','');
     INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('owner-ns','owner',1,'owner'),('other-ns','other',1,'owner'),('conflict-ns','conflict',1,'owner');`
  );
});

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  const originalGet = FixtureArtifacts.prototype.get.bind(artifacts);
  vi.spyOn(artifacts, "get").mockImplementation(async (name) => {
    try {
      return await originalGet(name);
    } catch {
      throw artifactsError("NOT_FOUND");
    }
  });
});

async function addOwner(id: string): Promise<void> {
  await runSqlScript(
    env.DB,
    `INSERT INTO users (id, identifier, password_salt, password_hash, created_at) VALUES ('${id}','${id}','x','x',1);
     INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES ('${id}-ns','${id}','${id}',1,'personal','${id}','');
     INSERT INTO namespace_memberships (namespace_id,user_id,created_at,role) VALUES ('${id}-ns','${id}',1,'owner');`
  );
}

function artifactsError(code: "NOT_FOUND" | "INTERNAL_ERROR"): Error {
  return Object.assign(new Error(code), { name: "ArtifactsError", code, numericCode: 1 });
}

describe("account Runner repository", () => {
  it("recovers a failed creation after the lease expires and revokes the bootstrap token", async () => {
    await addOwner("retry-owner");
    const create = vi
      .spyOn(artifacts, "create")
      .mockRejectedValueOnce(artifactsError("INTERNAL_ERROR"));
    expect((await call("/account-runner", "POST", "retry-owner", "retry-owner")).status).toBe(503);
    expect((await call("/account-runner", "POST", "retry-owner", "retry-owner")).status).toBe(503);
    expect(create).toHaveBeenCalledTimes(1);
    await env.DB.prepare(
      "UPDATE repositories SET updated_at = 1 WHERE namespace_id = 'retry-owner-ns'"
    ).run();

    // The first create failed before making a repository; let the fixture handle future calls.
    create.mockRestore();
    const recovered = await call("/account-runner", "POST", "retry-owner", "retry-owner");
    expect(recovered.status).toBe(200);
    const row = await env.DB.prepare(
      "SELECT id FROM repositories WHERE namespace_id='retry-owner-ns'"
    ).first<{ id: string }>();
    const snapshot = artifacts.snapshot(`repo-${row!.id}`);
    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.tokens[0].state).toBe("revoked");
  });

  it("reconciles an unknown create success by name without creating a duplicate", async () => {
    await addOwner("unknown-owner");
    vi.spyOn(artifacts, "create").mockRejectedValueOnce(artifactsError("INTERNAL_ERROR"));
    vi.spyOn(artifacts, "get").mockImplementation(async (name) => {
      const repository = artifacts.repositories.get(name);
      if (repository) return FixtureArtifacts.prototype.get.call(artifacts, name);
      throw artifactsError("NOT_FOUND");
    });

    expect((await call("/account-runner", "POST", "unknown-owner", "unknown-owner")).status).toBe(
      503
    );
    const row = await env.DB.prepare(
      "SELECT id FROM repositories WHERE namespace_id='unknown-owner-ns'"
    ).first<{ id: string }>();
    vi.restoreAllMocks();
    await artifacts.create(`repo-${row!.id}`, { setDefaultBranch: "main" });
    const create = vi.spyOn(artifacts, "create");
    vi.spyOn(artifacts, "get").mockImplementation(async (name) => {
      const repository = artifacts.repositories.get(name);
      if (repository) return FixtureArtifacts.prototype.get.call(artifacts, name);
      throw artifactsError("NOT_FOUND");
    });
    await env.DB.prepare("UPDATE repositories SET updated_at = 1 WHERE id = ?").bind(row!.id).run();
    const recovered = await call("/account-runner", "POST", "unknown-owner", "unknown-owner");
    expect(recovered.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(artifacts.snapshot(`repo-${row!.id}`).tokens[0].state).toBe("revoked");
  });

  it("does not treat a generic not-found message as permission to create", async () => {
    await addOwner("lookup-owner");
    vi.spyOn(artifacts, "get").mockRejectedValue(new Error("Artifact repo not found"));
    const create = vi.spyOn(artifacts, "create");
    expect((await call("/account-runner", "POST", "lookup-owner", "lookup-owner")).status).toBe(
      503
    );
    await env.DB.prepare(
      "UPDATE repositories SET updated_at = 1 WHERE namespace_id='lookup-owner-ns'"
    ).run();
    expect((await call("/account-runner", "POST", "lookup-owner", "lookup-owner")).status).toBe(
      503
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("does not publish metadata when bootstrap token revocation fails", async () => {
    await addOwner("revoke-owner");
    const originalGet = FixtureArtifacts.prototype.get.bind(artifacts);
    vi.spyOn(artifacts, "get").mockImplementation(async (name) => {
      const repository = artifacts.repositories.get(name);
      if (!repository) throw artifactsError("NOT_FOUND");
      const handle = await originalGet(name);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "revokeToken") return async () => false;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    expect((await call("/account-runner", "POST", "revoke-owner", "revoke-owner")).status).toBe(
      503
    );
    const row = await env.DB.prepare(
      "SELECT id,artifact_name,remote FROM repositories WHERE namespace_id='revoke-owner-ns'"
    ).first<{ id: string; artifact_name: string | null; remote: string | null }>();
    expect(row).toMatchObject({ artifact_name: null, remote: null });
    expect(artifacts.snapshot(`repo-${row!.id}`).tokens[0].state).toBe("active");
  });
  it("reports an absent Runner and hides the owner’s state from other accounts", async () => {
    expect(await (await call("/account-runner", "GET")).json()).toMatchObject({
      data: { repository: null },
    });
    expect(await (await call("/account-runner", "GET", "other", "other")).json()).toMatchObject({
      data: { repository: null },
    });
  });

  it("provisions one private Runner under concurrent requests and returns it on retry", async () => {
    const responses = await Promise.all([
      call("/account-runner", "POST"),
      call("/account-runner", "POST"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 503]);
    const retry = await call("/account-runner", "POST");
    expect(retry.status).toBe(200);
    const result = (await retry.json()) as { data: Record<string, unknown> };
    expect(result.data).toMatchObject({
      name: "runner",
      visibility: "private",
      defaultBranch: "main",
      actionsEnabled: true,
      systemKind: "account_runner",
      viewerRole: "admin",
      canWrite: true,
    });
    const repositoryId = String(result.data.id);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repositories WHERE namespace_id = 'owner-ns' AND system_kind = 'account_runner'"
    ).first<{ count: number }>();
    expect(row?.count).toBe(1);
    expect(files.get(`${repositoryId}:README.md`)).toContain("service configuration");
    const workflow = files.get(`${repositoryId}:.github/workflows/runner.yml`);
    expect(workflow).toContain("workflow_dispatch: {}");
    expect(workflow).not.toContain("push:");
    expect(workflow).toContain("need-tool-node");
    expect(workflow).toContain("need-time-5m");
    expect(parseRunnerWorkflow(".github/workflows/runner.yml", workflow!)).toMatchObject({
      workflow: { triggers: ["workflow_dispatch"] },
      labels: ["self-hosted", "need-tool-node", "need-time-5m"],
      timeoutMinutes: 5,
    });
    expect(gitEdits.filter((edit) => edit.repositoryId === repositoryId)).toHaveLength(2);
    expect(
      (await (await call("/account-runner", "GET")).json()) as { data: unknown }
    ).toMatchObject({
      data: { repository: { id: repositoryId, systemKind: "account_runner" } },
    });
  });

  it("rejects tokens and refuses normal personal runner-name creation", async () => {
    const tokenHeaders = headers("owner", "owner");
    tokenHeaders.set(
      "X-GitEdge-Access-Token",
      JSON.stringify({ id: "token", scopes: ["repo:read"] })
    );
    const tokenResponse = await forge.fetch(
      new Request("https://forge.test/account-runner", { headers: tokenHeaders }),
      forgeEnv
    );
    expect(tokenResponse.status).toBe(403);
    const response = await call("/repositories", "POST", "other", "other", {
      owner: "other",
      slug: "runner",
      visibility: "private",
      description: "",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "runner_path_reserved" } });
  });

  it("keeps the runner name available in organization namespaces", async () => {
    const organization = await call("/organizations", "POST", "owner", "owner", {
      slug: "team",
      displayName: "Team",
      description: "",
    });
    expect(organization.status).toBe(201);
    const repository = await call("/repositories", "POST", "owner", "owner", {
      owner: "team",
      slug: "runner",
      visibility: "private",
      description: "",
    });
    expect(repository.status).toBe(201);
    expect(await repository.json()).toMatchObject({ data: { name: "runner", owner: "team" } });
  });

  it("rejects live, retained-route, and active-import conflicts without adopting them", async () => {
    await env.DB.prepare(
      "INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES ('live-runner','other-ns','other','runner','repo:live-runner','private','',1,1)"
    ).run();
    const live = await call("/account-runner", "POST", "other", "other");
    expect(live.status).toBe(409);
    expect(
      await env.DB.prepare("SELECT system_kind FROM repositories WHERE id='live-runner'").first()
    ).toMatchObject({ system_kind: null });

    await env.DB.prepare(
      "INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,created_at,updated_at) VALUES ('renamed','conflict-ns','conflict','renamed','repo:renamed','private','',1,1)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO repository_paths(namespace_id,slug,repository_id) VALUES ('conflict-ns','runner','renamed')"
    ).run();
    const historical = await call("/account-runner", "POST", "conflict", "conflict");
    expect(historical.status).toBe(409);
    await env.DB.prepare(
      "DELETE FROM repository_paths WHERE namespace_id='conflict-ns' AND slug='runner'"
    ).run();
    await env.DB.prepare(
      "INSERT INTO repository_imports (id,namespace_id,created_by,slug,visibility,description,source_url,status,created_at,updated_at) VALUES ('active-import','conflict-ns','conflict','runner','private','','https://git.example/repo.git','queued',1,1)"
    ).run();
    const importing = await call("/account-runner", "POST", "conflict", "conflict");
    expect(importing.status).toBe(409);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repositories WHERE namespace_id='conflict-ns' AND system_kind='account_runner'"
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("makes repository identity constraints fail closed at the database boundary", async () => {
    const owner = await env.DB.prepare("SELECT id FROM namespaces WHERE id='owner-ns'").first<{
      id: string;
    }>();
    expect(owner).not.toBeNull();
    await expect(
      env.DB.prepare(
        "INSERT INTO repositories (id,namespace_id,created_by,slug,do_name,visibility,description,system_kind,created_at,updated_at) VALUES ('invalid-runner','owner-ns','owner','runner','repo:invalid','public','', 'account_runner',1,1)"
      ).run()
    ).rejects.toThrow();
    const ownerRunner = await env.DB.prepare(
      "SELECT id FROM repositories WHERE namespace_id='owner-ns' AND system_kind='account_runner'"
    ).first<{ id: string }>();
    expect(ownerRunner).not.toBeNull();
    await expect(
      env.DB.prepare(
        "UPDATE repositories SET namespace_id='other-ns',created_by='other' WHERE id=?"
      )
        .bind(ownerRunner!.id)
        .run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE repositories SET created_by='other' WHERE id=?")
        .bind(ownerRunner!.id)
        .run()
    ).rejects.toThrow();
  });
});
