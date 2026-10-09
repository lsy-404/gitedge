import { unzipSync } from "fflate";
import { unpackTar } from "modern-tar";
import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  archiveStream,
  planArchive,
  type ArchiveLimits,
  type ArchiveStore,
} from "../../workers/git/src/archive";

interface FakeFile {
  content: string | Uint8Array;
  type?: ArtifactsTreeEntryType;
}
type FakeTree = Record<string, FakeFile | FakeTree>;

function isFile(value: FakeFile | FakeTree): value is FakeFile {
  return (
    "content" in value && (typeof value.content === "string" || value.content instanceof Uint8Array)
  );
}

function fakeStore(root: FakeTree, options: { memoryLimitFor?: string } = {}): ArchiveStore {
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, Uint8Array>();
  let counter = 0;
  const id = () => (counter++).toString(16).padStart(40, "0");
  function add(tree: FakeTree): string {
    const hash = id();
    trees.set(
      hash,
      Object.entries(tree).map(([name, value]) => {
        if (isFile(value)) {
          const blob = id();
          blobs.set(
            blob,
            typeof value.content === "string"
              ? new TextEncoder().encode(value.content)
              : value.content
          );
          if (options.memoryLimitFor === name) blobs.delete(blob);
          return { name, mode: "100644", hash: blob, type: value.type ?? "blob" };
        }
        return { name, mode: "40000", hash: add(value), type: "tree" as const };
      })
    );
    return hash;
  }
  const rootHash = add(root);
  trees.set("root", trees.get(rootHash) ?? []);
  return {
    async readTree(hash) {
      return trees.get(hash) ?? null;
    },
    async readBlob(hash) {
      const bytes = blobs.get(hash);
      if (!bytes && options.memoryLimitFor)
        throw Object.assign(new Error("memory"), { code: "MEMORY_LIMIT" });
      return bytes ? new Blob([bytes as BlobPart]) : null;
    },
  };
}

const limits: ArchiveLimits = { maxFiles: 5, maxDirectories: 4, maxBytes: 100, maxFileBytes: 60 };
const options = { root: "demo-main", mtime: new Date("2026-01-02T03:04:05Z"), limits };

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(
    new Response(bytes as BlobPart).body!.pipeThrough(new DecompressionStream("gzip"))
  );
}

describe("source archives", () => {
  const tree: FakeTree = {
    "README.md": { content: "# demo\n" },
    src: { "main.ts": { content: "export {};\n" }, empty: {} },
    run: { content: "main.ts", type: "symlink" },
    sub: { content: "ignored", type: "gitlink" },
  };

  it("plans files in path order and leaves submodules out", async () => {
    const plan = await planArchive(fakeStore(tree), "root", limits);
    expect(plan.files.map((file) => file.path)).toEqual(["README.md", "run", "src/main.ts"]);
    expect(plan.directories).toEqual(["src", "src/empty"]);
    expect(plan.files.find((file) => file.path === "run")?.mode).toBe("120000");
  });

  it("streams a zip with a single root folder", async () => {
    const store = fakeStore(tree);
    const plan = await planArchive(store, "root", limits);
    const files = unzipSync(await collect(archiveStream(store, plan, "zip", options)));
    expect(Object.keys(files).sort()).toEqual([
      "demo-main/README.md",
      "demo-main/run",
      "demo-main/src/",
      "demo-main/src/empty/",
      "demo-main/src/main.ts",
    ]);
    expect(new TextDecoder().decode(files["demo-main/src/main.ts"])).toBe("export {};\n");
  });

  it("streams a tar.gz with the same content", async () => {
    const store = fakeStore(tree);
    const plan = await planArchive(store, "root", limits);
    const entries = await unpackTar(
      await gunzip(await collect(archiveStream(store, plan, "tar.gz", options)))
    );
    const readme = entries.find((entry) => entry.header.name === "demo-main/README.md");
    expect(new TextDecoder().decode(readme?.data)).toBe("# demo\n");
    expect(entries.find((entry) => entry.header.name === "demo-main/run")?.header.type).toBe(
      "symlink"
    );
    expect(entries.map((entry) => entry.header.name)).toContain("demo-main/src/empty/");
  });

  it("refuses repositories above the file count before streaming", async () => {
    const many: FakeTree = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`f${index}.txt`, { content: "x" }])
    );
    await expect(planArchive(fakeStore(many), "root", limits)).rejects.toMatchObject({
      code: "archive_too_large",
    });
  });

  it("refuses repositories above the directory count", async () => {
    const deep: FakeTree = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`d${index}`, { "a.txt": { content: "x" } }])
    );
    await expect(planArchive(fakeStore(deep), "root", limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects paths that could escape the archive root", async () => {
    for (const name of ["..", ".git", "a\\b"]) {
      await expect(
        planArchive(fakeStore({ [name]: { content: "x" } }), "root", limits)
      ).rejects.toMatchObject({ code: "archive_invalid" });
    }
  });

  for (const format of ["zip", "tar.gz"] as const) {
    it(`fails the ${format} stream instead of ending it early when the byte cap is hit`, async () => {
      const big: FakeTree = {
        "a.bin": { content: new Uint8Array(50).fill(1) },
        "b.bin": { content: new Uint8Array(50).fill(2) },
        "c.bin": { content: new Uint8Array(50).fill(3) },
      };
      const store = fakeStore(big);
      const plan = await planArchive(store, "root", limits);
      await expect(collect(archiveStream(store, plan, format, options))).rejects.toMatchObject({
        code: "archive_too_large",
      });
    });

    it(`fails the ${format} stream when one file exceeds the per-file cap`, async () => {
      const store = fakeStore({ "huge.bin": { content: new Uint8Array(61) } });
      const plan = await planArchive(store, "root", limits);
      await expect(collect(archiveStream(store, plan, format, options))).rejects.toThrow(
        /too large/
      );
    });
  }

  it("reports a platform memory refusal as an archive limit", async () => {
    const store = fakeStore({ "big.bin": { content: "x" } }, { memoryLimitFor: "big.bin" });
    const plan = await planArchive(store, "root", limits);
    await expect(collect(archiveStream(store, plan, "zip", options))).rejects.toMatchObject({
      code: "archive_too_large",
    });
  });

  it("produces a valid empty archive for an empty tree", async () => {
    const store = fakeStore({});
    const plan = await planArchive(store, "root", limits);
    expect(
      Object.keys(unzipSync(await collect(archiveStream(store, plan, "zip", options))))
    ).toEqual([]);
  });
});
