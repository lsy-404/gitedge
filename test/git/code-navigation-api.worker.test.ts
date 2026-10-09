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
const outsider = { id: "outsider-id", identifier: "outsider", groupKey: "free" };
const baseOid = "a".repeat(40);
const endpoints = [
  "files?ref=main",
  `files?ref=${baseOid}`,
  "history?ref=main&path=README.md",
  "blame?ref=main&path=README.md",
  `commit-diff?oid=${baseOid}`,
];

async function call(
  repositoryId: string,
  resource: string,
  user?: typeof owner,
  method = "GET"
): Promise<Response> {
  return handleGitApi(
    new Request(`https://git.test/repositories/${repositoryId}/${resource}`, {
      method,
      headers: trustedHeaders(user),
    }),
    gitEnv
  );
}

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of [owner, outsider])
    await env.DB.prepare(
      "INSERT INTO users(id,identifier,password_salt,password_hash,created_at) VALUES(?,?,'salt','hash',1)"
    )
      .bind(user.id, user.identifier)
      .run();
  await env.DB.prepare(
    "INSERT INTO namespaces(id,slug,created_by,created_at,kind) VALUES('namespace','owner','owner-id',1,'personal')"
  ).run();
  await env.DB.prepare(
    "INSERT INTO namespace_memberships(namespace_id,user_id,role,created_at) VALUES('namespace','owner-id','owner',1)"
  ).run();
  for (const visibility of ["private", "public"]) {
    const created = await artifacts.create(`${visibility}-source`, { setDefaultBranch: "main" });
    using handle = await artifacts.get(created.name);
    await handle.revokeToken(created.token);
    await env.DB.prepare(
      "INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,artifact_name,remote,created_at,updated_at) VALUES(?,'namespace','owner-id',?,?,?,'',?,?,1,1)"
    )
      .bind(
        `${visibility}-id`,
        `${visibility}-repo`,
        `repo:${visibility}`,
        visibility,
        created.name,
        created.remote
      )
      .run();
  }
});

describe("code navigation endpoints", () => {
  it.each(endpoints)("hides %s on a private repository from unauthorized readers", async (path) => {
    for (const viewer of [undefined, outsider]) {
      const response = await call("private-id", path, viewer);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  it("serves the private repository owner", async () => {
    for (const path of [
      "files?ref=main",
      "history?ref=main&path=README.md",
      `commit-diff?oid=${baseOid}`,
    ])
      expect((await call("private-id", path, owner)).status, path).toBe(200);
    expect((await call("private-id", "blame?ref=main&path=README.md", owner)).status).toBe(404);
  });

  it("lets anonymous readers list files of a public repository", async () => {
    const response = await call("public-id", `files?ref=${baseOid}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { oid: baseOid, paths: [], truncated: false },
    });
  });

  it("caches commit-addressed reads immutably for public repositories only", async () => {
    const publicOid = await call("public-id", `files?ref=${baseOid}`);
    expect(publicOid.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=3600, immutable"
    );
    const privateOid = await call("private-id", `files?ref=${baseOid}`, owner);
    expect(privateOid.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(privateOid.headers.get("Vary")).toBe("Cookie, Authorization");
    expect(publicOid.headers.get("Vary")).toBeNull();
    const branch = await call("public-id", "files?ref=main");
    expect(branch.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=30, must-revalidate"
    );
    const detail = await call("public-id", `commit-diff?oid=${baseOid}`);
    expect(detail.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=3600, immutable"
    );
  });

  it("validates cursors, oids and required paths", async () => {
    expect((await call("public-id", "history?ref=main&path=a&cursor=nope")).status).toBe(400);
    expect((await call("public-id", "history?ref=main")).status).toBe(400);
    expect((await call("public-id", "commit-diff?oid=short")).status).toBe(400);
  });

  it("returns an empty history with truncation metadata for an unchanged path", async () => {
    const response = await call("public-id", "history?ref=main&path=README.md");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { commits: [], inspected: 1, truncated: false, nextCursor: null },
    });
  });
});
