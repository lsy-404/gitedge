import { describe, expect, it } from "vitest";
import { classifyRaw, serveRaw, splitRawSpec, type RawRepository } from "../../workers/git/src/raw";

const names =
  (...values: string[]) =>
  async () =>
    new Set(values);
const encode = (text: string) => new TextEncoder().encode(text);

describe("raw delivery classification", () => {
  it("serves text inline as text/plain", () => {
    expect(classifyRaw("page.html", encode("<script>alert(1)</script>"), false)).toEqual({
      contentType: "text/plain; charset=utf-8",
      disposition: "inline",
    });
  });
  it("serves images inline with their own type", () => {
    expect(classifyRaw("logo.PNG", new Uint8Array([0x89, 0x50, 0, 1]), false)).toEqual({
      contentType: "image/png",
      disposition: "inline",
    });
    expect(classifyRaw("icon.svg", encode("<svg/>"), false).contentType).toBe("image/svg+xml");
  });
  it("downloads binaries, invalid UTF-8 and forced requests", () => {
    expect(classifyRaw("a.bin", new Uint8Array([1, 0, 2]), false).disposition).toBe("attachment");
    expect(classifyRaw("a.txt", new Uint8Array([0xff, 0xfe, 0xfd]), false).disposition).toBe(
      "attachment"
    );
    expect(classifyRaw("a.txt", encode("hello"), true)).toEqual({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
  });
});

describe("raw ref and path splitting", () => {
  it("prefers the longest matching ref", async () => {
    const refs = names("main", "feature", "feature/login");
    expect(await splitRawSpec("feature/login/src/a.ts", "main", refs)).toEqual({
      ref: "feature/login",
      path: "src/a.ts",
    });
    expect(await splitRawSpec("feature/src/a.ts", "main", refs)).toEqual({
      ref: "feature",
      path: "src/a.ts",
    });
  });
  it("accepts commit ids without listing refs and resolves HEAD", async () => {
    const oid = "a".repeat(40);
    expect(await splitRawSpec(`${oid}/README.md`, "main", names())).toEqual({
      ref: oid,
      path: "README.md",
    });
    expect(await splitRawSpec("HEAD/README.md", "trunk", names())).toEqual({
      ref: "trunk",
      path: "README.md",
    });
  });
  it("rejects unknown refs and empty segments", async () => {
    expect(await splitRawSpec("nope/README.md", "main", names("main"))).toBeNull();
    expect(await splitRawSpec("main//README.md", "main", names("main"))).toBeNull();
    expect(await splitRawSpec("main", "main", names("main"))).toBeNull();
  });
});

function rawRepo(content: Uint8Array): RawRepository {
  const blob = "b".repeat(40);
  return {
    async info() {
      return { lastPushAt: "now" } as ArtifactsRepoInfo;
    },
    async log() {
      return [{ hash: "c".repeat(40), treeHash: "d".repeat(40) } as ArtifactsCommitMetadata];
    },
    async readTree() {
      return [{ name: "file.txt", mode: "100644", hash: blob, type: "blob" }];
    },
    async readBlob() {
      return new Blob([content as BlobPart]);
    },
  };
}
const options = {
  audience: { shared: true, anonymous: true },
  forceDownload: false,
  head: false,
  ifNoneMatch: null,
};

describe("raw responses", () => {
  it("sends nosniff, a sandbox CSP and an inline disposition for text", async () => {
    const response = await serveRaw(
      rawRepo(encode("hello")),
      { ref: "main", path: "file.txt" },
      options
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      `inline; filename="file.txt"; filename*=UTF-8''file.txt`
    );
    expect(await response.text()).toBe("hello");
  });
  it("forces a download for binary content", async () => {
    const response = await serveRaw(
      rawRepo(new Uint8Array([0, 1, 2])),
      { ref: "main", path: "file.txt" },
      options
    );
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
  });
  it("keys public cache validation on the blob id and answers 304", async () => {
    const first = await serveRaw(rawRepo(encode("x")), { ref: "main", path: "file.txt" }, options);
    expect(first.headers.get("ETag")).toBe(`"${"b".repeat(40)}"`);
    expect(first.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=30, must-revalidate"
    );
    const conditional = await serveRaw(
      rawRepo(encode("x")),
      { ref: "main", path: "file.txt" },
      { ...options, ifNoneMatch: first.headers.get("ETag") }
    );
    expect(conditional.status).toBe(304);
    const pinned = await serveRaw(
      rawRepo(encode("x")),
      { ref: "a".repeat(40), path: "file.txt" },
      options
    );
    expect(pinned.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, s-maxage=3600, immutable"
    );
    expect(pinned.headers.get("X-GitEdge-Cache")).toBe("bypass");
  });
  it("never lets shared caches keep private content", async () => {
    const response = await serveRaw(
      rawRepo(encode("x")),
      { ref: "main", path: "file.txt" },
      { ...options, audience: { shared: false, anonymous: true } }
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("answers 404 for missing paths", async () => {
    const response = await serveRaw(
      rawRepo(encode("x")),
      { ref: "main", path: "missing.txt" },
      options
    );
    expect(response.status).toBe(404);
  });
});
