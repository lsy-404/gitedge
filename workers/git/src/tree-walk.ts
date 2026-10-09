export class WalkBudgetError extends Error {}

export interface PathEntry {
  oid: string;
  mode: string;
  type: ArtifactsTreeEntryType;
}

export function samePathEntry(a: PathEntry | null, b: PathEntry | null): boolean {
  return a === b || (a !== null && b !== null && a.oid === b.oid && a.mode === b.mode);
}

/** Reads each tree object at most once and enforces a per-request read budget. */
export class TreeReader {
  readonly #repo: ArtifactsRepo;
  readonly #maxReads: number;
  readonly #cache = new Map<string, ArtifactsTreeEntry[] | null>();
  #reads = 0;

  constructor(repo: ArtifactsRepo, maxReads: number) {
    this.#repo = repo;
    this.#maxReads = maxReads;
  }

  get reads(): number {
    return this.#reads;
  }

  async read(oid: string): Promise<ArtifactsTreeEntry[] | null> {
    const cached = this.#cache.get(oid);
    if (cached !== undefined) return cached;
    if (this.#reads >= this.#maxReads) throw new WalkBudgetError("Tree read budget exhausted.");
    this.#reads += 1;
    const entries = await this.#repo.readTree(oid);
    this.#cache.set(oid, entries);
    return entries;
  }

  /** Resolves a slash-separated path below a tree; null when any segment is missing. */
  async entryAt(treeOid: string, path: string): Promise<PathEntry | null> {
    const segments = path.split("/").filter(Boolean);
    let oid = treeOid;
    for (const [index, segment] of segments.entries()) {
      const entry = (await this.read(oid))?.find((item) => item.name === segment);
      if (!entry) return null;
      if (index === segments.length - 1)
        return { oid: entry.hash, mode: entry.mode, type: entry.type };
      if (entry.type !== "tree") return null;
      oid = entry.hash;
    }
    return null;
  }
}

/** Streams the first-parent chain from a ref or commit, fetching bounded pages lazily. */
export class FirstParentWalk {
  readonly #repo: ArtifactsRepo;
  readonly #pageSize: number;
  #buffer: ArtifactsCommitMetadata[] = [];
  #next: string | null;

  constructor(repo: ArtifactsRepo, start: string, pageSize = 100) {
    this.#repo = repo;
    this.#next = start;
    this.#pageSize = pageSize;
  }

  async take(): Promise<ArtifactsCommitMetadata | null> {
    if (this.#buffer.length === 0 && this.#next !== null) {
      const page = await this.#repo.log({ ref: this.#next, limit: this.#pageSize });
      this.#buffer = page;
      this.#next = page.at(-1)?.parents[0] ?? null;
    }
    return this.#buffer.shift() ?? null;
  }
}
