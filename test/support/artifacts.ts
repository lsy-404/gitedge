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
      async readBlob() {
        return null;
      },
      async readTree() {
        return [];
      },
      async readCommit(oid) {
        return repository.commits.find((commit) => commit.hash === oid) ?? null;
      },
      async readFile() {
        return null;
      },
      async log() {
        return [...repository.commits];
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
