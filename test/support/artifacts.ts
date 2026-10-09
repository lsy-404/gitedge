export interface ArtifactsFixtureSnapshot {
  readonly info: ArtifactsRepoInfo;
  readonly tokens: readonly ArtifactsTokenInfo[];
}

interface FixtureToken {
  readonly id: string;
  readonly plaintext: string;
  readonly scope: "read" | "write";
  readonly createdAt: string;
  readonly expiresAt: string;
  state: "active" | "expired" | "revoked";
}

interface FixtureRepository {
  info: ArtifactsRepoInfo;
  readonly tokens: Map<string, FixtureToken>;
  readonly commits: ArtifactsCommitMetadata[];
  /** Per-ref history for log(); refs without an entry see every commit. */
  readonly branchCommits: Map<string, ArtifactsCommitMetadata[]>;
  readonly trees: Map<string, ArtifactsTreeEntry[]>;
  readonly blobs: Map<string, Uint8Array>;
}

type FixtureFile =
  string | Uint8Array | { content: string | Uint8Array; mode: "100755" | "120000" };

async function gitObjectId(kind: "blob" | "tree", body: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${kind} ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header);
  bytes.set(body, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface FixtureDirectory {
  files: Map<string, { oid: string; mode: string }>;
  directories: Map<string, FixtureDirectory>;
}

const baseCommit: ArtifactsCommitMetadata = {
  hash: "a".repeat(40),
  treeHash: "b".repeat(40),
  message: "Fixture repository base",
  author: { name: "Fixture", email: "fixture@example.test" },
  committer: { name: "Fixture", email: "fixture@example.test" },
  parents: [],
  authoredAt: 1_790_000_000,
  committedAt: 1_790_000_000,
};

function tokenInfo(token: FixtureToken): ArtifactsTokenInfo {
  return {
    id: token.id,
    scope: token.scope,
    state: token.state,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
  };
}

function createToken(
  repository: FixtureRepository,
  scope: "read" | "write",
  ttlSeconds: number
): ArtifactsCreateTokenResult {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
  const id = crypto.randomUUID();
  const token: FixtureToken = {
    id,
    plaintext: `artifact-fixture-${crypto.randomUUID()}`,
    scope,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    state: "active",
  };
  repository.tokens.set(id, token);
  return { id, plaintext: token.plaintext, scope, expiresAt: token.expiresAt };
}

function createRepository(
  name: string,
  options: { description?: string; defaultBranch?: string; readOnly?: boolean },
  source: string | null = null,
  commit: ArtifactsCommitMetadata = baseCommit
): { repository: FixtureRepository; created: ArtifactsCreateRepoResult } {
  const now = new Date().toISOString();
  const repository: FixtureRepository = {
    info: {
      id: crypto.randomUUID(),
      name,
      description: options.description ?? null,
      defaultBranch: options.defaultBranch ?? "main",
      createdAt: now,
      updatedAt: now,
      lastPushAt: now,
      source,
      readOnly: options.readOnly ?? false,
      remote: `https://artifacts.example.test/${encodeURIComponent(name)}.git`,
    },
    tokens: new Map(),
    commits: [commit],
    branchCommits: new Map(),
    trees: new Map(),
    blobs: new Map(),
  };
  const initialToken = createToken(repository, "write", 86_400);
  return {
    repository,
    created: {
      id: repository.info.id,
      name: repository.info.name,
      description: repository.info.description,
      defaultBranch: repository.info.defaultBranch,
      remote: repository.info.remote,
      token: initialToken.plaintext,
    },
  };
}

function repoListItem(info: ArtifactsRepoInfo): Omit<ArtifactsRepoInfo, "remote"> {
  const { remote: _remote, ...item } = info;
  return item;
}

export class FixtureArtifacts implements Artifacts {
  readonly repositories = new Map<string, FixtureRepository>();

  async create(
    name: string,
    options: { readOnly?: boolean; description?: string; setDefaultBranch?: string } = {}
  ): Promise<ArtifactsCreateRepoResult> {
    if (this.repositories.has(name)) throw new Error(`Artifact repo already exists: ${name}`);
    const { repository, created } = createRepository(name, {
      description: options.description,
      defaultBranch: options.setDefaultBranch,
      readOnly: options.readOnly,
    });
    this.repositories.set(name, repository);
    return created;
  }

  async get(name: string): Promise<ArtifactsRepo> {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Artifact repo not found: ${name}`);
    return this.handle(repository);
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string; opts?: { description?: string; readOnly?: boolean } };
  }): Promise<ArtifactsCreateRepoResult> {
    const result = await this.create(params.target.name, {
      description: params.target.opts?.description,
      readOnly: params.target.opts?.readOnly,
    });
    const repository = this.repositories.get(result.name);
    if (repository) repository.info.source = params.source.url;
    return result;
  }

  async list(options: { limit?: number; cursor?: string } = {}): Promise<ArtifactsRepoListResult> {
    const repositories = [...this.repositories.values()];
    const limit = options.limit ?? 50;
    return {
      repos: repositories.slice(0, limit).map((repository) => repoListItem(repository.info)),
      total: repositories.length,
    };
  }

  async delete(name: string): Promise<boolean> {
    return this.repositories.delete(name);
  }

  /** Replaces the repository's single commit with one whose tree holds the given files. */
  async seedFiles(name: string, files: Record<string, FixtureFile>): Promise<string> {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Artifact repo not found: ${name}`);
    const root: FixtureDirectory = { files: new Map(), directories: new Map() };
    const encoder = new TextEncoder();
    for (const [path, value] of Object.entries(files)) {
      const detail = typeof value === "object" && "mode" in value ? value : null;
      const raw = detail ? detail.content : (value as string | Uint8Array);
      const bytes = typeof raw === "string" ? encoder.encode(raw) : raw;
      const oid = await gitObjectId("blob", bytes);
      repository.blobs.set(oid, bytes);
      const segments = path.split("/");
      const leaf = segments.pop() ?? path;
      let directory = root;
      for (const segment of segments) {
        const next = directory.directories.get(segment) ?? {
          files: new Map(),
          directories: new Map(),
        };
        directory.directories.set(segment, next);
        directory = next;
      }
      directory.files.set(leaf, { oid, mode: detail?.mode ?? "100644" });
    }
    const write = async (directory: FixtureDirectory): Promise<string> => {
      const entries: ArtifactsTreeEntry[] = [];
      for (const [entryName, child] of directory.directories)
        entries.push({ name: entryName, mode: "40000", hash: await write(child), type: "tree" });
      for (const [entryName, file] of directory.files)
        entries.push({
          name: entryName,
          mode: file.mode,
          hash: file.oid,
          type: file.mode === "120000" ? "symlink" : file.mode === "100755" ? "exec" : "blob",
        });
      const hash = await gitObjectId("tree", encoder.encode(JSON.stringify(entries)));
      repository.trees.set(hash, entries);
      return hash;
    };
    const treeHash = await write(root);
    const commit = { ...repository.commits[0], hash: `${treeHash.slice(0, 39)}c`, treeHash };
    repository.commits.splice(0, repository.commits.length, commit);
    return commit.hash;
  }

  snapshot(name: string): ArtifactsFixtureSnapshot {
    const repository = this.repositories.get(name);
    if (!repository) throw new Error(`Artifact repo not found: ${name}`);
    return {
      info: { ...repository.info },
      tokens: [...repository.tokens.values()].map(tokenInfo),
    };
  }

  private handle(repository: FixtureRepository): ArtifactsRepo {
    const fixture = this;
    return {
      [Symbol.dispose]() {},
      async createToken(scope = "write", ttlSeconds = 86_400) {
        if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 31_536_000)
          throw new Error("Invalid fixture token TTL.");
        return createToken(repository, scope, ttlSeconds);
      },
      async listTokens() {
        const tokens = [...repository.tokens.values()].map(tokenInfo);
        return { tokens, total: tokens.length };
      },
      async revokeToken(tokenOrId) {
        const token = [...repository.tokens.values()].find(
          (candidate) => candidate.id === tokenOrId || candidate.plaintext === tokenOrId
        );
        if (!token || token.state === "revoked") return false;
        token.state = "revoked";
        return true;
      },
      async info() {
        return { ...repository.info };
      },
      async readBlob(hash) {
        const bytes = repository.blobs.get(hash);
        return bytes ? new Blob([bytes as BlobPart]) : null;
      },
      async readTree(hash) {
        return repository.trees.get(hash) ?? (hash === baseCommit.treeHash ? [] : null);
      },
      async readCommit(oid) {
        return repository.commits.find((commit) => commit.hash === oid) ?? null;
      },
      async readFile() {
        return null;
      },
      async log(options) {
        return [...(repository.branchCommits.get(options?.ref ?? "") ?? repository.commits)];
      },
      async fork(name, options = {}) {
        if (fixture.repositories.has(name))
          throw new Error(`Artifact repo already exists: ${name}`);
        const { repository: forked, created } = createRepository(
          name,
          {
            description: options.description,
            defaultBranch: repository.info.defaultBranch,
            readOnly: options.readOnly,
          },
          `artifacts:${repository.info.name}`,
          repository.commits[0] ?? baseCommit
        );
        fixture.repositories.set(name, forked);
        return created;
      },
    } satisfies ArtifactsRepo;
  }
}
