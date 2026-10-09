import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleGitApi } from "../../workers/git/src/api";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const gitEnv = { DB: env.DB, ARTIFACTS: artifacts };
const owner = { id: "owner-id", identifier: "owner", groupKey: "free" };
const files = { "README.md": "# demo\n" };
let head = "";

async function call(
  repositoryId: string,
  resource: string,
  options: { user?: typeof owner; headers?: HeadersInit; method?: string } = {}
): Promise<Response> {
  const headers = trustedHeaders(options.user);
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  return handleGitApi(
    new Request(`https://git.test/repositories/${repositoryId}/${resource}`, {
      method: options.method ?? "GET",
      headers,
    }),
    gitEnv
  );
}

async function createRepository(id: string, visibility: "public" | "private"): Promise<string> {
  const created = await artifacts.create(`${id}-source`, { setDefaultBranch: "main" });
  using handle = await artifacts.get(created.name);
  await handle.revokeToken(created.token);
  const oid = await artifacts.seedFiles(created.name, files);
  await env.DB.prepare(
    "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,artifact_name,remote,created_at,updated_at) VALUES(?,'namespace','owner-id',?,?,?,'',?,?,1,1)"
  )
    .bind(id, id, `repo:${id}`, visibility, created.name, created.remote)
    .run();
  return oid;
}

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  await env.DB.prepare(
    "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES('owner-id','owner','salt','hash',1)"
  ).run();
  for (const id of ["namespace", "other-namespace"])
    await env.DB.prepare(
      "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES(?,?,'owner-id',1,'personal')"
    )
      .bind(id, id)
      .run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('namespace','owner-id','owner',1)"
  ).run();
  head = await createRepository("open", "public");
  await createRepository("closed", "private");
  await createRepository("flip", "public");
  await createRepository("gone", "public");
  await createRepository("moved", "public");
  await createRepository("pushed", "public");
});

describe("edge cache for public repositories", () => {
  it("serves repeated anonymous branch reads from the cache with the resolved commit as validator", async () => {
    const first = await call("open", "tree?ref=main");
    expect(first.status).toBe(200);
    expect(first.headers.get("X-GitEdge-Cache")).toBe("miss");
    expect(first.headers.get("ETag")).toBe(`"${head}"`);
    expect(first.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=30, must-revalidate"
    );
    const second = await call("open", "tree?ref=main");
    expect(second.headers.get("X-GitEdge-Cache")).toBe("hit");
    expect(await second.json()).toEqual(await first.json());
  });

  it("answers revalidation with 304", async () => {
    const response = await call("open", "tree?ref=main", {
      headers: { "If-None-Match": `"${head}"` },
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("X-GitEdge-Cache")).toBe("revalidated");
  });

  it("keys commit-addressed reads immutably and shares them across callers", async () => {
    const anonymous = await call("open", `files?ref=${head}`);
    expect(anonymous.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=3600, immutable"
    );
    const signedIn = await call("open", `files?ref=${head}`, { user: owner });
    expect(signedIn.headers.get("X-GitEdge-Cache")).toBe("hit");
  });

  it("serves the new tree as soon as a push moves the branch", async () => {
    const before = await call("pushed", "file?ref=main&path=README.md");
    expect(before.headers.get("X-GitEdge-Cache")).toBe("miss");
    expect(
      (await call("pushed", "file?ref=main&path=README.md")).headers.get("X-GitEdge-Cache")
    ).toBe("hit");
    const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id=?")
      .bind("pushed")
      .first<{ name: string }>();
    const moved = await artifacts.seedFiles(row?.name ?? "", { "README.md": "# changed\n" });
    const after = await call("pushed", "file?ref=main&path=README.md");
    expect(after.headers.get("X-GitEdge-Cache")).toBe("miss");
    expect(after.headers.get("ETag")).toBe(`"${moved}"`);
    expect(await after.json()).toMatchObject({ data: { content: "# changed\n" } });
  });
});

describe("edge cache never leaks private data", () => {
  it("never stores private repository reads and hides them from outsiders", async () => {
    for (const resource of ["tree?ref=main", `files?ref=${head}`]) {
      const first = await call("closed", resource, { user: owner });
      expect(first.status, resource).toBe(200);
      expect(first.headers.get("X-GitEdge-Cache")).toBe("bypass");
      expect(first.headers.get("Cache-Control")).not.toContain("public");
      expect((await call("closed", resource, { user: owner })).headers.get("X-GitEdge-Cache")).toBe(
        "bypass"
      );
      expect((await call("closed", resource)).status).toBe(404);
    }
  });

  it("stops serving cached content when a repository becomes private", async () => {
    expect((await call("flip", "tree?ref=main")).status).toBe(200);
    expect((await call("flip", "tree?ref=main")).headers.get("X-GitEdge-Cache")).toBe("hit");
    await env.DB.prepare("UPDATE repositories SET visibility='private' WHERE id='flip'").run();
    const anonymous = await call("flip", "tree?ref=main");
    expect(anonymous.status).toBe(404);
    expect(anonymous.headers.get("Cache-Control")).toBe("no-store");
    const reader = await call("flip", "tree?ref=main", { user: owner });
    expect(reader.status).toBe(200);
    expect(reader.headers.get("X-GitEdge-Cache")).toBe("bypass");
    expect(reader.headers.get("Cache-Control")).toBe("no-store");
  });

  it("stops serving cached content when a repository is deleted", async () => {
    expect((await call("gone", "tree?ref=main")).status).toBe(200);
    await env.DB.prepare("UPDATE repositories SET deleted_at=2 WHERE id='gone'").run();
    expect((await call("gone", "tree?ref=main")).status).toBe(404);
  });

  it("starts a fresh cache generation when ownership moves", async () => {
    expect((await call("moved", "tree?ref=main")).headers.get("X-GitEdge-Cache")).toBe("miss");
    expect((await call("moved", "tree?ref=main")).headers.get("X-GitEdge-Cache")).toBe("hit");
    await env.DB.prepare(
      "UPDATE repositories SET namespace_id='other-namespace' WHERE id='moved'"
    ).run();
    expect((await call("moved", "tree?ref=main")).headers.get("X-GitEdge-Cache")).toBe("miss");
  });

  it("does not cache unauthenticated errors", async () => {
    const missing = await call("open", "file?ref=main&path=missing.txt");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    expect(missing.headers.get("X-GitEdge-Cache")).toBeNull();
  });
});
