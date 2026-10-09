import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import type { RepositoryImport } from "../../packages/contracts/src/index";
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
  other: { id: "other-id", identifier: "other", groupKey: "free" },
};
let failNextImport: ArtifactsErrorCode | null = null;
const importing: Artifacts = Object.assign(Object.create(artifacts), {
  import: async (params: Parameters<Artifacts["import"]>[0]) => {
    if (failNextImport) {
      const code = failNextImport;
      failNextImport = null;
      throw Object.assign(new Error(code), { name: "ArtifactsError", code, numericCode: 1 });
    }
    return artifacts.import(params);
  },
});
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: importing,
  GIT: {
    fetch: (request: Request) =>
      gitWorker.fetch(request, { DB: env.DB, ARTIFACTS: importing }, executionContext),
  },
};
const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const pending: Promise<unknown>[] = [];
const collectingContext = {
  waitUntil: (task: Promise<unknown>) => void pending.push(task),
  passThroughOnException() {},
} as unknown as ExecutionContext;

async function call(
  path: string,
  method = "GET",
  user: keyof typeof users = "owner",
  body?: unknown
) {
  const headers = trustedHeaders(users[user]);
  headers.set("Content-Type", "application/json");
  const response = await forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    forgeEnv,
    collectingContext
  );
  await Promise.all(pending.splice(0));
  return response;
}
async function job(response: Response): Promise<RepositoryImport> {
  return ((await response.json()) as { data: RepositoryImport }).data;
}
const input = {
  sourceUrl: "https://example.com/acme/widgets.git",
  owner: "owner",
  slug: "widgets",
  visibility: "private",
  description: "Imported",
};

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
});

describe("Repository import jobs", () => {
  it("imports a public remote and records the repository only on success", async () => {
    const created = await call("/repository-imports", "POST", "owner", input);
    expect(created.status).toBe(202);
    const queued = await job(created);
    expect(queued.id).toBeTruthy();
    const status = await job(await call(`/repository-imports/${queued.id}`));
    expect(status.status).toBe("succeeded");
    expect(status.repositoryId).toBeTruthy();
    const row = await env.DB.prepare(
      "SELECT artifact_name, remote, visibility FROM repositories WHERE id = ?"
    )
      .bind(status.repositoryId)
      .first<{ artifact_name: string; remote: string; visibility: string }>();
    expect(row?.visibility).toBe("private");
    expect(
      artifacts.snapshot(row?.artifact_name ?? "").tokens.every((t) => t.state === "revoked")
    ).toBe(true);
  });

  it("leaves no repository behind after a failure and allows retry", async () => {
    failNextImport = "UPSTREAM_UNAVAILABLE";
    const failed = await job(
      await call("/repository-imports", "POST", "owner", { ...input, slug: "retry-me" })
    );
    const status = await job(await call(`/repository-imports/${failed.id}`));
    expect(status.status).toBe("failed");
    expect(status.errorCode).toBe("upstream_unavailable");
    const none = await env.DB.prepare(
      "SELECT id FROM repositories WHERE slug = 'retry-me'"
    ).first();
    expect(none).toBeNull();
    const retried = await call(`/repository-imports/${failed.id}/retry`, "POST");
    expect(retried.status).toBe(202);
    const done = await job(await call(`/repository-imports/${failed.id}`));
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(2);
    expect((await call(`/repository-imports/${failed.id}/retry`, "POST")).status).toBe(409);
  });

  it("rejects unsafe sources, duplicate names and unauthorized owners", async () => {
    for (const sourceUrl of [
      "http://example.com/a.git",
      "https://127.0.0.1/a.git",
      "https://localhost/a.git",
      "https://user:pw@example.com/a.git",
      "https://example.com:8443/a.git",
    ]) {
      const response = await call("/repository-imports", "POST", "owner", {
        ...input,
        sourceUrl,
        slug: "bad",
      });
      expect(response.status).toBe(422);
    }
    expect((await call("/repository-imports", "POST", "owner", input)).status).toBe(409);
    expect(
      (await call("/repository-imports", "POST", "other", { ...input, slug: "intruder" })).status
    ).toBe(403);
    expect(
      (await call("/repository-imports", "POST", "other", { ...input, owner: "nobody" })).status
    ).toBe(404);
  });

  it("hides jobs from other users and marks stale running jobs as failed", async () => {
    const created = await job(
      await call("/repository-imports", "POST", "owner", { ...input, slug: "stale" })
    );
    expect((await call(`/repository-imports/${created.id}`, "GET", "other")).status).toBe(404);
    expect((await call(`/repository-imports/${created.id}/retry`, "POST", "other")).status).toBe(
      404
    );
    await env.DB.prepare(
      "UPDATE repository_imports SET status='running', repository_id=NULL, updated_at=1 WHERE id=?"
    )
      .bind(created.id)
      .run();
    const stale = await job(await call(`/repository-imports/${created.id}`));
    expect(stale.status).toBe("failed");
    expect(stale.errorCode).toBe("timed_out");
  });

  it("serializes concurrent claims of one job", async () => {
    const { runImport } = await import("../../workers/forge/src/imports");
    failNextImport = null;
    const row = await env.DB.prepare(
      "SELECT id FROM repository_imports WHERE slug = 'stale'"
    ).first<{ id: string }>();
    await env.DB.prepare("UPDATE repository_imports SET status='queued' WHERE id=?")
      .bind(row?.id ?? "")
      .run();
    const before = await env.DB.prepare("SELECT attempt FROM repository_imports WHERE id=?")
      .bind(row?.id ?? "")
      .first<{ attempt: number }>();
    await Promise.all([runImport(forgeEnv, row?.id ?? ""), runImport(forgeEnv, row?.id ?? "")]);
    const after = await env.DB.prepare("SELECT attempt FROM repository_imports WHERE id=?")
      .bind(row?.id ?? "")
      .first<{ attempt: number }>();
    expect((after?.attempt ?? 0) - (before?.attempt ?? 0)).toBe(1);
  });
});
