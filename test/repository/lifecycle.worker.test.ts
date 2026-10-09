import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { purgeDueRepositories } from "../../workers/forge/src/lifecycle";
import { handleGitApi } from "../../workers/git/src/api";
import { proxyGitTransport } from "../../workers/git/src/transport";
import { resolveRepositoryPath } from "../../src/worker/common/repositories";
import { REPOSITORY_RESTORE_WINDOW_MS, trustedHeaders } from "../../packages/contracts/src/index";
import { runSqlScript } from "../support/database";
import { grantCollaborator, grantOrganizationMember } from "../support/membership";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
const users = {
  owner: { id: "owner-id", identifier: "owner", groupKey: "staff" },
  admin: { id: "admin-id", identifier: "admin", groupKey: "free" },
  writer: { id: "writer-id", identifier: "writer", groupKey: "free" },
  outsider: { id: "outsider-id", identifier: "outsider", groupKey: "free" },
  quota: { id: "quota-id", identifier: "quota", groupKey: "tiny" },
};
type UserKey = keyof typeof users;
const revocations: unknown[] = [];
let revocationFails = false;
const gitPurgeRequests: { repositoryId: string; after: string | null }[] = [];
let gitPurgeBudget = Number.POSITIVE_INFINITY;
const forgeEnv = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  USER_GROUP_LIMITS_JSON: JSON.stringify({
    tiny: { maxRepositories: 1 },
    staff: { maxRepositories: 100 },
  }),
  GIT: {
    fetch: async (request: Request) => {
      gitPurgeRequests.push(await request.clone().json());
      if (gitPurgeRequests.length > gitPurgeBudget)
        return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      return gitWorker.fetch(request, gitEnv);
    },
  },
  AUTH: {
    fetch: async (request: Request) => {
      revocations.push(await request.json());
      return revocationFails
        ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 })
        : Response.json({ data: { revoked: 0 } });
    },
  },
};

async function call(
  path: string,
  method = "GET",
  user: UserKey | null = "owner",
  body?: unknown,
  recentAuthAt: number | null = Date.now()
) {
  const headers = trustedHeaders(
    user ? { ...users[user], ...(recentAuthAt === null ? {} : { recentAuthAt }) } : undefined
  );
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
async function data<T = Record<string, unknown>>(response: Response): Promise<T> {
  const body: { data: T } = await response.json();
  return body.data;
}
async function createRepository(
  owner: string,
  slug: string,
  visibility = "private",
  user: UserKey = "owner"
) {
  const response = await call("/repositories", "POST", user, { owner, slug, visibility });
  expect(response.status).toBe(201);
  return (await data<{ id: string }>(response)).id;
}
async function gitStatus(path: string, user: UserKey | null = "owner") {
  const headers = trustedHeaders(user ? users[user] : undefined);
  return handleGitApi(new Request("https://forge.test" + path, { headers }), gitEnv);
}
async function repositoryRows(id: string) {
  return env.DB.prepare(
    "SELECT slug, deleted_slug AS deletedSlug, purge_state AS state FROM repositories WHERE id = ?"
  )
    .bind(id)
    .all<{ slug: string; deletedSlug: string | null; state: string | null }>();
}
async function purgeColumns(id: string) {
  return env.DB.prepare(
    "SELECT purge_state AS state, purge_cursor AS cursor, purge_retry_at AS retryAt FROM repositories WHERE id = ?"
  )
    .bind(id)
    .first<{ state: string | null; cursor: string | null; retryAt: number | null }>();
}
async function insertSessions(repositoryId: string, prefix: string, count: number) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO auth_agents(id,user_id,name,description,created_at) VALUES('agent-purge','owner-id','purge-agent','',1)"
  ).run();
  const names: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${String(index).padStart(3, "0")}`;
    const fork = await artifacts.create(`fork-${id}`);
    names.push(fork.name);
    await env.DB.prepare(
      "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,permission,status,created_at,expires_at) VALUES(?,'agent-purge','owner-id',?,?,'token',?,?,'main','write','active',1,?)"
    )
      .bind(id, repositoryId, `hash-${id}`, fork.name, fork.remote, Date.now() + 60_000)
      .run();
  }
  return names;
}
async function expireGrace(id: string) {
  await env.DB.prepare("UPDATE repositories SET purge_after = 1 WHERE id = ?").bind(id).run();
}

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of Object.values(users))
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'salt','hash',1)"
    )
      .bind(user.id, user.identifier)
      .run();
  for (const [id, slug, owner] of [
    ["ns-owner", "owner", "owner-id"],
    ["ns-outsider", "outsider", "outsider-id"],
    ["ns-quota", "quota", "quota-id"],
  ])
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES(?,?,?,1,'personal')"
      ).bind(id, slug, owner),
      env.DB.prepare(
        "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES(?,?,'owner',1)"
      ).bind(id, owner),
    ]);
  for (const slug of ["acme", "other-org"]) {
    const created = await call("/organizations", "POST", "owner", {
      slug,
      displayName: slug,
      description: "",
    });
    expect(created.status).toBe(201);
  }
});

describe("repository deletion", () => {
  it("restricts deletion to administrators and a matching confirmation", async () => {
    const privateId = await createRepository("owner", "guarded", "private");
    const publicId = await createRepository("owner", "guarded-public", "public");
    await grantCollaborator(env.DB, publicId, users.writer.id, "write");
    expect(
      (
        await call(`/repositories/${privateId}`, "DELETE", "outsider", {
          confirm: "owner/guarded",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await call(`/repositories/${publicId}`, "DELETE", "outsider", {
          confirm: "owner/guarded-public",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(`/repositories/${publicId}`, "DELETE", "writer", {
          confirm: "owner/guarded-public",
        })
      ).status
    ).toBe(403);
    expect(
      (await call(`/repositories/${privateId}`, "DELETE", "owner", { confirm: "owner/other" }))
        .status
    ).toBe(400);
    expect((await call(`/repositories/${privateId}`, "DELETE", "owner")).status).toBe(400);
    expect((await call(`/repositories/${privateId}`)).status).toBe(200);
  });

  it("makes a deleted repository indistinguishable from a missing one", async () => {
    const id = await createRepository("owner", "vanish", "public");
    expect((await call("/repositories/by-name/owner/vanish", "GET", null)).status).toBe(200);
    revocations.length = 0;
    const deleted = await call(`/repositories/${id}`, "DELETE", "owner", {
      confirm: "owner/vanish",
    });
    expect(deleted.status).toBe(200);
    expect(revocations).toContainEqual({ repositoryId: id });
    const result = await data<{ deletedAt: number; purgeAfter: number }>(deleted);
    expect(result.purgeAfter - result.deletedAt).toBe(REPOSITORY_RESTORE_WINDOW_MS);

    for (const viewer of ["owner", null] as const) {
      expect((await call(`/repositories/${id}`, "GET", viewer)).status).toBe(404);
      expect((await call(`/repositories/${id}/issues`, "GET", viewer)).status).toBe(404);
      expect((await call("/repositories/by-name/owner/vanish", "GET", viewer)).status).toBe(404);
      expect((await gitStatus(`/repositories/${id}/tree`, viewer)).status).toBe(404);
    }
    const transport = await proxyGitTransport(
      new Request("https://forge.test/owner/vanish.git/info/refs?service=git-upload-pack"),
      gitEnv
    );
    expect(transport.status).toBe(404);
    expect(await resolveRepositoryPath(env.DB, "owner", "vanish")).toBeNull();
    const listing = await data<{ id: string }[]>(await call("/repositories"));
    expect(listing.map((repo) => repo.id)).not.toContain(id);
    const profile = await call("/profiles/owner", "GET", null);
    expect(JSON.stringify(await profile.json())).not.toContain("vanish");
  });

  it("lists recent deletions for administrators only and restores within the grace period", async () => {
    const id = await createRepository("owner", "phoenix", "private");
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/phoenix" });
    const listed = await data<{ id: string; owner: string; name: string }[]>(
      await call("/deleted-repositories")
    );
    expect(listed).toContainEqual(expect.objectContaining({ id, owner: "owner", name: "phoenix" }));
    expect(await data(await call("/deleted-repositories", "GET", "outsider"))).toEqual([]);
    expect((await call(`/deleted-repositories/${id}/restore`, "POST", "outsider")).status).toBe(
      404
    );

    const restored = await call(`/deleted-repositories/${id}/restore`, "POST", "owner");
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ data: { id, owner: "owner", name: "phoenix" } });
    expect((await call("/repositories/by-name/owner/phoenix")).status).toBe(200);
    expect((await call(`/repositories/${id}`, "GET", "outsider")).status).toBe(404);
    expect(await data(await call("/deleted-repositories"))).not.toContainEqual(
      expect.objectContaining({ id })
    );
  });

  it("fails restoration cleanly when the name was reused or the window closed", async () => {
    const id = await createRepository("owner", "reused", "private");
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/reused" });
    const replacement = await createRepository("owner", "reused", "private");
    const conflict = await call(`/deleted-repositories/${id}/restore`, "POST", "owner");
    expect(conflict.status).toBe(409);
    expect((await call(`/repositories/${replacement}`)).status).toBe(200);
    expect(await repositoryRows(id)).toMatchObject({
      results: [{ slug: `deleted~${id}`, deletedSlug: "reused" }],
    });

    const late = await createRepository("owner", "too-late", "private");
    await call(`/repositories/${late}`, "DELETE", "owner", { confirm: "owner/too-late" });
    await expireGrace(late);
    expect((await call(`/deleted-repositories/${late}/restore`, "POST", "owner")).status).toBe(409);
  });
});

describe("recent authentication", () => {
  it("is required to delete, purge or transfer repositories and to delete organizations", async () => {
    const id = await createRepository("owner", "sudo-guarded", "private");
    const stale = Date.now() - 11 * 60 * 1000;
    const expectReauth = async (response: Response) => {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "reauth_required" } });
    };
    await expectReauth(
      await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/sudo-guarded" }, stale)
    );
    await expectReauth(
      await call(
        `/repositories/${id}/transfer`,
        "POST",
        "owner",
        { owner: "acme", confirm: "owner/sudo-guarded" },
        null
      )
    );
    await expectReauth(
      await call("/organizations/other-org", "DELETE", "owner", { confirm: "other-org" }, stale)
    );
    expect((await call(`/repositories/${id}`)).status).toBe(200);

    expect(
      (await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/sudo-guarded" }))
        .status
    ).toBe(200);
    await expectReauth(
      await call(
        `/deleted-repositories/${id}`,
        "DELETE",
        "owner",
        { confirm: "owner/sudo-guarded" },
        stale
      )
    );
    expect(
      (await call(`/deleted-repositories/${id}/restore`, "POST", "owner", undefined, stale)).status
    ).toBe(200);
  });
});

describe("repository quota", () => {
  it("counts deleted repositories until they are purged", async () => {
    const id = await createRepository("quota", "first", "private", "quota");
    await call(`/repositories/${id}`, "DELETE", "quota", { confirm: "quota/first" });
    const blocked = await call("/repositories", "POST", "quota", {
      owner: "quota",
      slug: "second",
      visibility: "private",
    });
    expect(blocked.status).toBe(403);
    expect(
      (await call(`/deleted-repositories/${id}`, "DELETE", "quota", { confirm: "quota/first" }))
        .status
    ).toBe(200);
    await createRepository("quota", "second", "private", "quota");
  });
});

describe("repository purge", () => {
  it("revokes sessions, deletes Artifacts forks and rows, and is idempotent", async () => {
    const id = await createRepository("owner", "purged", "private");
    const artifactName = (await data<{ id: string }>(await call(`/repositories/${id}`))).id;
    expect(artifactName).toBe(id);
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id = ?")
      .bind(id)
      .first<{ name: string }>();
    const fork = await artifacts.create(`fork-${id}`);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_agents(id,user_id,name,description,created_at) VALUES('agent-purge','owner-id','purge-agent','',1)"
      ),
      env.DB.prepare(
        "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,permission,status,created_at,expires_at) VALUES('session-purge','agent-purge','owner-id',?,'hash','token',?,?,'main','write','active',1,?)"
      ).bind(id, fork.name, fork.remote, Date.now() + 60_000),
    ]);
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/purged" });

    await purgeDueRepositories(forgeEnv);
    expect(artifacts.repositories.has(fork.name)).toBe(true);

    await expireGrace(id);
    revocationFails = true;
    revocations.length = 0;
    await purgeDueRepositories(forgeEnv);
    expect(await repositoryRows(id)).toMatchObject({ results: [{ state: null }] });
    expect(artifacts.repositories.has(fork.name)).toBe(true);

    revocationFails = false;
    const retryAt = (await purgeColumns(id))?.retryAt ?? 0;
    expect(retryAt).toBeGreaterThan(Date.now());
    await purgeDueRepositories(forgeEnv);
    expect(artifacts.repositories.has(fork.name)).toBe(true);
    expect(await purgeDueRepositories(forgeEnv, retryAt)).toBeGreaterThanOrEqual(1);
    expect(revocations).toContainEqual({ repositoryId: id });
    expect(artifacts.repositories.has(fork.name)).toBe(false);
    expect(artifacts.repositories.has(row?.name ?? "")).toBe(false);
    expect((await repositoryRows(id)).results).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT 1 AS found FROM auth_agent_sessions WHERE id = 'session-purge'"
      ).first()
    ).toBeNull();
    expect(await purgeDueRepositories(forgeEnv, retryAt)).toBe(0);
  });

  it("deletes many session forks across bounded calls and resumes from the stored cursor", async () => {
    const id = await createRepository("owner", "crowded", "private");
    const forks = await insertSessions(id, `crowd-${id}`, 30);
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/crowded" });
    await expireGrace(id);
    gitPurgeRequests.length = 0;
    gitPurgeBudget = 1;
    const now = Date.now();
    await purgeDueRepositories(forgeEnv, now);
    gitPurgeBudget = Number.POSITIVE_INFINITY;
    const stalled = await purgeColumns(id);
    expect(stalled).toMatchObject({ state: "revoked", cursor: `crowd-${id}-024` });
    expect(stalled?.retryAt).toBeGreaterThan(now);
    expect(forks.filter((name) => artifacts.repositories.has(name))).toHaveLength(5);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM auth_agent_sessions WHERE repository_id = ?"
      )
        .bind(id)
        .first<{ count: number }>()
    ).toEqual({ count: 30 });

    gitPurgeRequests.length = 0;
    expect(await purgeDueRepositories(forgeEnv, stalled?.retryAt ?? now)).toBeGreaterThanOrEqual(1);
    expect(gitPurgeRequests).toContainEqual({ repositoryId: id, after: `crowd-${id}-024` });
    expect(gitPurgeRequests).not.toContainEqual({ repositoryId: id, after: null });
    expect(forks.some((name) => artifacts.repositories.has(name))).toBe(false);
    expect((await repositoryRows(id)).results).toEqual([]);
  });

  it("resumes after Artifacts were deleted but the row survived", async () => {
    const id = await createRepository("owner", "resumed", "private");
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id = ?")
      .bind(id)
      .first<{ name: string }>();
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/resumed" });
    await expireGrace(id);
    await env.DB.prepare("UPDATE repositories SET purge_state = 'revoked' WHERE id = ?")
      .bind(id)
      .run();
    await artifacts.delete(row?.name ?? "");
    expect(await purgeDueRepositories(forgeEnv)).toBe(1);
    expect((await repositoryRows(id)).results).toEqual([]);
  });

  it("refuses to purge live repositories and lets owners purge immediately", async () => {
    const live = await createRepository("owner", "live", "private");
    const response = await gitWorker.fetch(
      new Request("https://git.internal/internal/purge", {
        method: "POST",
        body: JSON.stringify({ repositoryId: live, after: null }),
      }),
      gitEnv
    );
    expect(response.status).toBe(404);
    expect((await call(`/repositories/${live}`)).status).toBe(200);

    await call(`/repositories/${live}`, "DELETE", "owner", { confirm: "owner/live" });
    expect(
      (await call(`/deleted-repositories/${live}`, "DELETE", "owner", { confirm: "nope" })).status
    ).toBe(400);
    expect(
      (await call(`/deleted-repositories/${live}`, "DELETE", "owner", { confirm: "owner/live" }))
        .status
    ).toBe(200);
    expect((await repositoryRows(live)).results).toEqual([]);
    expect(
      (await call(`/deleted-repositories/${live}`, "DELETE", "owner", { confirm: "owner/live" }))
        .status
    ).toBe(404);
  });
});

describe("repository transfer", () => {
  it("moves a repository to an owned organization and keeps old URLs working", async () => {
    const id = await createRepository("owner", "moving", "private");
    const body = { owner: "acme", confirm: "owner/moving" };
    expect((await call(`/repositories/${id}/transfer`, "POST", "outsider", body)).status).toBe(404);
    await grantCollaborator(env.DB, id, users.admin.id, "admin");
    expect((await call(`/repositories/${id}/transfer`, "POST", "admin", body)).status).toBe(403);
    expect(
      (await call(`/repositories/${id}/transfer`, "POST", "owner", { ...body, confirm: "x" }))
        .status
    ).toBe(400);
    expect(
      (await call(`/repositories/${id}/transfer`, "POST", "owner", { ...body, owner: "outsider" }))
        .status
    ).toBe(403);
    expect(
      (await call(`/repositories/${id}/transfer`, "POST", "owner", { ...body, owner: "owner" }))
        .status
    ).toBe(400);

    revocations.length = 0;
    const moved = await call(`/repositories/${id}/transfer`, "POST", "owner", body);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ data: { id, owner: "acme", name: "moving" } });
    expect(revocations).toContainEqual({ repositoryId: id });

    const redirected = await call("/repositories/by-name/owner/moving");
    expect(await redirected.json()).toMatchObject({ data: { id, owner: "acme" } });
    expect((await call("/repositories/by-name/acme/moving")).status).toBe(200);
    expect(await resolveRepositoryPath(env.DB, "owner", "moving")).toMatchObject({
      id,
      owner: "acme",
      slug: "moving",
    });
    const transport = await proxyGitTransport(
      new Request("https://forge.test/owner/moving.git/info/refs?service=git-upload-pack", {
        headers: trustedHeaders(users.owner),
      }),
      gitEnv
    );
    expect(transport.status).toBe(308);
    expect(transport.headers.get("Location")).toContain("/acme/moving.git/info/refs");
    expect(
      (
        await call("/repositories", "POST", "owner", {
          owner: "owner",
          slug: "moving",
          visibility: "private",
        })
      ).status
    ).toBe(409);
  });

  it("rejects name collisions in the target and supports organization to user transfers", async () => {
    const first = await createRepository("acme", "shared", "private");
    await createRepository("other-org", "shared", "private");
    expect(
      (
        await call(`/repositories/${first}/transfer`, "POST", "owner", {
          owner: "other-org",
          confirm: "acme/shared",
        })
      ).status
    ).toBe(409);
    expect((await call("/repositories/by-name/acme/shared")).status).toBe(200);

    const back = await call(`/repositories/${first}/transfer`, "POST", "owner", {
      owner: "owner",
      confirm: "acme/shared",
    });
    expect(back.status).toBe(200);
    expect(await back.json()).toMatchObject({ data: { owner: "owner", name: "shared" } });
  });

  it("does not let a soft-deleted repository be transferred", async () => {
    const id = await createRepository("owner", "ghost", "private");
    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "owner/ghost" });
    expect(
      (
        await call(`/repositories/${id}/transfer`, "POST", "owner", {
          owner: "acme",
          confirm: "owner/ghost",
        })
      ).status
    ).toBe(404);
  });
});

describe("organization deletion", () => {
  it("requires an owner, the slug as confirmation, and no remaining repositories", async () => {
    await call("/organizations/disposable", "GET", "owner");
    expect(
      (
        await call("/organizations", "POST", "owner", {
          slug: "disposable",
          displayName: "d",
          description: "",
        })
      ).status
    ).toBe(201);
    await grantOrganizationMember(env.DB, "disposable", users.writer.id, "member");
    const id = await createRepository("disposable", "inside", "private");

    expect(
      (await call("/organizations/disposable", "DELETE", "writer", { confirm: "disposable" }))
        .status
    ).toBe(403);
    expect(
      (await call("/organizations/disposable", "DELETE", "outsider", { confirm: "disposable" }))
        .status
    ).toBe(403);
    expect(
      (await call("/organizations/disposable", "DELETE", "owner", { confirm: "wrong" })).status
    ).toBe(400);
    const blocked = await call("/organizations/disposable", "DELETE", "owner", {
      confirm: "disposable",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "organization_not_empty" } });

    await call(`/repositories/${id}`, "DELETE", "owner", { confirm: "disposable/inside" });
    expect(
      (await call("/organizations/disposable", "DELETE", "owner", { confirm: "disposable" })).status
    ).toBe(409);

    await expireGrace(id);
    await purgeDueRepositories(forgeEnv);
    const removed = await call("/organizations/disposable", "DELETE", "owner", {
      confirm: "disposable",
    });
    expect(removed.status).toBe(204);
    expect((await call("/organizations/disposable")).status).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT 1 AS found FROM namespace_memberships WHERE namespace_id IN (SELECT id FROM namespaces WHERE slug = 'disposable')"
      ).first()
    ).toBeNull();
  });
});
