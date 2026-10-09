import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import forge from "../../workers/forge/src/index";
import gitWorker from "../../workers/git/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { PAGES_CHECK_NAME } from "../../packages/contracts/src/pages";
import { runSqlScript } from "../support/database";
import { FixtureArtifacts } from "../support/artifacts";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const artifacts = new FixtureArtifacts();
const owner = { id: "owner-id", identifier: "owner", groupKey: "free" };
const writer = { id: "writer-id", identifier: "writer", groupKey: "free" };
let headOid = "";
const pending: Promise<unknown>[] = [];
const ids = { site: "", hidden: "" };

const GIT = {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/pull-head"))
      return Response.json({ data: { oid: headOid } });
    return Response.json({ data: [] });
  },
};

function forgeCall(path: string, method = "GET", body?: unknown, user = owner) {
  const headers = trustedHeaders(user);
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request("https://forge.test" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts, GIT, SITES_HOST: "sites.example.com" }
  );
}

function site(
  repo: string,
  path: string,
  options: { preview?: string; mode?: "path" | "host"; headers?: HeadersInit; method?: string } = {}
) {
  const url = new URL("https://git.internal/internal/site");
  url.searchParams.set("owner", "owner");
  url.searchParams.set("repo", repo);
  url.searchParams.set("path", path);
  url.searchParams.set("mode", options.mode ?? "path");
  if (options.preview) url.searchParams.set("preview", options.preview);
  return gitWorker.fetch(
    new Request(url, { method: options.method ?? "GET", headers: options.headers }),
    { DB: env.DB, ARTIFACTS: artifacts },
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    } as ExecutionContext
  );
}

async function createRepository(slug: string, visibility: "public" | "private"): Promise<string> {
  const created = await forgeCall("/repositories", "POST", { owner: "owner", slug, visibility });
  expect(created.status).toBe(201);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json()).data.id;
  const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id=?")
    .bind(id)
    .first<{ name: string }>();
  headOid = await artifacts.seedFiles(z.string().parse(row?.name), {
    "index.html": "<h1>home</h1>",
    "404.html": "<h1>missing</h1>",
    "app.js": "console.log(1)",
    "style.css": "body{}",
    "logo.png": new Uint8Array([0x89, 0x50]),
    "guide/index.html": "<h1>guide</h1>",
    "about.html": "<h1>about</h1>",
    "docs/index.html": "<h1>docs</h1>",
    "docs/page.html": "<h1>page</h1>",
    "secret.txt": "x",
  });
  return id;
}

async function enable(id: string, enabled = true) {
  return forgeCall(`/repositories/${id}/settings`, "PATCH", { pagesEnabled: enabled });
}

beforeAll(async () => {
  for (const name of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[name]);
  for (const user of [owner, writer])
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
  ids.site = await createRepository("site", "public");
  ids.hidden = await createRepository("hidden", "private");
});

describe("Pages settings", () => {
  it("rejects enabling Pages on a private repository", async () => {
    expect((await enable(ids.hidden)).status).toBe(400);
  });

  it("exposes defaults, urls and the feature flag", async () => {
    expect((await enable(ids.site)).status).toBe(200);
    const body = z
      .object({ data: z.object({ pagesEnabled: z.boolean() }) })
      .parse(await (await forgeCall(`/repositories/${ids.site}/settings`)).json());
    expect(body.data.pagesEnabled).toBe(true);
    const pages = z
      .object({
        data: z.object({
          enabled: z.boolean(),
          branch: z.string(),
          folder: z.string(),
          notFoundPath: z.string().nullable(),
          pathUrl: z.string(),
          hostUrl: z.string().nullable(),
          canManage: z.boolean(),
        }),
      })
      .parse(await (await forgeCall(`/repositories/${ids.site}/pages`)).json()).data;
    expect(pages).toMatchObject({
      enabled: true,
      branch: "main",
      folder: "/",
      notFoundPath: "404.html",
      pathUrl: "/owner/site/-/site/",
      hostUrl: "https://owner.sites.example.com/site/",
      canManage: true,
    });
  });

  it("limits changes to administrators and validates the folder", async () => {
    const input = { branch: "main", folder: "/", notFoundPath: "404.html", spaFallback: false };
    expect((await forgeCall(`/repositories/${ids.site}/pages`, "PUT", input, writer)).status).toBe(
      403
    );
    expect(
      (await forgeCall(`/repositories/${ids.site}/pages`, "PUT", { ...input, folder: "/../etc" }))
        .status
    ).toBe(400);
    expect(
      (
        await forgeCall(`/repositories/${ids.site}/pages`, "PUT", {
          ...input,
          notFoundPath: "../x",
        })
      ).status
    ).toBe(400);
    const saved = await forgeCall(`/repositories/${ids.site}/pages`, "PUT", {
      ...input,
      folder: "docs/",
    });
    expect(saved.status).toBe(200);
    expect(
      z.object({ data: z.object({ folder: z.string() }) }).parse(await saved.json()).data.folder
    ).toBe("/docs");
    await forgeCall(`/repositories/${ids.site}/pages`, "PUT", { ...input, folder: "/" });
  });
});

describe("Pages serving", () => {
  it("serves index and extension-less pages with correct types and an OID etag", async () => {
    const root = await site("site", "/");
    expect(root.status).toBe(200);
    expect(root.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await root.text()).toBe("<h1>home</h1>");
    expect((await site("site", "/app.js")).headers.get("Content-Type")).toBe(
      "text/javascript; charset=utf-8"
    );
    expect((await site("site", "/style.css")).headers.get("Content-Type")).toBe(
      "text/css; charset=utf-8"
    );
    expect((await site("site", "/logo.png")).headers.get("Content-Type")).toBe("image/png");
    expect(await (await site("site", "/about")).text()).toBe("<h1>about</h1>");
    expect(await (await site("site", "/guide/")).text()).toBe("<h1>guide</h1>");
    const etag = (await site("site", "/app.js")).headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const conditional = await site("site", "/app.js", { headers: { "If-None-Match": etag ?? "" } });
    expect(conditional.status).toBe(304);
    const head = await site("site", "/app.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("redirects directories to a trailing slash and keeps the query", async () => {
    const url = new URL("https://git.internal/internal/site");
    url.searchParams.set("owner", "owner");
    url.searchParams.set("repo", "site");
    url.searchParams.set("path", "/guide");
    url.searchParams.set("search", "?a=1");
    const response = await gitWorker.fetch(new Request(url), { DB: env.DB, ARTIFACTS: artifacts }, {
      waitUntil: () => undefined,
    } as unknown as ExecutionContext);
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("guide/?a=1");
  });

  it("serves the custom 404 page and plain 404s", async () => {
    const missing = await site("site", "/nope.html");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("<h1>missing</h1>");
    await forgeCall(`/repositories/${ids.site}/pages`, "PUT", {
      branch: "main",
      folder: "/",
      notFoundPath: null,
      spaFallback: true,
    });
    expect((await site("site", "/client/route")).status).toBe(200);
    expect(await (await site("site", "/client/route")).text()).toBe("<h1>home</h1>");
    expect((await site("site", "/missing.png")).status).toBe(404);
    await forgeCall(`/repositories/${ids.site}/pages`, "PUT", {
      branch: "main",
      folder: "/docs",
      notFoundPath: "404.html",
      spaFallback: false,
    });
    expect(await (await site("site", "/")).text()).toBe("<h1>docs</h1>");
    expect((await site("site", "/secret.txt")).status).toBe(404);
    expect((await site("site", "/zzz")).status).toBe(404);
    await forgeCall(`/repositories/${ids.site}/pages`, "PUT", {
      branch: "main",
      folder: "/",
      notFoundPath: "404.html",
      spaFallback: false,
    });
  });

  it("rejects path traversal and malformed paths", async () => {
    for (const path of [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/a%2f..%2fsecret.txt",
      "/docs//page.html",
      "/a%5c..%5csecret",
      "/%00",
      "/%zz",
    ])
      expect((await site("site", path)).status, path).toBe(404);
  });

  it("sets the sandbox policy on the path scheme only", async () => {
    const response = await site("site", "/");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect((await site("site", "/", { mode: "host" })).headers.has("Content-Security-Policy")).toBe(
      false
    );
  });

  it("never serves private, disabled or unknown repositories", async () => {
    await env.DB.prepare("UPDATE repositories SET pages_enabled = 1 WHERE id = ?")
      .bind(ids.hidden)
      .run();
    const privateResponse = await site("hidden", "/");
    expect(privateResponse.status).toBe(404);
    const unknown = await site("nothing", "/");
    expect(await privateResponse.text()).toBe(await unknown.text());
    await enable(ids.site, false);
    expect((await site("site", "/")).status).toBe(404);
    await enable(ids.site, true);
    expect((await site("site", "/")).status).toBe(200);
  });

  it("turns Pages off when a repository becomes private", async () => {
    const id = await createRepository("flip", "public");
    await enable(id);
    expect((await site("flip", "/")).status).toBe(200);
    const flipped = await forgeCall(`/repositories/${id}/settings`, "PATCH", {
      visibility: "private",
    });
    expect(flipped.status).toBe(200);
    expect((await site("flip", "/")).status).toBe(404);
    const row = await env.DB.prepare("SELECT pages_enabled FROM repositories WHERE id=?")
      .bind(id)
      .first<{ pages_enabled: number }>();
    expect(row?.pages_enabled).toBe(0);
  });

  it("stores responses in the edge cache under the commit OID", async () => {
    const response = await site("site", "/style.css");
    expect(response.status).toBe(200);
    await response.text();
    const { siteCacheKey } = await import("../../workers/git/src/site");
    const key = siteCacheKey(
      ids.site,
      headOid,
      { segments: ["style.css"], directory: false },
      { branch: "main", folder: "/", notFoundPath: "404.html", spaFallback: false },
      "path",
      false
    );
    expect(key).toContain(headOid);
    await Promise.all(pending);
    const stored = await caches.default.match(new Request(key));
    expect(stored?.status).toBe(200);
    expect(await stored?.text()).toBe("body{}");
    expect(key).not.toBe(
      siteCacheKey(
        ids.site,
        headOid,
        { segments: ["style.css"], directory: false },
        { branch: "main", folder: "/", notFoundPath: "404.html", spaFallback: false },
        "path",
        true
      )
    );
  });
});

describe("Pull request previews", () => {
  it("posts a neutral preview check once per head and serves that OID", async () => {
    const created = await forgeCall(`/repositories/${ids.site}/pull-requests`, "POST", {
      title: "Change",
      body: "",
      baseRef: "main",
      headRef: "feature",
    });
    expect(created.status).toBe(201);
    const number = z.object({ data: z.object({ number: z.number() }) }).parse(await created.json())
      .data.number;
    const read = async () =>
      z
        .object({
          data: z.array(
            z.object({
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
              commitOid: z.string(),
              summary: z.string(),
              detailsUrl: z.string().nullable(),
              actor: z.object({ kind: z.string(), id: z.string() }),
            })
          ),
        })
        .parse(
          await (await forgeCall(`/repositories/${ids.site}/pull-requests/${number}/checks`)).json()
        ).data;
    const checks = await read();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: PAGES_CHECK_NAME,
      status: "completed",
      conclusion: "neutral",
      commitOid: headOid,
      summary: "Preview ready",
      detailsUrl: `/owner/site/-/preview/${headOid}/`,
      actor: { kind: "ci", id: "gitedge-pages" },
    });
    expect(await read()).toHaveLength(1);
    const preview = await site("site", "/", { preview: headOid });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await preview.text()).toBe("<h1>home</h1>");
    expect((await site("site", "/", { preview: "f".repeat(40) })).status).toBe(404);
    expect((await site("site", "/", { preview: "nothex" })).status).toBe(404);
  });

  it("records a check for each pushed head of an open pull request", async () => {
    const next = "e".repeat(40);
    const event = await forge.fetch(
      new Request("https://forge.internal/internal/push-event", {
        method: "POST",
        body: JSON.stringify({
          repositoryId: ids.site,
          pusherId: owner.id,
          updates: [{ ref: "refs/heads/feature", before: headOid, after: next }],
        }),
      }),
      { DB: env.DB, ARTIFACTS: artifacts, GIT }
    );
    expect(event.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT commit_oid FROM forge_check_runs WHERE repository_id=? AND name=? ORDER BY commit_oid"
    )
      .bind(ids.site, PAGES_CHECK_NAME)
      .all<{ commit_oid: string }>();
    expect(rows.results.map((row) => row.commit_oid).sort()).toEqual([next, headOid].sort());
  });

  it("does not count the preview as a passing check", async () => {
    const rows = await env.DB.prepare("SELECT conclusion FROM forge_check_runs WHERE name=?")
      .bind(PAGES_CHECK_NAME)
      .all<{ conclusion: string }>();
    expect(rows.results.every((row) => row.conclusion === "neutral")).toBe(true);
  });

  it("tracks the last published source-branch head", async () => {
    const next = "d".repeat(40);
    await forge.fetch(
      new Request("https://forge.internal/internal/push-event", {
        method: "POST",
        body: JSON.stringify({
          repositoryId: ids.site,
          pusherId: owner.id,
          updates: [{ ref: "refs/heads/main", before: headOid, after: next }],
        }),
      }),
      { DB: env.DB, ARTIFACTS: artifacts, GIT }
    );
    const pages = z
      .object({ data: z.object({ lastPublishedOid: z.string().nullable() }) })
      .parse(await (await forgeCall(`/repositories/${ids.site}/pages`)).json());
    expect(pages.data.lastPublishedOid).toBe(next);
  });
});
