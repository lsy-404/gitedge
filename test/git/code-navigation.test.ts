import { describe, expect, it } from "vitest";
import { BLAME_LIMITS, blameFile } from "../../workers/git/src/blame";
import { commitDetail } from "../../workers/git/src/commit-diff";
import { listFiles, pathHistory } from "../../workers/git/src/navigation";
import { memoryHistory, type HistoryStep } from "../support/memory-history";

const lines = (...values: string[]) => values.join("\n") + "\n";

describe("file listing", () => {
  const steps: HistoryStep[] = [
    {
      message: "init",
      files: { "README.md": "hi", "src/b.ts": "b", "src/a.ts": "a", "src/deep/c.ts": "c" },
    },
  ];

  it("lists every blob path sorted and keyed by the resolved commit", async () => {
    const { repo, oids } = await memoryHistory(steps);
    expect(await listFiles(repo, "main")).toEqual({
      oid: oids[0],
      paths: ["README.md", "src/a.ts", "src/b.ts", "src/deep/c.ts"],
      truncated: false,
    });
    expect((await listFiles(repo, oids[0] ?? ""))?.oid).toBe(oids[0]);
  });

  it("returns null for an unknown ref", async () => {
    const { repo } = await memoryHistory(steps);
    expect(await listFiles(repo, "0".repeat(40))).toBeNull();
  });

  it("reports truncation at the path limit", async () => {
    const { repo } = await memoryHistory(steps);
    const result = await listFiles(repo, "main", { paths: 2, trees: 10, concurrency: 2 });
    expect(result?.paths).toHaveLength(2);
    expect(result?.truncated).toBe(true);
  });

  it("reports truncation at the directory limit", async () => {
    const { repo } = await memoryHistory(steps);
    const result = await listFiles(repo, "main", { paths: 100, trees: 2, concurrency: 1 });
    expect(result?.truncated).toBe(true);
    expect(result?.paths).toContain("README.md");
    expect(result?.paths).not.toContain("src/deep/c.ts");
  });
});

describe("path history", () => {
  const steps: HistoryStep[] = [
    { message: "one", files: { "a.txt": "1", "dir/b.txt": "1" } },
    { message: "two", files: { "a.txt": "2", "dir/b.txt": "1" } },
    { message: "three", files: { "a.txt": "2", "dir/b.txt": "2" } },
    { message: "four", files: { "a.txt": "2", "dir/b.txt": "2", "c.txt": "x" } },
    { message: "five", files: { "a.txt": "3", "dir/b.txt": "2", "c.txt": "x" } },
  ];

  it("returns only commits that changed the path, newest first", async () => {
    const { repo, oids } = await memoryHistory(steps);
    const result = await pathHistory(repo, "main", "a.txt");
    expect(result.commits.map((commit) => commit.oid)).toEqual([oids[4], oids[1], oids[0]]);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("follows nested files and directories", async () => {
    const { repo, oids } = await memoryHistory(steps);
    expect((await pathHistory(repo, "main", "dir/b.txt")).commits.map((c) => c.oid)).toEqual([
      oids[2],
      oids[0],
    ]);
    expect((await pathHistory(repo, "main", "dir")).commits.map((c) => c.oid)).toEqual([
      oids[2],
      oids[0],
    ]);
  });

  it("includes the commit that added a path and ignores paths that never existed", async () => {
    const { repo, oids } = await memoryHistory(steps);
    expect((await pathHistory(repo, "main", "c.txt")).commits.map((c) => c.oid)).toEqual([oids[3]]);
    expect((await pathHistory(repo, "main", "missing.txt")).commits).toEqual([]);
  });

  it("stops at the result limit and resumes from the cursor", async () => {
    const { repo, oids } = await memoryHistory(steps);
    const limits = { inspect: 100, results: 2, treeReads: 100 };
    const first = await pathHistory(repo, "main", "a.txt", limits);
    expect(first.commits.map((c) => c.oid)).toEqual([oids[4], oids[1]]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe(oids[0]);
    const second = await pathHistory(repo, first.nextCursor ?? "", "a.txt", limits);
    expect(second.commits.map((c) => c.oid)).toEqual([oids[0]]);
    expect(second.truncated).toBe(false);
  });

  it("stops at the inspection limit and reports how far it looked", async () => {
    const { repo, oids } = await memoryHistory(steps);
    const result = await pathHistory(repo, "main", "a.txt", {
      inspect: 2,
      results: 30,
      treeReads: 100,
    });
    expect(result.inspected).toBe(2);
    expect(result.commits.map((c) => c.oid)).toEqual([oids[4]]);
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe(oids[2]);
  });

  it("stops at the tree read budget with a resumable cursor", async () => {
    const { repo } = await memoryHistory(steps);
    const result = await pathHistory(repo, "main", "dir/b.txt", {
      inspect: 100,
      results: 30,
      treeReads: 5,
    });
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });

  it("follows only the first parent through a merge", async () => {
    const { repo, oids } = await memoryHistory([
      { message: "base", files: { "f.txt": "0" } },
      { message: "main change", files: { "f.txt": "0", "m.txt": "m" } },
      { message: "side change", files: { "f.txt": "side" }, parents: [0] },
      { message: "merge", files: { "f.txt": "side", "m.txt": "m" }, parents: [1, 2] },
    ]);
    expect((await pathHistory(repo, "main", "f.txt")).commits.map((c) => c.oid)).toEqual([
      oids[3],
      oids[0],
    ]);
  });
});

describe("blame", () => {
  async function blamed(steps: HistoryStep[], limits?: Parameters<typeof blameFile>[3]) {
    const history = await memoryHistory(steps);
    const result = await blameFile(history.repo, "main", "f.txt", limits);
    if (result.status !== "ok") throw new Error(`Unexpected blame status ${result.status}`);
    return { ...history, blame: result.blame };
  }

  it("attributes each line to the commit that introduced it", async () => {
    const { blame, oids } = await blamed([
      { message: "create", files: { "f.txt": lines("a", "b", "c") } },
      { message: "edit b", files: { "f.txt": lines("a", "B", "c") } },
      { message: "append", files: { "f.txt": lines("a", "B", "c", "d") } },
    ]);
    expect(blame.hunks).toEqual([
      { startLine: 1, lineCount: 1, commitOid: oids[0] },
      { startLine: 2, lineCount: 1, commitOid: oids[1] },
      { startLine: 3, lineCount: 1, commitOid: oids[0] },
      { startLine: 4, lineCount: 1, commitOid: oids[2] },
    ]);
    expect(blame.lineCount).toBe(4);
    expect(blame.partial).toBe(false);
    expect(blame.oid).toBe(oids[2]);
    expect(blame.commits.map((commit) => commit.oid).sort()).toEqual(
      [oids[0], oids[1], oids[2]].sort()
    );
    expect(blame.commits.find((commit) => commit.oid === oids[1])).toMatchObject({
      summary: "edit b",
      author: { name: "Author" },
    });
  });

  it("merges adjacent lines from one commit into a hunk and keeps surviving lines through unrelated commits", async () => {
    const { blame, oids } = await blamed([
      { message: "create", files: { "f.txt": lines("a", "b", "c", "d") } },
      { message: "unrelated", files: { "f.txt": lines("a", "b", "c", "d"), "g.txt": "g" } },
      { message: "insert", files: { "f.txt": lines("a", "x", "y", "b", "c", "d") } },
    ]);
    expect(blame.hunks).toEqual([
      { startLine: 1, lineCount: 1, commitOid: oids[0] },
      { startLine: 2, lineCount: 2, commitOid: oids[2] },
      { startLine: 4, lineCount: 3, commitOid: oids[0] },
    ]);
  });

  it("blames a file recreated after deletion from the recreating commit", async () => {
    const { blame, oids } = await blamed([
      { message: "create", files: { "f.txt": lines("a") } },
      { message: "delete", files: { "g.txt": "g" } },
      { message: "recreate", files: { "f.txt": lines("a"), "g.txt": "g" } },
    ]);
    expect(blame.hunks).toEqual([{ startLine: 1, lineCount: 1, commitOid: oids[2] }]);
  });

  it("reports partial results when the commit budget ends the walk", async () => {
    const { blame, oids } = await blamed(
      [
        { message: "create", files: { "f.txt": lines("a", "b") } },
        { message: "edit", files: { "f.txt": lines("a", "b", "c") } },
        { message: "edit again", files: { "f.txt": lines("a", "b", "c", "d") } },
      ],
      { ...BLAME_LIMITS, commits: 1 }
    );
    expect(blame.partial).toBe(true);
    expect(blame.hunks).toEqual([
      { startLine: 1, lineCount: 3, commitOid: null },
      { startLine: 4, lineCount: 1, commitOid: oids[2] },
    ]);
  });

  it("reports partial results when the blob read budget is exhausted", async () => {
    const { blame } = await blamed(
      [
        { message: "create", files: { "f.txt": lines("a") } },
        { message: "edit", files: { "f.txt": lines("a", "b") } },
      ],
      { ...BLAME_LIMITS, blobReads: 0 }
    );
    expect(blame.partial).toBe(true);
    expect(blame.hunks).toEqual([{ startLine: 1, lineCount: 2, commitOid: null }]);
  });

  it("reports partial results when the diff work budget is exhausted", async () => {
    const steps: HistoryStep[] = [
      { message: "create", files: { "f.txt": lines("a", "b", "c", "d") } },
      { message: "rewrite", files: { "f.txt": lines("w", "x", "y", "z") } },
      { message: "append", files: { "f.txt": lines("w", "x", "y", "z", "e") } },
    ];
    const generous = await blamed(steps);
    expect(generous.blame.partial).toBe(false);
    // The first diff (9 lines, 1 edit) fits; the full rewrite below it would exceed the budget.
    const { blame, oids } = await blamed(steps, { ...BLAME_LIMITS, diffWork: 20 });
    expect(blame.partial).toBe(true);
    expect(blame.hunks).toEqual([
      { startLine: 1, lineCount: 4, commitOid: null },
      { startLine: 5, lineCount: 1, commitOid: oids[2] },
    ]);
  });

  it("reports partial results when earlier versions exceed the byte budget", async () => {
    const { blame, oids } = await blamed(
      [
        { message: "create", files: { "f.txt": lines("a") } },
        { message: "edit", files: { "f.txt": lines("a", "b") } },
        { message: "edit again", files: { "f.txt": lines("a", "b", "c") } },
      ],
      { ...BLAME_LIMITS, blobBytes: 4 }
    );
    expect(blame.partial).toBe(true);
    expect(blame.hunks).toEqual([
      { startLine: 1, lineCount: 2, commitOid: null },
      { startLine: 3, lineCount: 1, commitOid: oids[2] },
    ]);
  });

  it("handles files without a trailing newline and empty files", async () => {
    const { blame, oids } = await blamed([
      { message: "create", files: { "f.txt": "a\nb" } },
      { message: "edit", files: { "f.txt": "a\nb\nc" } },
    ]);
    expect(blame.lineCount).toBe(3);
    expect(blame.hunks.at(-1)).toEqual({ startLine: 3, lineCount: 1, commitOid: oids[1] });
    const empty = await memoryHistory([{ message: "empty", files: { "f.txt": "" } }]);
    const result = await blameFile(empty.repo, "main", "f.txt");
    expect(result).toMatchObject({ status: "ok", blame: { lineCount: 0, hunks: [] } });
  });

  it("rejects missing, directory, binary and oversized files", async () => {
    const { repo } = await memoryHistory([
      {
        message: "mixed",
        files: {
          "dir/a.txt": "a",
          "bin.dat": new Uint8Array([0, 1, 2]),
          "big.txt": "x".repeat(20),
        },
      },
    ]);
    expect(await blameFile(repo, "main", "nope.txt")).toEqual({ status: "not_found" });
    expect(await blameFile(repo, "main", "dir")).toEqual({ status: "not_found" });
    expect(await blameFile(repo, "main", "bin.dat")).toEqual({
      status: "unsupported",
      reason: "binary",
    });
    expect(await blameFile(repo, "main", "big.txt", { ...BLAME_LIMITS, fileBytes: 10 })).toEqual({
      status: "unsupported",
      reason: "too_large",
    });
  });
});

describe("commit detail", () => {
  it("diffs a commit against its first parent and skips unchanged subtrees", async () => {
    const { repo, oids, reads } = await memoryHistory([
      {
        message: "one",
        files: { "keep/deep/x.txt": "x", "keep/y.txt": "y", "a.txt": "1", "gone.txt": "g" },
      },
      {
        message: "two",
        files: { "keep/deep/x.txt": "x", "keep/y.txt": "y", "a.txt": "2", "new/n.txt": "n" },
      },
    ]);
    reads.trees = 0;
    const detail = await commitDetail(repo, oids[1] ?? "");
    expect(detail?.commit.oid).toBe(oids[1]);
    expect(detail?.files.map((file) => [file.path, file.type])).toEqual([
      ["a.txt", "modified"],
      ["gone.txt", "deleted"],
      ["new/n.txt", "added"],
    ]);
    expect(detail?.files[0]?.patch).toContain("+2");
    expect(detail?.truncated).toBe(false);
    // Root, the unchanged "keep" subtree is never opened, only the added "new" tree is.
    expect(reads.trees).toBe(3);
  });

  it("diffs a root commit against the empty tree", async () => {
    const { repo, oids } = await memoryHistory([{ message: "root", files: { "a/b.txt": "b" } }]);
    const detail = await commitDetail(repo, oids[0] ?? "");
    expect(detail?.files).toMatchObject([{ path: "a/b.txt", type: "added", oldOid: null }]);
  });

  it("marks binary files without a patch and reports file-count truncation", async () => {
    const { repo, oids } = await memoryHistory([
      {
        message: "root",
        files: { "a.bin": new Uint8Array([0, 1]), "b.txt": "b", "c.txt": "c" },
      },
    ]);
    const detail = await commitDetail(repo, oids[0] ?? "", {
      files: 2,
      treeReads: 10,
      patchBytes: 1000,
    });
    expect(detail?.files).toHaveLength(2);
    expect(detail?.files[0]).toMatchObject({ path: "a.bin", binary: true, patch: null });
    expect(detail?.truncated).toBe(true);
  });

  it("stops reading blobs once the patch budget is spent", async () => {
    const { repo, oids, reads } = await memoryHistory([
      { message: "root", files: { "a.txt": "a".repeat(40), "b.txt": "b", "c.txt": "c" } },
    ]);
    reads.blobs = 0;
    const detail = await commitDetail(repo, oids[0] ?? "", {
      files: 10,
      treeReads: 10,
      patchBytes: 20,
    });
    expect(detail?.truncated).toBe(true);
    expect(detail?.files.map((file) => [file.path, file.patch])).toEqual([
      ["a.txt", null],
      ["b.txt", null],
      ["c.txt", null],
    ]);
    expect(detail?.files.every((file) => !file.binary)).toBe(true);
    // Only the first file's blob is read; one side of an added file is empty.
    expect(reads.blobs).toBe(1);
  });

  it("returns null for an unknown commit", async () => {
    const { repo } = await memoryHistory([{ message: "root", files: { "a.txt": "a" } }]);
    expect(await commitDetail(repo, "1".repeat(40))).toBeNull();
  });
});
