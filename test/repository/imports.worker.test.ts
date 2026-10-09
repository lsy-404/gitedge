import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import { runImport } from "../../workers/forge/src/imports";
import gitWorker from "../../workers/git/src/index";
import { handleInternalImports } from "../../workers/git/src/imports";
import type { HostResolver } from "../../workers/git/src/public-host";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import type { RepositoryImport } from "../../packages/contracts/src/index";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

function artifactsError(code: ArtifactsErrorCode): Error {
  return Object.assign(new Error(code), { name: "ArtifactsError", code, numericCode: 1 });
}

/** Mirrors the platform: import() can resolve while the copy is still running. */
class ImportingArtifacts extends FixtureArtifacts {
  failNext: ArtifactsErrorCode | null = null;
  hold = false;
  readonly pending = new Set<string>();

  override async import(params: Parameters<Artifacts["import"]>[0]) {
    if (this.failNext) {
      const code = this.failNext;
      this.failNext = null;
      throw artifactsError(code);
    }
    const created = await super.import(params);
    if (this.hold) this.pending.add(created.name);
    return created;
  }

  override async get(name: string) {
    if (this.pending.has(name)) throw artifactsError("IMPORT_IN_PROGRESS");
    return super.get(name);
  }
}

const artifacts = new ImportingArtifacts();
const users = {
  owner: { id: "owner-id", identifier: "owner", groupKey: "free" },
  other: { id: "other-id", identifier: "other", groupKey: "free" },
};
const resolveHost: HostResolver = async (hostname) =>
  hostname === "private.example.com" ? { ok: false, reason: "private_address" } : { ok: true };
const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: {
    fetch: (request: Request) =>
      new URL(request.url).pathname.startsWith("/internal/imports")
        ? handleInternalImports(request, gitEnv, resolveHost)
        : gitWorker.fetch(request, gitEnv, createExecutionContext()),
  },
};

async function call(
  path: string,
  method = "GET",
  user: keyof typeof users = "owner",
  body?: unknown
) {
  const headers = trustedHeaders(users[user]);
  headers.set("Content-Type", "application/json");
  const ctx = createExecutionContext();
  const response = await forge.fetch(
    new Request(`https://forge.test${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    forgeEnv,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function job(response: Response): Promise<RepositoryImport> {
  return ((await response.json()) as { data: RepositoryImport }).data;
}
async function artifactName(id: string): Promise<string> {
  const row = await env.DB.prepare("SELECT artifact_name FROM repository_imports WHERE id = ?")
    .bind(id)
    .first<{ artifact_name: string }>();
  return row?.artifact_name ?? "";
}
async function allowNextCheck(id: string): Promise<void> {
  await env.DB.prepare("UPDATE repository_imports SET updated_at = updated_at - 5000 WHERE id = ?")
    .bind(id)
    .run();
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
    "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('ns','owner','owner-id',1,'personal'),('ns-shared','shared','owner-id',1,'personal')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('ns','owner-id','owner',1),('ns-shared','owner-id','owner',1)"
  ).run();
});

describe("Repository import jobs", () => {
  it("imports a public remote and records the repository only on success", async () => {
    const created = await call("/repository-imports", "POST", "owner", input);
    expect(created.status).toBe(202);
    const queued = await job(created);
    const status = await job(await call(`/repository-imports/${queued.id}`));
    expect(status.status).toBe("succeeded");
    expect(status.repositoryId).toBeTruthy();
    const row = await env.DB.prepare(
      "SELECT artifact_name, visibility FROM repositories WHERE id = ?"
    )
      .bind(status.repositoryId)
      .first<{ artifact_name: string; visibility: string }>();
    expect(row?.visibility).toBe("private");
    const tokens = artifacts.snapshot(row?.artifact_name ?? "").tokens;
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.state === "revoked")).toBe(true);
  });

  it("waits while Artifacts is still importing and hides the repository until ready", async () => {
    artifacts.hold = true;
    const started = await job(
      await call("/repository-imports", "POST", "owner", { ...input, slug: "slow" })
    );
    artifacts.hold = false;
    const name = await artifactName(started.id);
    expect(artifacts.pending.has(name)).toBe(true);
    await allowNextCheck(started.id);
    const waiting = await job(await call(`/repository-imports/${started.id}`));
    expect(waiting).toMatchObject({ status: "running", progress: "importing" });
    expect(
      await env.DB.prepare("SELECT id FROM repositories WHERE slug = 'slow'").first()
    ).toBeNull();
    const create = await call("/repositories", "POST", "owner", {
      owner: "owner",
      slug: "slow",
      description: "",
      visibility: "private",
    });
    expect(create.status).toBe(409);

    artifacts.pending.delete(name);
    await allowNextCheck(started.id);
    const [first, second] = await Promise.all([
      call(`/repository-imports/${started.id}`),
      call(`/repository-imports/${started.id}`),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const done = await job(await call(`/repository-imports/${started.id}`));
    expect(done.status).toBe("succeeded");
    const repositories = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM repositories WHERE slug = 'slow'"
    ).first<{ count: number }>();
    expect(repositories?.count).toBe(1);
    expect(artifacts.snapshot(name).tokens.every((token) => token.state === "revoked")).toBe(true);
  });

  it("leaves no repository behind after a failure and allows retry", async () => {
    artifacts.failNext = "UPSTREAM_UNAVAILABLE";
    const failed = await job(
      await call("/repository-imports", "POST", "owner", { ...input, slug: "retry-me" })
    );
    const firstName = await artifactName(failed.id);
    const status = await job(await call(`/repository-imports/${failed.id}`));
    expect(status.status).toBe("failed");
    expect(status.errorCode).toBe("upstream_unavailable");
    expect(artifacts.repositories.has(firstName)).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM repositories WHERE slug = 'retry-me'").first()
    ).toBeNull();
    const retried = await call(`/repository-imports/${failed.id}/retry`, "POST");
    expect(retried.status).toBe(202);
    const done = await job(await call(`/repository-imports/${failed.id}`));
    expect(done.status).toBe("succeeded");
    expect(done.attempt).toBe(2);
    expect(await artifactName(failed.id)).not.toBe(firstName);
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

  it("fails hosts that resolve to private addresses without creating storage", async () => {
    const before = artifacts.repositories.size;
    const created = await job(
      await call("/repository-imports", "POST", "owner", {
        ...input,
        sourceUrl: "https://private.example.com/a.git",
        slug: "rebound",
      })
    );
    const status = await job(await call(`/repository-imports/${created.id}`));
    expect(status).toMatchObject({ status: "failed", errorCode: "invalid_url" });
    expect(artifacts.repositories.size).toBe(before);
  });

  it("fails and discards the attempt when owner access is removed mid-import", async () => {
    artifacts.hold = true;
    const started = await job(
      await call("/repository-imports", "POST", "owner", {
        ...input,
        owner: "shared",
        slug: "revoked",
      })
    );
    artifacts.hold = false;
    const name = await artifactName(started.id);
    await env.DB.prepare(
      "UPDATE namespaces SET created_by = 'other-id' WHERE id = 'ns-shared'"
    ).run();
    artifacts.pending.delete(name);
    await allowNextCheck(started.id);
    const status = await job(await call(`/repository-imports/${started.id}`));
    expect(status).toMatchObject({ status: "failed", errorCode: "access_revoked" });
    expect(artifacts.repositories.has(name)).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM repositories WHERE slug = 'revoked'").first()
    ).toBeNull();
  });

  it("hides jobs from other users and times out lost attempts with cleanup", async () => {
    artifacts.hold = true;
    const created = await job(
      await call("/repository-imports", "POST", "owner", { ...input, slug: "stale" })
    );
    artifacts.hold = false;
    const name = await artifactName(created.id);
    expect((await call(`/repository-imports/${created.id}`, "GET", "other")).status).toBe(404);
    expect((await call(`/repository-imports/${created.id}/retry`, "POST", "other")).status).toBe(
      404
    );
    const listed = (await (await call("/repository-imports")).json()) as {
      data: RepositoryImport[];
    };
    expect(listed.data.some((item) => item.id === created.id)).toBe(true);
    await env.DB.prepare(
      "UPDATE repository_imports SET progress='starting', updated_at=1, started_at=1 WHERE id=?"
    )
      .bind(created.id)
      .run();
    const stale = await job(await call(`/repository-imports/${created.id}`));
    expect(stale).toMatchObject({ status: "failed", errorCode: "timed_out" });
    expect(artifacts.repositories.has(name)).toBe(false);
  });

  it("serializes concurrent claims of one job", async () => {
    const row = await env.DB.prepare(
      "SELECT id, attempt FROM repository_imports WHERE slug = 'stale'"
    ).first<{ id: string; attempt: number }>();
    const id = row?.id ?? "";
    await env.DB.prepare("UPDATE repository_imports SET status='queued' WHERE id=?").bind(id).run();
    await Promise.all([runImport(forgeEnv, id), runImport(forgeEnv, id)]);
    const after = await env.DB.prepare("SELECT attempt, status FROM repository_imports WHERE id=?")
      .bind(id)
      .first<{ attempt: number; status: string }>();
    expect((after?.attempt ?? 0) - (row?.attempt ?? 0)).toBe(1);
    expect(after?.status).toBe("succeeded");
  });

  it("keeps the internal Git import endpoints off public hosts", async () => {
    for (const path of ["/internal/imports", "/internal/imports/discard"]) {
      const response = await gitWorker.fetch(
        new Request(`https://gitedge.example.com${path}`, {
          method: "POST",
          body: JSON.stringify({ name: "repo-x" }),
        }),
        gitEnv,
        createExecutionContext()
      );
      expect(response.status).toBe(404);
    }
  });
});
