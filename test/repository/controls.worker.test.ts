import { env } from "cloudflare:workers";
import { beforeAll, describe, it, expect } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";
const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const users = {
  owner: { id: "owner-id", identifier: "owner", groupKey: "free" },
  reader: { id: "reader-id", identifier: "reader", groupKey: "free" },
  writer: { id: "writer-id", identifier: "writer", groupKey: "free" },
};
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    fetch: async () => Response.json({ data: [{ name: "refs/heads/main", oid: "a".repeat(40) }] }),
  },
};
let repositoryId = "";
async function call(
  path: string,
  method = "GET",
  user: keyof typeof users | null = "owner",
  body?: unknown
) {
  const headers = trustedHeaders(user ? users[user] : undefined);
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request("https://forge.test" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    forgeEnv
  );
}
async function gitCall(
  resource: string,
  method: string,
  body: unknown,
  user: keyof typeof users = "owner"
) {
  const headers = trustedHeaders(users[user]);
  headers.set("Content-Type", "application/json");
  return gitWorker.fetch(
    new Request(`https://forge.test/repositories/${repositoryId}/${resource}`, {
      method,
      headers,
      body: JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts }
  );
}
beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of Object.values(users))
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'salt','hash',1)"
    )
      .bind(user.id, user.identifier)
      .run();
  await env.DB.prepare(
    "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('ns','owner','owner-id',1,'personal')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('ns','owner-id','owner',1)"
  ).run();
  const created = await call("/repositories", "POST", "owner", {
    owner: "owner",
    slug: ".github",
    visibility: "private",
  });
  expect(created.status).toBe(201);
  repositoryId = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json())
    .data.id;
});
describe("Repository control authorization and rename invariants", () => {
  it("keeps all historical URLs pointing to the current private repository and reserves aliases", async () => {
    expect(
      (
        await call(`/repositories/${repositoryId}/settings`, "PATCH", "owner", {
          name: "new.repo_name",
        })
      ).status
    ).toBe(200);
    const old = await call("/repositories/by-name/owner/.github");
    expect(old.status).toBe(200);
    expect(await old.json()).toMatchObject({ data: { id: repositoryId, name: "new.repo_name" } });
    expect((await call("/repositories/by-name/owner/.github", "GET", null)).status).toBe(404);
    expect(
      (
        await call("/repositories", "POST", "owner", {
          owner: "owner",
          slug: ".github",
          visibility: "public",
        })
      ).status
    ).toBe(409);
    expect(
      (await call(`/repositories/${repositoryId}/settings`, "PATCH", "owner", { name: ".github" }))
        .status
    ).toBe(200);
    expect((await call("/repositories/by-name/owner/new.repo_name")).status).toBe(200);
  });
  it("enforces read/write/admin collaborators across Forge and Git", async () => {
    const route = `/repositories/${repositoryId}/collaborators`;
    expect((await call(route, "PUT", "owner", { identifier: "reader", role: "read" })).status).toBe(
      200
    );
    expect((await call(`/repositories/${repositoryId}`, "GET", "reader")).status).toBe(200);
    const mine = await call("/repositories", "GET", "reader");
    expect(await mine.json()).toMatchObject({ data: [{ id: repositoryId, canWrite: false }] });
    expect(
      (
        await gitCall(
          "edit",
          "POST",
          { branch: "main", expectedOid: null, path: "README.md", content: "No", message: "No" },
          "reader"
        )
      ).status
    ).toBe(403);
    expect(
      (
        await call(`/repositories/${repositoryId}/settings`, "PATCH", "reader", {
          description: "No",
        })
      ).status
    ).toBe(403);
    expect(
      (await call(route, "PUT", "owner", { identifier: "writer", role: "write" })).status
    ).toBe(200);
    expect(
      (
        await call(`/repositories/${repositoryId}/branch-rules`, "POST", "writer", {
          pattern: "main",
        })
      ).status
    ).toBe(403);
    expect(
      (await call(route, "PUT", "owner", { identifier: "writer", role: "admin" })).status
    ).toBe(200);
    expect(
      (
        await call(`/repositories/${repositoryId}/settings`, "PATCH", "writer", {
          description: "Allowed",
        })
      ).status
    ).toBe(200);
    expect((await call(route + "/reader-id", "DELETE")).status).toBe(200);
    expect((await call(`/repositories/${repositoryId}`, "GET", "reader")).status).toBe(404);
  });
  it("blocks direct writes to protected refs before touching upstream storage", async () => {
    const created = await call(`/repositories/${repositoryId}/branch-rules`, "POST", "owner", {
      pattern: "main",
      requiredApprovals: 1,
      requiredStatusChecks: ["tests"],
    });
    expect(created.status).toBe(201);
    expect(
      (
        await gitCall("edit", "POST", {
          branch: "main",
          expectedOid: null,
          path: "README.md",
          content: "blocked",
          message: "blocked",
        })
      ).status
    ).toBe(403);
    const headers = trustedHeaders(users.owner);
    headers.set("X-GitEdge-Git-Grant", JSON.stringify({ repositoryId, permission: "write" }));
    const command = `${"0".repeat(40)} ${"a".repeat(40)} refs/heads/main\0report-status\n`;
    const body =
      (new TextEncoder().encode(command).length + 4).toString(16).padStart(4, "0") +
      command +
      "0000PACK";
    const pushed = await gitWorker.fetch(
      new Request("https://forge.test/owner/.github.git/git-receive-pack", {
        method: "POST",
        headers,
        body,
      }),
      { DB: env.DB, ARTIFACTS: artifacts }
    );
    expect(pushed.status).toBe(403);
  });

  it("reserves system CI identities, pins checks to the run OID, and attaches earlier runs to new PRs", async () => {
    await call(`/repositories/${repositoryId}/settings`, "PATCH", "owner", {
      actionsEnabled: true,
    });
    const oid = "a".repeat(40);
    await env.DB.prepare(
      "INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,check_status,check_conclusion) VALUES('run-one',?,?,'Verify','.github/workflows/verify.yml','topic','owner-id',1,'completed','success')"
    )
      .bind(repositoryId, oid)
      .run();
    const created = await call(`/repositories/${repositoryId}/pull-requests`, "POST", "owner", {
      title: "CI validation",
      baseRef: "main",
      headRef: "topic",
    });
    expect(created.status).toBe(201);
    const number = z.object({ data: z.object({ number: z.number() }) }).parse(await created.json())
      .data.number;
    const checks = await call(`/repositories/${repositoryId}/pull-requests/${number}/checks`);
    expect(await checks.json()).toMatchObject({
      data: [
        {
          commitOid: oid,
          status: "completed",
          conclusion: "success",
          actor: { kind: "ci", id: "gitedge-actions" },
        },
      ],
    });
    expect(
      (
        await call(
          `/repositories/${repositoryId}/pull-requests/${number}/checks`,
          "POST",
          "owner",
          {
            name: ".github/workflows/verify.yml",
            commitOid: oid,
            status: "completed",
            conclusion: "success",
          }
        )
      ).status
    ).toBe(403);
    const callback = (
      hostname: string,
      runId: string,
      status = "completed",
      conclusion: string | null = "success"
    ) =>
      forge.fetch(
        new Request(`https://${hostname}/internal/actions-check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId, status, conclusion, summary: "Verified" }),
        }),
        forgeEnv
      );
    expect((await callback("forge.test", "run-one")).status).toBe(404);
    await env.DB.prepare(
      "INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at) VALUES('run-two',?,?,'Verify','.github/workflows/verify.yml','topic','owner-id',2)"
    )
      .bind(repositoryId, oid)
      .run();
    expect((await callback("forge.internal", "run-two", "queued", null)).status).toBe(200);
    expect(await (await callback("forge.internal", "run-one")).json()).toMatchObject({
      data: { superseded: true },
    });
    const latest = await call(`/repositories/${repositoryId}/pull-requests/${number}/checks`);
    expect(await latest.json()).toMatchObject({
      data: [{ commitOid: oid, status: "queued", conclusion: null }],
    });
  });
  it("resolves the current snapshot when listing workflows without a caller OID", async () => {
    const response = await gitCall("snapshot?ref=main", "GET", undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { oid: "a".repeat(40), files: [], totalBytes: 0 },
    });
    expect((await gitCall("snapshot?ref=main&oid=invalid", "GET", undefined)).status).toBe(404);
    expect(
      (
        await call(`/repositories/${repositoryId}/pull-requests`, "POST", "owner", {
          title: "Invalid fully qualified branch",
          baseRef: "refs/heads/main",
          headRef: "topic",
        })
      ).status
    ).toBe(400);
  });
  it("enforces feature switches while keeping settings available", async () => {
    const flags = {
      issuesEnabled: false,
      pullsEnabled: false,
      discussionsEnabled: false,
      wikiEnabled: false,
      tasksEnabled: false,
      agentsEnabled: false,
      deploymentsEnabled: false,
      graphEnabled: false,
      actionsEnabled: false,
      onlineEditingEnabled: false,
    };
    expect(
      (await call(`/repositories/${repositoryId}/settings`, "PATCH", "owner", flags)).status
    ).toBe(200);
    for (const route of ["issues", "pull-requests", "discussions", "wiki", "tasks", "memory"])
      expect((await call(`/repositories/${repositoryId}/${route}`)).status, route).toBe(404);
    expect((await call(`/repositories/${repositoryId}/settings`)).status).toBe(200);
    expect(
      (
        await gitCall("edit", "POST", {
          branch: "topic",
          expectedOid: null,
          path: "file.txt",
          content: "No",
          message: "No",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await call(`/repositories/${repositoryId}/settings`, "PATCH", "owner", {
          allowMergeCommit: false,
          allowSquashMerge: false,
          allowRebaseMerge: false,
        })
      ).status
    ).toBe(400);
  });
});
