import * as git from "isomorphic-git";
import { Volume, createFsFromVolume } from "memfs";
import { describe, expect, it } from "vitest";
import { applyRepositoryChanges, GitWriteInputError } from "../../workers/git/src/changes";

const text = (value: string) => new TextEncoder().encode(value);

function store() {
  return { fs: createFsFromVolume(new Volume()), dir: "/repo" };
}
async function seed(files: Record<string, Uint8Array>) {
  const repo = store();
  await git.init({ ...repo, defaultBranch: "main" });
  const changes = Object.entries(files).map(([path, content]) => ({
    op: "put" as const,
    path,
    content,
  }));
  return { repo, root: await applyRepositoryChanges(repo, null, changes) };
}
async function listing(
  repo: ReturnType<typeof store>,
  root: string,
  prefix = ""
): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of (await git.readTree({ ...repo, oid: root })).tree) {
    if (entry.type === "tree")
      paths.push(...(await listing(repo, entry.oid, prefix + entry.path + "/")));
    else paths.push(prefix + entry.path);
  }
  return paths.sort();
}
async function blobAt(repo: ReturnType<typeof store>, root: string, path: string) {
  const { blob } = await git.readBlob({ ...repo, oid: root, filepath: path });
  return blob;
}

describe("applyRepositoryChanges", () => {
  it("applies adds, edits, deletes and moves in one tree", async () => {
    const { repo, root } = await seed({
      "README.md": text("old"),
      "src/a.ts": text("a"),
      "src/lib/b.ts": text("b"),
      "docs/guide.md": text("guide"),
    });
    const next = await applyRepositoryChanges(repo, root, [
      { op: "put", path: "README.md", content: text("new") },
      { op: "put", path: "assets/deep/new.bin", content: new Uint8Array([0, 255, 1, 128]) },
      { op: "delete", path: "docs/guide.md" },
      { op: "move", from: "src/lib", to: "packages/core" },
    ]);
    expect(await listing(repo, next)).toEqual([
      "README.md",
      "assets/deep/new.bin",
      "packages/core/b.ts",
      "src/a.ts",
    ]);
    expect(new TextDecoder().decode(await blobAt(repo, next, "README.md"))).toBe("new");
    expect([...(await blobAt(repo, next, "assets/deep/new.bin"))]).toEqual([0, 255, 1, 128]);
  });

  it("prunes directories left empty and keeps unrelated trees identical", async () => {
    const { repo, root } = await seed({ "only/file.txt": text("x"), "keep/me.txt": text("y") });
    const next = await applyRepositoryChanges(repo, root, [
      { op: "delete", path: "only/file.txt" },
    ]);
    expect(await listing(repo, next)).toEqual(["keep/me.txt"]);
    const before = (await git.readTree({ ...repo, oid: root })).tree.find((e) => e.path === "keep");
    const after = (await git.readTree({ ...repo, oid: next })).tree.find((e) => e.path === "keep");
    expect(after?.oid).toBe(before?.oid);
  });

  it("deletes a whole directory and returns the empty tree for an emptied repository", async () => {
    const { repo, root } = await seed({ "dir/a.txt": text("a"), "dir/sub/b.txt": text("b") });
    const next = await applyRepositoryChanges(repo, root, [{ op: "delete", path: "dir" }]);
    expect(await listing(repo, next)).toEqual([]);
  });

  it("preserves the executable bit when a file is replaced", async () => {
    const repo = store();
    await git.init({ ...repo, defaultBranch: "main" });
    const blob = await git.writeBlob({ ...repo, blob: text("#!/bin/sh") });
    const tree = await git.writeTree({
      ...repo,
      tree: [{ path: "run.sh", mode: "100755", type: "blob", oid: blob }],
    });
    const next = await applyRepositoryChanges(repo, tree, [
      { op: "put", path: "run.sh", content: text("#!/bin/bash") },
    ]);
    expect((await git.readTree({ ...repo, oid: next })).tree[0]?.mode).toBe("100755");
  });

  it("creates a file inside a missing folder given a slash path", async () => {
    const { repo, root } = await seed({ "a.txt": text("a") });
    const next = await applyRepositoryChanges(repo, root, [
      { op: "put", path: "new/folder/tree/file.txt", content: text("z") },
    ]);
    expect(await listing(repo, next)).toContain("new/folder/tree/file.txt");
  });

  it("rejects invalid structural changes", async () => {
    const { repo, root } = await seed({ "file.txt": text("a"), "dir/x.txt": text("x") });
    const reject = (changes: Parameters<typeof applyRepositoryChanges>[2]) =>
      expect(applyRepositoryChanges(repo, root, changes)).rejects.toBeInstanceOf(
        GitWriteInputError
      );
    await reject([{ op: "put", path: "file.txt/child.txt", content: text("x") }]);
    await reject([{ op: "put", path: "dir", content: text("x") }]);
    await reject([{ op: "delete", path: "missing.txt" }]);
    await reject([{ op: "move", from: "missing.txt", to: "other.txt" }]);
    await reject([{ op: "move", from: "file.txt", to: "dir" }]);
  });

  it("enforces the text-only rule only for text edits", async () => {
    const { repo, root } = await seed({ "image.bin": new Uint8Array([0, 1, 2]) });
    await expect(
      applyRepositoryChanges(repo, root, [
        { op: "put", path: "image.bin", content: text("t"), textEdit: true },
      ])
    ).rejects.toBeInstanceOf(GitWriteInputError);
    const replaced = await applyRepositoryChanges(repo, root, [
      { op: "put", path: "image.bin", content: new Uint8Array([9, 9]) },
    ]);
    expect([...(await blobAt(repo, replaced, "image.bin"))]).toEqual([9, 9]);
  });
});
