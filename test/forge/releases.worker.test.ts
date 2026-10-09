import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import { purgeRepository } from "../../workers/forge/src/lifecycle";
import { onReleaseEvent } from "../../workers/forge/src/release-events";
import {
  RELEASE_ASSET_MAX_BYTES,
  RELEASE_MAX_ASSETS,
  type ReleaseEvent,
} from "../../packages/contracts/src/releases";
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
  writer: { id: "writer-id", identifier: "writer", groupKey: "free" },
  reader: { id: "reader-id", identifier: "reader", groupKey: "free" },
  stranger: { id: "stranger-id", identifier: "stranger", groupKey: "free" },
};
type Actor = keyof typeof users | "anonymous" | "agent" | "token";
const existingTags = new Set<string>();
const gitCalls: { method: string; path: string; body: unknown }[] = [];
const events: ReleaseEvent[] = [];
let beforeTagResponse: (() => Promise<void>) | null = null;
const GIT = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body: unknown = request.method === "POST" ? await request.json() : null;
    gitCalls.push({ method: request.method, path: url.pathname + url.search, body });
    await beforeTagResponse?.();
    if (request.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      return Response.json({ data: existingTags.has(name) ? [{ name }] : [], truncated: false });
    }
    const parsed = z.object({ name: z.string() }).parse(body);
    if (existingTags.has(parsed.name))
      return Response.json(
        { error: { code: "tag_exists", message: "The tag already exists." } },
        { status: 409 }
      );
    existingTags.add(parsed.name);
    return Response.json({ data: { name: parsed.name } }, { status: 201 });
  },
};
let repositoryId = "";
let privateId = "";

function call(
  path: string,
  method: string,
  options: { actor?: Actor; body?: unknown; raw?: BodyInit; headers?: HeadersInit } = {}
) {
  const actor = options.actor ?? "owner";
  const headers = new Headers(options.headers);
  if (actor === "agent") {
    const base = trustedHeaders(users.owner);
    base.forEach((value, name) => headers.set(name, value));
    headers.set(
      "X-GitEdge-Agent-Session",
      JSON.stringify({
        id: "s",
        agentId: "a",
        agentName: "Agent",
        repositoryId,
        workspaceName: "w",
        permission: "write",
      })
    );
  } else if (actor === "token") {
    trustedHeaders({ ...users.owner, token: { id: "t", scopes: ["repo:write"] } }).forEach(
      (value, name) => headers.set(name, value)
    );
  } else if (actor !== "anonymous")
    trustedHeaders(users[actor]).forEach((value, name) => headers.set(name, value));
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request("https://forge.test" + path, {
      method,
      headers,
      body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    }),
    { DB: env.DB, ARTIFACTS: artifacts, GIT, RELEASE_ASSETS: env.RELEASE_ASSETS }
  );
}
const releaseSchema = z.object({
  data: z.object({
    id: z.string(),
    tagName: z.string(),
    title: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    publishedAt: z.number().nullable(),
    assets: z.array(z.object({ id: z.string(), name: z.string(), size: z.number() })),
  }),
});
async function createRelease(
  body: Record<string, unknown>,
  options: { actor?: Actor; repository?: string } = {}
) {
  const response = await call(
    `/repositories/${options.repository ?? repositoryId}/releases`,
    "POST",
    {
      actor: options.actor,
      body,
    }
  );
  return response;
}
async function created(body: Record<string, unknown>) {
  const response = await createRelease(body);
  expect(response.status).toBe(201);
  return releaseSchema.parse(await response.json()).data;
}
function upload(
  releaseId: string,
  name: string,
  content: string | Uint8Array,
  actor: Actor = "owner",
  length?: number
) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return call(
    `/repositories/${repositoryId}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    "PUT",
    {
      actor,
      raw: bytes as BodyInit,
      headers: {
        "Content-Length": String(length ?? bytes.byteLength),
        "Content-Type": "application/zip",
      },
    }
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
  for (const [slug, visibility] of [
    ["open", "public"],
    ["closed", "private"],
  ] as const) {
    const response = await call("/repositories", "POST", {
      body: { owner: "owner", slug, visibility },
    });
    const id = z.object({ data: z.object({ id: z.string() }) }).parse(await response.json())
      .data.id;
    if (slug === "open") repositoryId = id;
    else privateId = id;
    await env.DB.prepare(
      "INSERT INTO repository_collaborators(repository_id,user_id,role,created_at) SELECT ?, id, CASE identifier WHEN 'writer' THEN 'write' ELSE 'read' END, 1 FROM users WHERE identifier IN ('writer','reader')"
    )
      .bind(id)
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO auth_agents(id,user_id,name,created_at) VALUES('a','owner-id','Agent',1)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO auth_agent_sessions(id,agent_id,user_id,repository_id,token_hash,git_token_id,workspace_name,remote,base_ref,base_oid,permission,status,created_at,expires_at) VALUES('s','a','owner-id',?,'hash','tok','w','https://artifacts.example.test/w.git','main',NULL,'write','active',1,?)"
  )
    .bind(repositoryId, Date.now() + 3_600_000)
    .run();
  onReleaseEvent(async (event) => {
    events.push(event);
  });
});
beforeEach(() => {
  gitCalls.length = 0;
  events.length = 0;
  beforeTagResponse = null;
});
const targetSchema = z.object({ data: z.object({ target: z.string().nullable() }) });

describe("release authorization", () => {
  it("lets only writers create, edit, upload and delete", async () => {
    for (const actor of ["reader", "stranger", "anonymous"] as const) {
      const response = await createRelease({ tagName: "v0", target: "main" }, { actor });
      expect([401, 403]).toContain(response.status);
    }
    expect(
      (await createRelease({ tagName: "v0", target: "main" }, { actor: "agent" })).status
    ).toBe(403);
    const release = await created({ tagName: "v1.0.0", target: "main" });
    expect(
      (
        await call(`/repositories/${repositoryId}/releases/${release.id}`, "PATCH", {
          actor: "reader",
          body: { title: "x" },
        })
      ).status
    ).toBe(403);
    expect((await upload(release.id, "a.zip", "x", "reader")).status).toBe(403);
    expect(
      (
        await call(`/repositories/${repositoryId}/releases/${release.id}`, "DELETE", {
          actor: "writer",
        })
      ).status
    ).toBe(403);
  });

  it("lets writers publish through a token with the write scope", async () => {
    const response = await createRelease(
      { tagName: "token-release", target: "main" },
      { actor: "token" }
    );
    expect(response.status).toBe(201);
    expect(
      (
        await call(
          `/repositories/${repositoryId}/releases/${releaseSchema.parse(await response.json()).data.id}`,
          "DELETE",
          { actor: "token" }
        )
      ).status
    ).toBe(200);
  });

  it("requires recent identity confirmation to delete a release from a browser session", async () => {
    const release = await created({ tagName: "v-delete", target: "main" });
    const refused = await call(`/repositories/${repositoryId}/releases/${release.id}`, "DELETE");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: "reauth_required" } });
    const confirmed = await call(`/repositories/${repositoryId}/releases/${release.id}`, "DELETE", {
      actor: "owner",
      headers: { "X-GitEdge-Recent-Auth": String(Date.now()) },
    });
    expect(confirmed.status).toBe(200);
  });

  it("keeps drafts and private repositories away from readers who may not see them", async () => {
    const draft = await created({ tagName: "v-draft", target: "main", draft: true });
    const draftUrl = `/repositories/${repositoryId}/releases/${draft.id}`;
    expect((await call(draftUrl, "GET", { actor: "anonymous" })).status).toBe(404);
    expect((await call(draftUrl, "GET", { actor: "reader" })).status).toBe(404);
    expect((await call(draftUrl, "GET", { actor: "writer" })).status).toBe(200);
    const listed = async (actor: Actor) =>
      z
        .object({ data: z.array(z.object({ tagName: z.string() })) })
        .parse(
          await (await call(`/repositories/${repositoryId}/releases`, "GET", { actor })).json()
        )
        .data.map((release) => release.tagName);
    expect(await listed("anonymous")).not.toContain("v-draft");
    expect(await listed("writer")).toContain("v-draft");
    const hidden = await call(`/repositories/${privateId}/releases`, "GET", { actor: "anonymous" });
    expect(hidden.status).toBe(404);
    expect(
      (await call(`/repositories/${privateId}/releases`, "GET", { actor: "stranger" })).status
    ).toBe(404);
    expect(
      (await call(`/repositories/${privateId}/releases`, "GET", { actor: "reader" })).status
    ).toBe(200);
  });
});

describe("release records and tags", () => {
  it("creates the tag from the chosen target when publishing", async () => {
    const release = await created({
      tagName: "v2.0.0",
      target: "release-branch",
      title: "Two",
      body: "Notes",
    });
    expect(release).toMatchObject({ title: "Two", draft: false });
    expect(release.publishedAt).not.toBeNull();
    expect(gitCalls.find((entry) => entry.method === "POST")?.body).toEqual({
      name: "v2.0.0",
      target: "release-branch",
    });
    expect(events.map((event) => event.type)).toEqual(["release.published"]);
  });

  it("reuses an existing tag and defaults the title to it", async () => {
    existingTags.add("v3.0.0");
    const release = await created({ tagName: "v3.0.0" });
    expect(release.title).toBe("v3.0.0");
    expect(gitCalls.some((entry) => entry.method === "POST")).toBe(false);
  });

  it("does not record a target for a tag that already existed", async () => {
    existingTags.add("v3.1.0");
    const response = await createRelease({ tagName: "v3.1.0", target: "release-branch" });
    expect(response.status).toBe(201);
    expect(targetSchema.parse(await response.json()).data.target).toBeNull();
    const fresh = await createRelease({ tagName: "v3.2.0", target: "release-branch" });
    expect(targetSchema.parse(await fresh.json()).data.target).toBe("release-branch");
  });

  it("publishes a draft once when two publishes race", async () => {
    const draft = await created({ tagName: "v3.3.0", target: "main", draft: true });
    beforeTagResponse = async () => {
      await env.DB.prepare("UPDATE forge_releases SET draft = 0, published_at = ? WHERE id = ?")
        .bind(Date.now(), draft.id)
        .run();
    };
    const raced = await call(`/repositories/${repositoryId}/releases/${draft.id}`, "PATCH", {
      body: { draft: false },
    });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ error: { code: "release_changed" } });
    expect(events).toEqual([]);
  });

  it("does not treat extra segments after latest as the latest release", async () => {
    const response = await call(`/repositories/${repositoryId}/releases/latest/assets`, "GET", {
      actor: "anonymous",
    });
    expect(response.status).toBe(404);
  });

  it("requires a target when the tag does not exist", async () => {
    const response = await createRelease({ tagName: "unknown-tag" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "tag_missing" } });
  });

  it("does not create a tag for a draft until it is published", async () => {
    const draft = await created({ tagName: "v4.0.0", target: "main", draft: true });
    expect(gitCalls).toEqual([]);
    expect(events).toEqual([]);
    const published = await call(`/repositories/${repositoryId}/releases/${draft.id}`, "PATCH", {
      body: { draft: false },
    });
    expect(published.status).toBe(200);
    expect(releaseSchema.parse(await published.json()).data.publishedAt).not.toBeNull();
    expect(existingTags.has("v4.0.0")).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["release.published"]);
  });

  it("rejects a second release for the same tag", async () => {
    await created({ tagName: "v5.0.0", target: "main" });
    const duplicate = await createRelease({ tagName: "v5.0.0", target: "main" });
    expect(duplicate.status).toBe(409);
  });

  it("serves the latest published stable release", async () => {
    await created({ tagName: "v6.0.0-rc1", target: "main", prerelease: true });
    const stable = await created({ tagName: "v6.0.0", target: "main" });
    const latest = await call(`/repositories/${repositoryId}/releases/latest`, "GET", {
      actor: "anonymous",
    });
    expect(latest.status).toBe(200);
    expect(releaseSchema.parse(await latest.json()).data.id).toBe(stable.id);
  });

  it("emits update and delete events for published releases", async () => {
    const release = await created({ tagName: "v7.0.0", target: "main" });
    await call(`/repositories/${repositoryId}/releases/${release.id}`, "PATCH", {
      body: { title: "Seven" },
    });
    await call(`/repositories/${repositoryId}/releases/${release.id}`, "DELETE", {
      headers: { "X-GitEdge-Recent-Auth": String(Date.now()) },
    });
    expect(events.map((event) => event.type)).toEqual([
      "release.published",
      "release.updated",
      "release.deleted",
    ]);
    expect(events[0]).toMatchObject({
      tagName: "v7.0.0",
      repositoryId,
      actor: { kind: "user", name: "owner" },
    });
  });
});

describe("release assets", () => {
  it("uploads, lists, downloads and deletes an asset", async () => {
    const release = await created({ tagName: "v8.0.0", target: "main" });
    const response = await upload(release.id, "build output.zip", "payload");
    expect(response.status).toBe(201);
    const asset = z
      .object({ data: z.object({ id: z.string(), size: z.number(), contentType: z.string() }) })
      .parse(await response.json()).data;
    expect(asset).toMatchObject({ size: 7, contentType: "application/zip" });
    const url = `/repositories/${repositoryId}/releases/${release.id}/assets/${asset.id}`;
    const download = await call(url, "GET", { actor: "anonymous" });
    expect(download.status).toBe(200);
    expect(new TextDecoder().decode(await download.arrayBuffer())).toBe("payload");
    expect(download.headers.get("Content-Disposition")).toBe(
      `attachment; filename="build output.zip"; filename*=UTF-8''build%20output.zip`
    );
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(download.headers.get("Content-Security-Policy")).toContain("sandbox");
    const listed = await call(`/repositories/${repositoryId}/releases/${release.id}`, "GET", {
      actor: "anonymous",
    });
    expect(releaseSchema.parse(await listed.json()).data.assets.map((item) => item.name)).toEqual([
      "build output.zip",
    ]);
    expect((await call(url, "DELETE", { actor: "writer" })).status).toBe(200);
    expect((await call(url, "GET", { actor: "anonymous" })).status).toBe(404);
    expect(await env.RELEASE_ASSETS.get(`${repositoryId}/${asset.id}`)).toBeNull();
  });

  it("refuses private release assets to people outside the repository", async () => {
    existingTags.add("private-tag");
    const response = await call(`/repositories/${privateId}/releases`, "POST", {
      body: { tagName: "private-tag" },
    });
    const release = releaseSchema.parse(await response.json()).data;
    const put = await call(
      `/repositories/${privateId}/releases/${release.id}/assets?name=a.bin`,
      "PUT",
      {
        raw: new Uint8Array([1, 2, 3]) as BodyInit,
        headers: { "Content-Length": "3" },
      }
    );
    const asset = z.object({ data: z.object({ id: z.string() }) }).parse(await put.json()).data;
    const url = `/repositories/${privateId}/releases/${release.id}/assets/${asset.id}`;
    expect((await call(url, "GET", { actor: "anonymous" })).status).toBe(404);
    expect((await call(url, "GET", { actor: "stranger" })).status).toBe(404);
    const member = await call(url, "GET", { actor: "reader" });
    expect(member.status).toBe(200);
    expect(member.headers.get("Cache-Control")).toBe("private, no-store");
    await member.body?.cancel();
  });

  it("enforces the per-asset size cap before reading the body", async () => {
    const release = await created({ tagName: "v9.0.0", target: "main" });
    const before = (await env.RELEASE_ASSETS.list({ prefix: `${repositoryId}/` })).objects.length;
    const response = await upload(
      release.id,
      "huge.bin",
      "x",
      "owner",
      RELEASE_ASSET_MAX_BYTES + 1
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "asset_too_large" } });
    expect((await env.RELEASE_ASSETS.list({ prefix: `${repositoryId}/` })).objects).toHaveLength(
      before
    );
  });

  it("requires Content-Length and a valid file name", async () => {
    const release = await created({ tagName: "v9.1.0", target: "main" });
    const missing = await call(
      `/repositories/${repositoryId}/releases/${release.id}/assets?name=a.bin`,
      "PUT",
      { raw: "abc" }
    );
    expect(missing.status).toBe(411);
    for (const name of ["", "../escape", "a/b", ".."]) {
      expect((await upload(release.id, name, "x")).status).toBe(400);
    }
  });

  it("rejects uploads whose body does not match the declared length", async () => {
    const release = await created({ tagName: "v9.2.0", target: "main" });
    const response = await upload(release.id, "short.bin", "abc", "owner", 10);
    expect(response.status).toBe(400);
    expect((await call(`/repositories/${repositoryId}/releases/${release.id}`, "GET")).status).toBe(
      200
    );
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM forge_release_assets WHERE release_id=?"
    )
      .bind(release.id)
      .first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("limits the number of assets and duplicate names", async () => {
    const release = await created({ tagName: "v9.3.0", target: "main" });
    expect((await upload(release.id, "same.bin", "a")).status).toBe(201);
    expect((await upload(release.id, "same.bin", "b")).status).toBe(409);
    for (let index = 1; index < RELEASE_MAX_ASSETS; index += 1)
      expect((await upload(release.id, `file-${index}.bin`, "x")).status).toBe(201);
    const overflow = await upload(release.id, "one-too-many.bin", "x");
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({ error: { code: "asset_limit" } });
  });

  it("removes stored objects when a release is deleted", async () => {
    const release = await created({ tagName: "v9.4.0", target: "main" });
    const asset = z
      .object({ data: z.object({ id: z.string() }) })
      .parse(await (await upload(release.id, "gone.bin", "x")).json()).data;
    await call(`/repositories/${repositoryId}/releases/${release.id}`, "DELETE", {
      headers: { "X-GitEdge-Recent-Auth": String(Date.now()) },
    });
    expect(await env.RELEASE_ASSETS.get(`${repositoryId}/${asset.id}`)).toBeNull();
  });
});

describe("repository purge", () => {
  it("deletes release assets with the repository", async () => {
    const response = await call("/repositories", "POST", {
      body: { owner: "owner", slug: "purged", visibility: "public" },
    });
    const id = z.object({ data: z.object({ id: z.string() }) }).parse(await response.json())
      .data.id;
    await env.RELEASE_ASSETS.put(`${id}/orphan`, "x");
    await env.DB.prepare(
      "UPDATE repositories SET deleted_at=1, purge_state='artifacts_deleted' WHERE id=?"
    )
      .bind(id)
      .run();
    expect(
      await purgeRepository(
        { DB: env.DB, ARTIFACTS: artifacts, GIT, RELEASE_ASSETS: env.RELEASE_ASSETS },
        id
      )
    ).toBe(true);
    expect(await env.RELEASE_ASSETS.get(`${id}/orphan`)).toBeNull();
  });
});
