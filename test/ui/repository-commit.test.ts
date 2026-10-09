import { describe, expect, it } from "vitest";
import { REPOSITORY_COMMIT_LIMITS } from "../../packages/contracts/src/repository-controls";
import {
  commitPayload,
  stageUploads,
  uploadsFromDrop,
  type StagedUpload,
} from "../../apps/web/src/lib/repositoryCommit";

const oid = "a".repeat(40);
const base = { branch: "main", expectedOid: oid, message: "Commit" };
const upload = (path: string, size = 1): StagedUpload => ({
  path,
  file: new File([new Uint8Array(size)], path.split("/").at(-1) ?? path),
});

describe("stageUploads", () => {
  it("replaces files that share a path and reports invalid paths", () => {
    const first = stageUploads([], [upload("a.txt", 3), upload("../x.txt"), upload("dir/.git/x")]);
    expect(first.staged.map((item) => item.path)).toEqual(["a.txt"]);
    expect(first.rejected.map((item) => [item.path, item.reason])).toEqual([
      ["../x.txt", "path"],
      ["dir/.git/x", "path"],
    ]);
    const second = stageUploads(first.staged, [upload("a.txt", 9)]);
    expect(second.staged).toHaveLength(1);
    expect(second.staged[0]?.file.size).toBe(9);
  });

  it("enforces per-file, total and count limits", () => {
    const big = upload("big.bin", REPOSITORY_COMMIT_LIMITS.fileBytes + 1);
    expect(stageUploads([], [big]).rejected[0]?.reason).toBe("fileSize");

    const chunk = REPOSITORY_COMMIT_LIMITS.fileBytes;
    const result = stageUploads([], [upload("a", chunk), upload("b", chunk), upload("c", chunk)]);
    expect(result.staged.map((item) => item.path)).toEqual(["a", "b"]);
    expect(result.rejected[0]?.reason).toBe("totalSize");

    const many = Array.from({ length: REPOSITORY_COMMIT_LIMITS.changes + 1 }, (_, i) =>
      upload(`f${i}.txt`)
    );
    const capped = stageUploads([], many);
    expect(capped.staged).toHaveLength(REPOSITORY_COMMIT_LIMITS.changes);
    expect(capped.rejected[0]?.reason).toBe("count");
  });
});

describe("commitPayload", () => {
  it("assigns one file part per put and keeps deletes and moves in the manifest", () => {
    const payload = commitPayload(base, [
      { op: "put", path: "a.txt", content: new Blob(["a"]) },
      { op: "delete", path: "old" },
      { op: "move", from: "x", to: "y" },
      { op: "put", path: "b.txt", content: new Blob(["b"]) },
    ]);
    expect([...(payload?.files.keys() ?? [])]).toEqual(["f0", "f1"]);
    expect(payload?.manifest.changes).toEqual([
      { op: "put", path: "a.txt", part: "f0" },
      { op: "delete", path: "old" },
      { op: "move", from: "x", to: "y" },
      { op: "put", path: "b.txt", part: "f1" },
    ]);
  });

  it("returns null for overlapping or traversing changes", () => {
    expect(
      commitPayload(base, [
        { op: "delete", path: "dir" },
        { op: "put", path: "dir/a.txt", content: new Blob(["a"]) },
      ])
    ).toBeNull();
    expect(commitPayload(base, [{ op: "delete", path: "../x" }])).toBeNull();
  });
});

describe("uploadsFromDrop", () => {
  it("walks dropped folders recursively and keeps the folder structure", async () => {
    const file = (name: string): FileSystemFileEntry =>
      ({
        isFile: true,
        isDirectory: false,
        name,
        file: (resolve: (value: File) => void) => resolve(new File(["x"], name)),
      }) as unknown as FileSystemFileEntry;
    const directory = (name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry => {
      let served = false;
      return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => ({
          readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
            resolve(served ? [] : children);
            served = true;
          },
        }),
      } as unknown as FileSystemDirectoryEntry;
    };
    const tree = directory("site", [file("index.html"), directory("css", [file("app.css")])]);
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => tree }],
      files: [],
    } as unknown as DataTransfer;

    const { uploads, truncated } = await uploadsFromDrop(transfer, "web");
    expect(uploads.map((item) => item.path)).toEqual([
      "web/site/index.html",
      "web/site/css/app.css",
    ]);
    expect(truncated).toBe(false);
  });
});
