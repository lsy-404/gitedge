export interface HistoryStep {
  message: string;
  /** Complete file set of the commit; a string, or bytes for binary content. */
  files: Record<string, string | Uint8Array>;
  author?: string;
  /** Parent step indexes; defaults to the previous step. */
  parents?: number[];
}

export interface MemoryHistory {
  repo: ArtifactsRepo;
  /** Commit ids by step index. */
  oids: string[];
  reads: { trees: number; blobs: number; logs: number };
}

async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Directory {
  files: Map<string, string | Uint8Array>;
  children: Map<string, Directory>;
}

function directoryOf(files: Record<string, string | Uint8Array>): Directory {
  const root: Directory = { files: new Map(), children: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split("/");
    const name = segments.pop() ?? "";
    let directory = root;
    for (const segment of segments) {
      let child = directory.children.get(segment);
      if (!child) {
        child = { files: new Map(), children: new Map() };
        directory.children.set(segment, child);
      }
      directory = child;
    }
    directory.files.set(name, content);
  }
  return root;
}

function bytesOf(content: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

/** Builds a content-addressed in-memory repository whose branch `main` ends at the last step. */
export async function memoryHistory(steps: HistoryStep[]): Promise<MemoryHistory> {
  const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const commits = new Map<string, ArtifactsCommitMetadata>();
  const oids: string[] = [];

  async function writeTree(directory: Directory): Promise<string> {
    const entries: ArtifactsTreeEntry[] = [];
    for (const [name, content] of directory.files) {
      const bytes = bytesOf(content);
      const hash = await sha1(`blob:${[...bytes].join(",")}`);
      blobs.set(hash, bytes);
      entries.push({ name, mode: "100644", hash, type: "blob" });
    }
    for (const [name, child] of directory.children)
      entries.push({ name, mode: "40000", hash: await writeTree(child), type: "tree" });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    const hash = await sha1(`tree:${JSON.stringify(entries)}`);
    trees.set(hash, entries);
    return hash;
  }

  for (const [index, step] of steps.entries()) {
    const parents = (step.parents ?? (index === 0 ? [] : [index - 1])).map((parent) => {
      const oid = oids[parent];
      if (!oid) throw new Error("Fixture parent must precede its child.");
      return oid;
    });
    const treeHash = await writeTree(directoryOf(step.files));
    const name = step.author ?? "Author";
    const hash = await sha1(`commit:${index}:${treeHash}:${parents.join(",")}:${step.message}`);
    commits.set(hash, {
      hash,
      treeHash,
      message: step.message,
      author: { name, email: `${name.toLowerCase()}@example.test` },
      committer: { name, email: `${name.toLowerCase()}@example.test` },
      parents,
      authoredAt: 1_790_000_000 + index * 60,
      committedAt: 1_790_000_000 + index * 60,
    });
    oids.push(hash);
  }

  const reads = { trees: 0, blobs: 0, logs: 0 };
  const unsupported = async (): Promise<never> => {
    throw new Error("Not supported by the history fixture.");
  };
  const repo: ArtifactsRepo = {
    [Symbol.dispose]() {},
    createToken: unsupported,
    listTokens: unsupported,
    revokeToken: unsupported,
    info: unsupported,
    fork: unsupported,
    readFile: unsupported,
    async readBlob(hash) {
      reads.blobs += 1;
      const bytes = blobs.get(hash);
      return bytes ? new Blob([bytes]) : null;
    },
    async readTree(hash) {
      reads.trees += 1;
      return trees.get(hash) ?? null;
    },
    async readCommit(hash) {
      return commits.get(hash) ?? null;
    },
    async log(options) {
      reads.logs += 1;
      const ref = options?.ref ?? "main";
      let current = commits.get(ref === "main" || ref === "HEAD" ? (oids.at(-1) ?? "") : ref);
      const result: ArtifactsCommitMetadata[] = [];
      let skipped = options?.offset ?? 0;
      while (current && result.length < (options?.limit ?? 50)) {
        if (skipped > 0) skipped -= 1;
        else result.push(current);
        current = commits.get(current.parents[0] ?? "");
      }
      return result;
    },
  };
  return { repo, oids, reads };
}
