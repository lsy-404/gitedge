import { describe, expect, it } from "vitest";
import {
  CommitRepositoryChangesSchema,
  REPOSITORY_COMMIT_LIMITS,
  editablePath,
} from "../../packages/contracts/src/repository-controls";
import {
  CommitRequestError,
  commitFromEdit,
  readCommitRequest,
} from "../../workers/git/src/commit-request";

const oid = "a".repeat(40);
const base = { branch: "main", expectedOid: oid, message: "Upload files" };

async function multipart(
  manifest: unknown,
  files: Record<string, Uint8Array | string> = {},
  headers: Record<string, string> = {}
): Promise<Request> {
  const form = new FormData();
  form.set("manifest", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files))
    form.set(name, typeof content === "string" ? content : new File([content], "upload.bin"));
  const encoded = new Response(form);
  return new Request("https://git.test/repositories/r1/commit", {
    method: "POST",
    body: await encoded.arrayBuffer(),
    headers: { "Content-Type": encoded.headers.get("Content-Type") ?? "", ...headers },
  });
}
async function failure(request: Request): Promise<CommitRequestError> {
  const error = await readCommitRequest(request).catch((cause: unknown) => cause);
  if (!(error instanceof CommitRequestError)) throw new Error("Expected a commit request error.");
  return error;
}

describe("repository paths", () => {
  it("accepts nested paths and rejects traversal, .git and control characters", () => {
    expect(editablePath("docs/a/b.md")).toBe(true);
    expect(editablePath(".github/workflows/ci.yml")).toBe(true);
    for (const bad of [
      "",
      "../x",
      "a/../x",
      "./x",
      "/abs",
      "a//b",
      "a\\b",
      ".git/config",
      "src/.GIT/hooks",
      "a/.git",
      "bad\u0000name",
      ".git./config",
      ".git /config",
      "GIT~1/config",
      ".g\u200cit/config",
      "a/.git\ufeff/hooks",
      Array.from({ length: 33 }, () => "d").join("/"),
    ])
      expect(editablePath(bad), bad).toBe(false);
  });
});

describe("commit manifest", () => {
  it("rejects overlapping, self-nested and duplicate-part changes", () => {
    const parse = (changes: unknown[]) =>
      CommitRepositoryChangesSchema.safeParse({ ...base, changes }).success;
    expect(
      parse([
        { op: "put", path: "a/b.txt", part: "f0" },
        { op: "delete", path: "c.txt" },
      ])
    ).toBe(true);
    expect(
      parse([
        { op: "delete", path: "a" },
        { op: "put", path: "a/b.txt", part: "f0" },
      ])
    ).toBe(false);
    expect(parse([{ op: "move", from: "a", to: "a/b" }])).toBe(false);
    expect(parse([{ op: "move", from: "a", to: "a" }])).toBe(false);
    expect(
      parse([
        { op: "put", path: "x.txt", part: "f0" },
        { op: "put", path: "y.txt", part: "f0" },
      ])
    ).toBe(false);
    expect(parse([{ op: "put", path: "../x", part: "f0" }])).toBe(false);
    expect(parse([{ op: "delete", path: ".git/HEAD" }])).toBe(false);
    expect(parse([])).toBe(false);
  });
});

describe("readCommitRequest", () => {
  it("reads binary-safe file parts alongside deletes and moves", async () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    const result = await readCommitRequest(
      await multipart(
        {
          ...base,
          newBranch: "feature/upload",
          changes: [
            { op: "put", path: "assets/logo.bin", part: "f0" },
            { op: "delete", path: "old.txt" },
            { op: "move", from: "a", to: "b" },
          ],
        },
        { f0: bytes }
      )
    );
    expect(result.newBranch).toBe("feature/upload");
    expect(result.changes[0]).toMatchObject({ op: "put", path: "assets/logo.bin" });
    const put = result.changes[0];
    expect(put?.op === "put" && [...put.content]).toEqual([...bytes]);
    expect(result.changes.slice(1).map((change) => change.op)).toEqual(["delete", "move"]);
  });

  it("reads replacement content for a renamed file", async () => {
    const result = await readCommitRequest(
      await multipart(
        { ...base, changes: [{ op: "move", from: "a.sh", to: "bin/a.sh", part: "f0" }] },
        { f0: new Uint8Array([7]) }
      )
    );
    const move = result.changes[0];
    expect(move?.op === "move" && move.content && [...move.content]).toEqual([7]);
    const missing = { ...base, changes: [{ op: "move", from: "a", to: "b", part: "f0" }] };
    expect((await failure(await multipart(missing))).status).toBe(400);
  });

  it("rejects non-multipart bodies, bad manifests, missing and extra parts", async () => {
    const json = new Request("https://git.test/x", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect((await failure(json)).status).toBe(415);
    expect((await failure(await multipart("not json"))).status).toBe(400);
    expect((await failure(await multipart({ ...base, changes: [] }))).status).toBe(400);
    const put = { ...base, changes: [{ op: "put", path: "a.txt", part: "f0" }] };
    expect((await failure(await multipart(put))).status).toBe(400);
    expect((await failure(await multipart(put, { f0: "plain string" }))).status).toBe(400);
    expect(
      (await failure(await multipart(put, { f0: new Uint8Array(1), extra: new Uint8Array(1) })))
        .status
    ).toBe(400);
  });

  it("enforces per-file and per-commit size caps", async () => {
    const big = new Uint8Array(REPOSITORY_COMMIT_LIMITS.fileBytes + 1);
    const oneFile = { ...base, changes: [{ op: "put", path: "big.bin", part: "f0" }] };
    const tooBig = await failure(await multipart(oneFile, { f0: big }));
    expect(tooBig).toMatchObject({ status: 413, code: "file_too_large" });

    const chunk = new Uint8Array(REPOSITORY_COMMIT_LIMITS.fileBytes);
    const three = {
      ...base,
      changes: ["f0", "f1", "f2"].map((part, index) => ({
        op: "put",
        path: `part${index}.bin`,
        part,
      })),
    };
    const total = await failure(await multipart(three, { f0: chunk, f1: chunk, f2: chunk }));
    expect(total).toMatchObject({ status: 413, code: "payload_too_large" });
  });

  it("rejects an oversized declared body before reading it", async () => {
    const request = await multipart({ ...base, changes: [{ op: "delete", path: "a" }] });
    const headers = new Headers(request.headers);
    headers.set("Content-Length", String(REPOSITORY_COMMIT_LIMITS.totalBytes * 2));
    Object.defineProperty(request, "headers", { value: headers });
    expect((await failure(request)).status).toBe(413);
  });
});

describe("commitFromEdit", () => {
  it("maps single-file edits onto commit changes and validates the path", () => {
    const put = commitFromEdit({ ...base, path: "docs/a.md", content: "hi" });
    expect(put.changes).toMatchObject([{ op: "put", path: "docs/a.md", textEdit: true }]);
    expect(commitFromEdit({ ...base, path: "docs/a.md", content: null }).changes).toEqual([
      { op: "delete", path: "docs/a.md" },
    ]);
    expect(() => commitFromEdit({ ...base, path: ".git/config", content: "x" })).toThrow(
      CommitRequestError
    );
  });
});
