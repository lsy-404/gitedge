import { runSqlScript } from "../support/database";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
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

describe("account Runner repository", () => {
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
