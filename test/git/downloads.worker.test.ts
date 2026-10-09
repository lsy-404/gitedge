import { env } from "cloudflare:workers";
import { unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  stranger: { id: "stranger-id", identifier: "stranger", groupKey: "free" },
};
const repositories = { public: "", private: "" };
let commitOid = "";

async function forgeCall(path: string, method: string, body?: unknown) {
  const headers = trustedHeaders(users.owner);
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request("https://forge.test" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts, GIT: { fetch: async () => Response.json({ data: [] }) } }
  );
}
async function gitCall(
  repository: keyof typeof repositories,
  resource: string,
  options: {
    user?: keyof typeof users | null;
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
  } = {}
) {
  const headers =
    options.user === null ? new Headers() : trustedHeaders(users[options.user ?? "owner"]);
  new Headers(options.headers).forEach((value, name) => headers.set(name, value));
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return gitWorker.fetch(
    new Request(`https://git.test/repositories/${repositories[repository]}/${resource}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { DB: env.DB, ARTIFACTS: artifacts }
  );
}

async function createRepository(slug: string, visibility: "public" | "private") {
  const created = await forgeCall("/repositories", "POST", { owner: "owner", slug, visibility });
  expect(created.status).toBe(201);
  const id = z.object({ data: z.object({ id: z.string() }) }).parse(await created.json()).data.id;
  const row = await env.DB.prepare("SELECT artifact_name AS name FROM repositories WHERE id=?")
    .bind(id)
    .first<{ name: string }>();
  commitOid = await artifacts.seedFiles(z.string().parse(row?.name), {
    "README.md": "# demo\n",
    "docs/guide.txt": "guide\n",
    "logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    "bin/tool": { content: "#!/bin/sh\n", mode: "100755" },
  });
  return id;
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
  repositories.public = await createRepository("open", "public");
  repositories.private = await createRepository("closed", "private");
  await forgeCall(`/repositories/${repositories.private}/collaborators`, "PUT", {
    identifier: "reader",
    role: "read",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("raw blobs", () => {
  it("serves text inline with hardening headers and an OID validator", async () => {
    const response = await gitCall("public", `raw?spec=${commitOid}/README.md`, { user: null });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# demo\n");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{40}"$/);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  it("serves images inline and downloads binaries", async () => {
    const image = await gitCall("public", `raw?ref=main&path=logo.png`, { user: null });
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Content-Disposition")).toMatch(/^inline;/);
    const forced = await gitCall("public", `raw?ref=main&path=docs/guide.txt&download=1`, {
      user: null,
    });
    expect(forced.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("answers conditional requests without sending the file", async () => {
    const first = await gitCall("public", `raw?ref=main&path=README.md`, { user: null });
    const second = await gitCall("public", `raw?ref=main&path=README.md`, {
      user: null,
      headers: { "If-None-Match": first.headers.get("ETag") ?? "" },
    });
    expect(second.status).toBe(304);
  });

  it("answers 404 for missing files", async () => {
    const response = await gitCall("public", `raw?ref=main&path=missing.txt`, { user: null });
    expect(response.status).toBe(404);
  });

  it("hides private repositories from anonymous and unrelated users", async () => {
    for (const user of [null, "stranger"] as const) {
      const response = await gitCall("private", `raw?ref=main&path=README.md`, { user });
      expect(response.status).toBe(404);
      expect(response.headers.get("X-GitEdge-Repository-Access-Denied")).toBe("1");
    }
  });

  it("serves private files to members without shared caching", async () => {
    const response = await gitCall("private", `raw?ref=main&path=README.md`, { user: "reader" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("source archives", () => {
  it("streams a zip download with a safe filename", async () => {
    const response = await gitCall("public", "archive?ref=main&format=zip", { user: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="open-main.zip"; filename*=UTF-8''open-main.zip`
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files)).toContain("open-main/docs/guide.txt");
    expect(new TextDecoder().decode(files["open-main/README.md"])).toBe("# demo\n");
  });

  it("streams a tar.gz download", async () => {
    const response = await gitCall("public", "archive?ref=main&format=tar.gz", { user: null });
    expect(response.headers.get("Content-Type")).toBe("application/gzip");
    expect(response.headers.get("Content-Disposition")).toContain("open-main.tar.gz");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(20);
  });

  it("answers HEAD without starting the archive stream", async () => {
    const opened = vi.spyOn(artifacts, "get");
    const response = await gitCall("public", "archive?ref=main&format=tar.gz", {
      user: null,
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("open-main.tar.gz");
    expect(response.body).toBeNull();
    expect(opened).toHaveBeenCalledTimes(1);
    opened.mockRestore();
  });

  it("rejects unknown formats and refs", async () => {
    expect((await gitCall("public", "archive?ref=main&format=rar", { user: null })).status).toBe(
      400
    );
  });

  it("validates cached archives by commit id", async () => {
    const first = await gitCall("public", "archive?ref=main&format=zip", { user: null });
    const second = await gitCall("public", "archive?ref=main&format=zip", {
      user: null,
      headers: { "If-None-Match": first.headers.get("ETag") ?? "" },
    });
    expect(second.status).toBe(304);
    await first.body?.cancel();
  });

  it("hides private repository archives", async () => {
    expect((await gitCall("private", "archive?ref=main&format=zip", { user: null })).status).toBe(
      404
    );
    expect(
      (await gitCall("private", "archive?ref=main&format=zip", { user: "stranger" })).status
    ).toBe(404);
    const member = await gitCall("private", "archive?ref=main&format=zip", { user: "reader" });
    expect(member.status).toBe(200);
    expect(member.headers.get("Cache-Control")).toBe("private, no-store");
    await member.body?.cancel();
  });
});

describe("tag permissions", () => {
  const body = { name: "v1.0.0", target: "main" };

  it("requires write access to create or delete tags", async () => {
    for (const method of ["POST", "DELETE"]) {
      const payload = method === "POST" ? body : { name: "v1.0.0", expectedOid: "a".repeat(40) };
      expect(
        (await gitCall("private", "tags", { user: "reader", method, body: payload })).status
      ).toBe(403);
      expect((await gitCall("public", "tags", { user: null, method, body: payload })).status).toBe(
        403
      );
      expect(
        (await gitCall("private", "tags", { user: "stranger", method, body: payload })).status
      ).toBe(404);
    }
  });

  it("refuses tag changes in archived repositories", async () => {
    await env.DB.prepare("UPDATE repositories SET archived=1 WHERE id=?")
      .bind(repositories.public)
      .run();
    const response = await gitCall("public", "tags", { method: "POST", body });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "repository_archived" } });
    await env.DB.prepare("UPDATE repositories SET archived=0 WHERE id=?")
      .bind(repositories.public)
      .run();
  });

  it("validates tag requests before contacting Artifacts", async () => {
    const fetchMock = vi.fn(async () => new Response("unexpected", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const invalid of [
      {},
      { name: "bad name", target: "main" },
      { name: "v1", target: "main", extra: 1 },
      { name: "a".repeat(40), target: "main" },
    ]) {
      const response = await gitCall("public", "tags", { method: "POST", body: invalid });
      expect(response.status).toBe(400);
    }
    expect(
      (await gitCall("public", "tags", { method: "DELETE", body: { name: "v1" } })).status
    ).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists tags with annotated flags from the advertised refs", async () => {
    const commit = commitOid;
    const tagObject = "e".repeat(40);
    const pkt = (text: string) => (text.length + 4).toString(16).padStart(4, "0") + text;
    const lsRefs =
      pkt(`${commit} HEAD\n`) +
      pkt(`${commit} refs/heads/main\n`) +
      pkt(`${commit} refs/tags/v1.0.0\n`) +
      pkt(`${tagObject} refs/tags/v1.10.0 peeled:${commit}\n`) +
      "0000";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("info/refs"))
          return new Response(
            pkt("version 2\n") + pkt("ls-refs=unborn\n") + pkt("fetch=shallow\n") + "0000",
            {
              headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
            }
          );
        expect(init?.method).toBe("POST");
        return new Response(lsRefs, {
          headers: { "Content-Type": "application/x-git-upload-pack-result" },
        });
      })
    );
    const response = await gitCall("public", "tags", { user: null });
    expect(response.status).toBe(200);
    const parsed = z
      .object({
        data: z.array(
          z.object({ name: z.string(), annotated: z.boolean(), commitOid: z.string() })
        ),
        truncated: z.boolean(),
      })
      .parse(await response.json());
    expect(parsed.data.map((tag) => [tag.name, tag.annotated])).toEqual([
      ["v1.10.0", true],
      ["v1.0.0", false],
    ]);
    expect(parsed.data.every((tag) => tag.commitOid === commit)).toBe(true);
    expect(parsed.truncated).toBe(false);
  });
});
