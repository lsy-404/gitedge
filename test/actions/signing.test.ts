import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import {
  createSigningExecutionHooks,
  handleSigningRoute,
  reconcileSigningRequests,
  SigningCoordinator,
} from "../../workers/actions/src/signing";
import {
  installSigningCredentials,
  listApprovedProfiles,
  saveApprovedProfile,
  signingCredentialStatus,
} from "../../workers/actions/src/signing/services";
import type { SigningExecutionHooks, SigningEnv } from "../../workers/actions/src/signing/types";
import type { TrustedUser } from "../../packages/contracts/src/index";
import { SigningProfileSchema } from "../../packages/contracts/src/signing";

const owner: TrustedUser = { id: "owner-1", identifier: "owner", groupKey: "free" };
const submission = {
  profile: "desktop-release",
  platform: "windows" as const,
  sourceRepositoryId: "1234",
  sourceCommitOid: "a".repeat(40),
  sourceRunId: "1234",
  sourceArtifactId: "9",
  sourceDigest: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  sourceSize: 3,
  version: "1.2.3",
};
const profile = {
  name: "desktop-release",
  revision: "c".repeat(40),
  policyDigest: "sha256:" + "f".repeat(64),
  workflowOid: "d".repeat(40),
  workflowPath: ".github/workflows/desktop-release.yml",
  workflowSource: "runner",
  platform: "windows" as const,
  timeoutMinutes: 30,
  enabled: true,
  policy: {
    stage: "windows_sign",
    windowsIdentity: "azure-managed-identity",
    azure: {
      endpoint: "https://example.codesigning.azure.net/",
      account: "acct",
      certificate_profile: "profile",
      subject: "subject",
    },
    project: {
      id: "desktop",
      enabled: true,
      max_artifact_bytes: 1_000_000,
      windows: {
        bundle_id: "com.example.app",
        architecture: "x64",
        max_unpacked_bytes: 2_000_000,
        product_name: "Desktop",
        electron_version: "1.2.3",
        executable_name: "Desktop.exe",
        installer: "nsis",
        portable: false,
      },
    },
    sourceRepositories: [
      {
        id: "1234",
        fullName: "owner/source",
        workflowPath: ".github/workflows/build.yml",
        artifactName: "unsigned",
        actorIds: [123],
        events: ["workflow_dispatch"],
        refs: ["main"],
      },
    ],
  },
};

class TestDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    const chunks: Uint8Array[] = [];
    let resolveDigest!: (value: ArrayBuffer) => void;
    let rejectDigest!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk) {
        chunks.push(chunk);
      },
      async close() {
        const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          resolveDigest(await crypto.subtle.digest(algorithm, bytes));
        } catch (error) {
          rejectDigest(error);
        }
      },
    });
    this.digest = digest;
  }
}

class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedLength: number) {
    let length = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        length += chunk.byteLength;
        if (length > expectedLength) throw new RangeError("fixed_length_stream_overflow");
        controller.enqueue(chunk);
      },
      flush() {
        if (length !== expectedLength) throw new RangeError("fixed_length_stream_underflow");
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
}

Object.defineProperty(crypto, "DigestStream", { value: TestDigestStream });
Object.defineProperty(globalThis, "FixedLengthStream", { value: TestFixedLengthStream });

function environment() {
  let created = false;
  let enqueued: unknown;
  let bound: unknown;
  let storedSource: Uint8Array | null = null;
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/create") {
        created = true;
        return Response.json({
          created: true,
          request: {
            id: "11111111-1111-4111-8111-111111111111",
            repositoryId: "runner-repo",
            ownerId: "owner-1",
            profile: "desktop-release",
            profileRevision: "c".repeat(40),
            platform: "windows",
            stage: "windows_sign",
            runId: null,
            state: "accepted",
            sourceDigest: submission.sourceDigest,
            sourceSize: 3,
            outputDigest: null,
            outputSize: null,
            createdAt: 1,
            expiresAt: 518400001,
            completedAt: null,
          },
          dispatch: {
            profile,
            submission,
            generation: 1,
            nonce: "A".repeat(43),
            operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 1 },
          },
        });
      }
      if (new URL(request.url).pathname.startsWith("/bind-run/")) {
        bound = await request.json();
        return Response.json({ bound: true });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }),
  };
  const env = {
    DB: {
      prepare() {
        return {
          bind: () => ({ first: async () => ({ id: "runner-repo", namespace_id: "ns-1" }) }),
        };
      },
    },
    SIGNING_COORDINATORS: { getByName: () => stub },
    SIGNING_ARTIFACTS: {
      head: async () => (storedSource ? { size: storedSource.byteLength } : null),
      put: async (_key: string, body: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        const reader = body.getReader();
        for (;;) {
          const value = await reader.read();
          if (value.done) break;
          chunks.push(value.value);
        }
        storedSource = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0;
        for (const chunk of chunks) {
          storedSource.set(chunk, offset);
          offset += chunk.byteLength;
        }
      },
      get: async () =>
        storedSource
          ? { size: storedSource.byteLength, body: new Response(storedSource).body }
          : null,
      delete: async () => {
        storedSource = null;
      },
    },
  } as unknown as SigningEnv;
  return {
    env,
    stub,
    state: () => ({ created, enqueued, bound }),
    hooks(approved: boolean): SigningExecutionHooks {
      return {
        loadApprovedProfile: vi.fn(async () => profile),
        verifySource: vi.fn(async () => ({ body: new Response("abc").body! })),
        verifySourceCurrent: vi.fn(async () => true),
        verifySigningHost: vi.fn(async () =>
          approved
            ? { operatorApproved: true as const, approvedBy: owner.id, approvedAt: Date.now() }
            : null
        ),
        verifyNotarization: vi.fn(async () => "Accepted" as const),
        enqueue: vi.fn(async (input) => {
          enqueued = input;
          return { runId: "22222222-2222-4222-8222-222222222222" };
        }),
        verifyOutput: vi.fn(async () => false),
      };
    },
  };
}

function request() {
  return new Request("https://actions.test/signing/requests", {
    method: "POST",
    headers: { "Idempotency-Key": "release-2026-10-21-00001", "Content-Type": "application/json" },
    body: JSON.stringify(submission),
  });
}

describe("native signing admission", () => {
  it("fails closed before persistence or queueing when no owner-approved host is available", async () => {
    const test = environment();
    const response = await handleSigningRoute(request(), test.env, owner, test.hooks(false));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "signing_host_unverified" } });
    expect(test.state()).toMatchObject({ created: false, enqueued: undefined, bound: undefined });
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });

  it("creates and binds an immutable approved profile to the native run when admission succeeds", async () => {
    const test = environment();
    const hooks = test.hooks(true);
    const response = await handleSigningRoute(request(), test.env, owner, hooks);

    expect(response.status, await response.clone().text()).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        request: {
          ownerId: "owner-1",
          repositoryId: "runner-repo",
          state: "queued",
          runId: "22222222-2222-4222-8222-222222222222",
        },
      },
    });
    expect(hooks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        repositoryId: "runner-repo",
        workflowOid: "d".repeat(40),
        profileRevision: "c".repeat(40),
        sourceDigest: submission.sourceDigest,
      })
    );
    expect(test.state().bound).toMatchObject({
      ownerId: "owner-1",
      repositoryId: "runner-repo",
      runId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("allows a queue job or repository-scoped write token to submit only for its bound Runner repository", async () => {
    const jobTest = environment();
    const jobResponse = await handleSigningRoute(
      request(),
      jobTest.env,
      {
        ...owner,
        token: { id: "job-token", scopes: ["repo:write"], repositoryIds: ["runner-repo"] },
        job: { runId: "job-run", repositoryId: "runner-repo", commitOid: "a".repeat(40) },
      } as TrustedUser,
      jobTest.hooks(true)
    );
    expect(jobResponse.status).toBe(202);

    const tokenTest = environment();
    const tokenRequest = new Request(
      "https://actions.test/signing/requests?repositoryId=runner-repo",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "release-2026-10-21-00001",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(submission),
      }
    );
    const tokenResponse = await handleSigningRoute(
      tokenRequest,
      tokenTest.env,
      {
        ...owner,
        token: { id: "token-1", scopes: ["repo:write"], repositoryIds: ["runner-repo"] },
      } as TrustedUser,
      tokenTest.hooks(true)
    );
    expect(tokenResponse.status).toBe(202);

    const denied = environment();
    const deniedRequest = new Request(
      "https://actions.test/signing/requests?repositoryId=another-repo",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "release-2026-10-21-00001",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(submission),
      }
    );
    const deniedResponse = await handleSigningRoute(
      deniedRequest,
      denied.env,
      {
        ...owner,
        token: { id: "token-2", scopes: ["repo:write"], repositoryIds: ["another-repo"] },
      } as TrustedUser,
      denied.hooks(true)
    );
    expect(deniedResponse.status).toBe(503);
    expect(denied.stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects job and agent identities before reading or changing signing state", async () => {
    const test = environment();
    const hooks = test.hooks(true);
    const response = await handleSigningRoute(
      request(),
      test.env,
      {
        ...owner,
        job: { runId: "r", repositoryId: "different-repo", commitOid: "a".repeat(40) },
      } as TrustedUser,
      hooks
    );

    expect(response.status).toBe(503);
    expect(hooks.loadApprovedProfile).not.toHaveBeenCalled();
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });

  it("requires a recent human session to approve profiles", async () => {
    const test = environment();
    const response = await handleSigningRoute(
      new Request("https://actions.test/signing/profiles?repositoryId=runner-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "desktop-release" }),
      }),
      test.env,
      {
        ...owner,
        job: { runId: "r", repositoryId: "runner-repo", commitOid: "a".repeat(40) },
      } as TrustedUser,
      test.hooks(true)
    );

    expect(response.status).toBe(403);
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });

  it("isolates encrypted GitHub source credentials by owner, Runner repository, and profile revision", async () => {
    const digest = async (value: unknown) =>
      `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const approvedProfile = {
      ...profile,
      policyDigest: await digest(profile.policy),
      revision: "0".repeat(40),
    };
    const { revision: _oldRevision, ...immutableProfile } = approvedProfile;
    approvedProfile.revision = (await digest(immutableProfile)).slice(7, 47);
    const repositories = ["runner-one", "runner-two"];
    const profiles = new Map(
      repositories.map((repositoryId, index) => [
        `owner-${index + 1}:${repositoryId}`,
        {
          profile_json: JSON.stringify(approvedProfile),
          approved_by: `owner-${index + 1}`,
          approved_at: 1,
        },
      ])
    );
    const sourceCredentials = new Map<string, { ciphertext: string }>();
    const env = {
      SIGNING_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      DB: {
        prepare: (query: string) => ({
          bind: (...values: string[]) => ({
            first: async () =>
              query.includes("SELECT profile_json")
                ? (profiles.get(`${values[0]}:${values[1]}`) ?? null)
                : (sourceCredentials.get(`${values[0]}:${values[1]}:${values[2]}`) ?? null),
            run: async () => {
              if (query.startsWith("INSERT INTO actions_signing_source_credentials"))
                sourceCredentials.set(`${values[0]}:${values[1]}:${values[2]}`, {
                  ciphertext: values[3]!,
                });
              return {};
            },
          }),
        }),
      },
    } as unknown as SigningEnv;
    await installSigningCredentials(
      env,
      "owner-1",
      "runner-one",
      approvedProfile.name,
      "github-source",
      { token: "source-token-one" }
    );
    await installSigningCredentials(
      env,
      "owner-2",
      "runner-two",
      approvedProfile.name,
      "github-source",
      { token: "source-token-two" }
    );
    expect(
      [...sourceCredentials.values()].every((row) => !row.ciphertext.includes("source-token"))
    ).toBe(true);
    const sourceSubmission = { ...submission, sourceRunId: "123", sourceArtifactId: "456" };

    const authorizations: string[] = [];
    const githubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "api.github.com")
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (url.pathname === "/repos/owner/source") return Response.json({ default_branch: "main" });
      if (url.pathname.includes("/actions/runs/"))
        return Response.json({
          repository: { id: 1234 },
          head_sha: submission.sourceCommitOid,
          status: "in_progress",
          conclusion: null,
          path: ".github/workflows/build.yml@refs/heads/main",
          event: "workflow_dispatch",
          head_branch: "main",
          actor: { id: 123 },
        });
      if (url.pathname.includes("/actions/artifacts/") && url.pathname.endsWith("/zip"))
        return new Response(null, {
          status: 302,
          headers: { Location: "https://productionresultssa1.blob.core.windows.net/archive" },
        });
      if (url.pathname.includes("/actions/artifacts/"))
        return Response.json({
          name: "unsigned",
          expired: false,
          size_in_bytes: 3,
          workflow_run: { id: 123, head_sha: submission.sourceCommitOid },
        });
      return new Response("abc");
    });
    vi.stubGlobal("fetch", githubFetch);
    try {
      const hooks = createSigningExecutionHooks(env, {
        enqueue: vi.fn(async () => ({ runId: "22222222-2222-4222-8222-222222222222" })),
        verifySigningHost: vi.fn(async () => null),
      });
      const tokenUser = { ...owner };
      const first = await hooks.verifySource(
        tokenUser,
        "runner-one",
        approvedProfile,
        sourceSubmission
      );
      await first?.body.cancel();
      const second = await hooks.verifySource(
        { ...owner, id: "owner-2" },
        "runner-two",
        approvedProfile,
        sourceSubmission
      );
      await second?.body.cancel();
      const crossAccount = await hooks.verifySource(
        tokenUser,
        "runner-two",
        approvedProfile,
        sourceSubmission
      );
      expect(crossAccount).toBeNull();
      expect(authorizations).toEqual([
        "Bearer source-token-one",
        "Bearer source-token-one",
        "Bearer source-token-two",
        "Bearer source-token-two",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires a matching GitHub OIDC identity and a reachable version tag for release sources", async () => {
    const credentials = new Map<string, { ciphertext: string }>();
    const approvedProfileBase = {
      ...profile,
      policy: {
        ...profile.policy,
        sourceRepositories: [
          {
            ...profile.policy.sourceRepositories[0],
            events: ["push"],
            releaseTagPattern: "^v\\d+\\.\\d+\\.\\d+$",
          },
        ],
      },
    };
    const sha256 = async (value: unknown) =>
      `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const parsedProfile = SigningProfileSchema.parse(approvedProfileBase);
    const policyDigest = await sha256(parsedProfile.policy);
    const approvedWithoutRevision = SigningProfileSchema.parse({ ...parsedProfile, policyDigest });
    const { revision: _previousRevision, ...immutableProfile } = approvedWithoutRevision;
    const revision = (await sha256(immutableProfile)).slice(7, 47);
    const approvedProfile = SigningProfileSchema.parse({ ...approvedWithoutRevision, revision });
    const profiles = new Map([
      [
        `${owner.id}:runner-repo`,
        { profile_json: JSON.stringify(approvedProfile), approved_by: owner.id, approved_at: 1 },
      ],
    ]);
    const env = {
      SIGNING_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      DB: {
        prepare: (query: string) => ({
          bind: (...values: string[]) => ({
            first: async () =>
              query.includes("SELECT profile_json")
                ? (profiles.get(`${values[0]}:${values[1]}`) ?? null)
                : (credentials.get(`${values[0]}:${values[1]}:${values[2]}`) ?? null),
            run: async () => {
              if (query.startsWith("INSERT INTO actions_signing_source_credentials"))
                credentials.set(`${values[0]}:${values[1]}:${values[2]}`, {
                  ciphertext: values[3]!,
                });
              return {};
            },
          }),
        }),
      },
    } as unknown as SigningEnv;
    await installSigningCredentials(env, owner.id, "runner-repo", profile.name, "github-source", {
      token: "release-source-token",
    });
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
    const claims = {
      repository_id: "1234",
      run_id: "1234",
      run_attempt: "1",
      actor_id: "123",
      ref: "refs/tags/v1.2.3",
      event_name: "push",
      workflow_ref: "owner/source/.github/workflows/build.yml@refs/tags/v1.2.3",
      workflow_sha: submission.sourceCommitOid,
    };
    const mintIdentity = (runAttempt: string) =>
      new SignJWT({ ...claims, run_attempt: runAttempt })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://token.actions.githubusercontent.com")
        .setAudience("https://actions.test")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const githubFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/.well-known/jwks")
        return Response.json({
          keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
        });
      if (url.pathname === "/repos/owner/source") return Response.json({ default_branch: "main" });
      if (url.pathname.endsWith("/actions/runs/1234"))
        return Response.json({
          repository: { id: 1234 },
          head_sha: submission.sourceCommitOid,
          status: "in_progress",
          conclusion: null,
          path: ".github/workflows/build.yml@refs/tags/v1.2.3",
          event: "push",
          head_branch: "v1.2.3",
          actor: { id: 123 },
        });
      if (url.pathname.endsWith("/git/ref/tags/v1.2.3"))
        return Response.json({ object: { type: "commit", sha: submission.sourceCommitOid } });
      if (url.pathname.includes("/compare/"))
        return Response.json({ status: "behind", ahead_by: 0 });
      if (url.pathname.endsWith("/actions/artifacts/9/zip"))
        return new Response(null, {
          status: 302,
          headers: { Location: "https://productionresultssa1.blob.core.windows.net/archive" },
        });
      if (url.pathname.endsWith("/actions/artifacts/9"))
        return Response.json({
          name: "unsigned",
          expired: false,
          size_in_bytes: 3,
          workflow_run: { id: 1234, head_sha: submission.sourceCommitOid },
        });
      return new Response("abc");
    });
    vi.stubGlobal("fetch", githubFetch);
    try {
      const hooks = createSigningExecutionHooks(env, {
        enqueue: vi.fn(async () => ({ runId: "22222222-2222-4222-8222-222222222222" })),
        verifySigningHost: vi.fn(async () => null),
      });
      const validIdentity = await mintIdentity("1");
      const source = await hooks.verifySource(
        owner,
        "runner-repo",
        approvedProfile,
        submission,
        validIdentity,
        "https://actions.test"
      );
      expect(source).not.toBeNull();
      await source?.body.cancel();
      const retriedIdentity = await mintIdentity("2");
      await expect(
        hooks.verifySource(
          owner,
          "runner-repo",
          approvedProfile,
          submission,
          retriedIdentity,
          "https://actions.test"
        )
      ).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("approves Runner YAML, persists its pinned workflow snapshot, and reads the approved profile back", async () => {
    const source = `name: desktop-release\nworkflowOid: ${"d".repeat(40)}\nworkflowPath: .github/workflows/native-signing.yml\nplatform: macos\ntimeoutMinutes: 30\nenabled: true\npolicy:\n  stage: sign\n  teamId: ABCDEFGHIJ\n  project:\n    id: desktop\n    enabled: true\n    max_artifact_bytes: 1000000\n    macos:\n      bundle_id: com.example.app\n      bundle_name: Example.app\n      architecture: arm64\n      profile: electron\n      harden_electron_fuses: false\n      output_format: dmg\n      max_unpacked_bytes: 2000000\n  sourceRepositories:\n    - id: '1234'\n      fullName: owner/source\n      workflowPath: .github/workflows/build.yml\n      artifactName: unsigned\n      actorIds: [123]\n      events: [workflow_dispatch]\n      refs: [main]\n`;
    const workflow = `name: Native signing\non:\n  workflow_dispatch:\njobs:\n  sign:\n    runs-on: [self-hosted, need-tool-node, need-time-5m]\n    steps:\n      - run: echo signing\n`;
    let stored: {
      profile_json: string;
      approved_by: string;
      approved_at: number;
      revision: string;
    } | null = null;
    const sourceCredentials = new Set<string>();
    const env = {
      SIGNING_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
      DB: {
        prepare(query: string) {
          let bound: unknown[] = [];
          return {
            bind(...values: unknown[]) {
              bound = values;
              return this;
            },
            async first() {
              if (query.includes("FROM repositories r JOIN namespaces"))
                return { id: "runner-repo", created_by: owner.id };
              if (query.includes("SELECT profile_json,approved_by,approved_at")) return stored;
              if (query.includes("SELECT ciphertext FROM actions_signing_source_credentials"))
                return sourceCredentials.has(
                  `${String(bound[0])}:${String(bound[1])}:${String(bound[2])}`
                )
                  ? { ciphertext: "encrypted" }
                  : null;
              if (query.includes("SELECT updated_at FROM actions_signing_source_credentials"))
                return sourceCredentials.has(
                  `${String(bound[0])}:${String(bound[1])}:${String(bound[2])}`
                )
                  ? { updated_at: 1 }
                  : null;
              return null;
            },
            async all() {
              return {
                results: stored
                  ? [{ profile_json: stored.profile_json, approved_at: stored.approved_at }]
                  : [],
              };
            },
            async run() {
              if (query.startsWith("INSERT INTO actions_signing_source_credentials"))
                sourceCredentials.add(
                  `${String(bound[0])}:${String(bound[1])}:${String(bound[2])}`
                );
              if (query.startsWith("DELETE FROM actions_signing_source_credentials"))
                sourceCredentials.delete(
                  `${String(bound[0])}:${String(bound[1])}:${String(bound[2])}`
                );
              return {};
            },
            query,
            values: () => bound,
          };
        },
        async batch(statements: Array<{ query: string; values: () => unknown[] }>) {
          for (const statement of statements) {
            if (statement.query.startsWith("INSERT INTO actions_signing_profiles")) {
              const values = statement.values();
              stored = {
                profile_json: String(values[4]),
                approved_by: String(values[5]),
                approved_at: Number(values[6]),
                revision: String(values[3]),
              };
            }
            if (statement.query.startsWith("DELETE FROM actions_signing_source_credentials")) {
              const values = statement.values();
              if (stored?.revision !== String(values[5]))
                sourceCredentials.delete(
                  `${String(values[0])}:${String(values[1])}:${String(values[5])}`
                );
            }
          }
          return [];
        },
      },
      GIT: {
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          const path = url.searchParams.get("path");
          if (path === ".gitedge/signing/desktop-release.yml")
            return Response.json({
              data: {
                content: source,
                oid: "e".repeat(40),
                path,
                size: source.length,
                binary: false,
              },
            });
          if (path === ".github/workflows/native-signing.yml")
            return Response.json({
              data: {
                content: workflow,
                oid: "e".repeat(40),
                path,
                size: workflow.length,
                binary: false,
              },
            });
          return Response.json({ error: "not found" }, { status: 404 });
        },
      },
    } as unknown as SigningEnv;
    const approved = await saveApprovedProfile(
      env,
      { ...owner, recentAuthAt: Date.now() },
      "runner-repo",
      "desktop-release"
    );
    await installSigningCredentials(
      env,
      owner.id,
      "runner-repo",
      "desktop-release",
      "github-source",
      { token: "keep-this-on-same-revision" }
    );
    await saveApprovedProfile(
      env,
      { ...owner, recentAuthAt: Date.now() },
      "runner-repo",
      "desktop-release"
    );
    const rows = await listApprovedProfiles(env, owner.id, "runner-repo");
    const sourceStatus = await signingCredentialStatus(
      env,
      owner.id,
      "runner-repo",
      "desktop-release",
      "github-source"
    );
    const loaded = await createSigningExecutionHooks(env, {
      enqueue: vi.fn(async () => ({ runId: "22222222-2222-4222-8222-222222222222" })),
      verifySigningHost: vi.fn(async () => null),
    }).loadApprovedProfile(owner, "runner-repo", "desktop-release");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "desktop-release",
      revision: approved.revision,
      platform: "macos",
      workflowOid: "d".repeat(40),
      workflowPath: ".github/workflows/native-signing.yml",
      enabled: true,
    });
    expect(loaded).toMatchObject({
      revision: approved.revision,
      policyDigest: approved.policyDigest,
      workflowSource: workflow,
    });
    expect(sourceCredentials.has(`${owner.id}:runner-repo:${approved.revision}`)).toBe(true);
    expect(sourceStatus).toMatchObject({ platform: "github-source", configured: true });
  });
});

describe("native signing stage reconciliation", () => {
  it("fails expired requests before returning status", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      profile_json: JSON.stringify({
        ...profile,
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify(submission),
      state: "accepted",
      current_stage: "windows_sign",
      run_id: null,
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: null,
      output_size: null,
      authorized_at: 0,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
      expires_at: 1,
    };
    const sql = {
      exec: (query: string) => {
        if (query.startsWith("PRAGMA table_info"))
          return { toArray: () => [{ name: "expires_at" }] };
        if (query.startsWith("SELECT MIN(expires_at)")) return { toArray: () => [] };
        if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
        if (query.startsWith("UPDATE signing_requests SET state='failed'")) {
          row.state = "failed";
          row.completed_at = Date.now();
          return { toArray: () => [], rowsWritten: 1 };
        }
        return { toArray: () => [], rowsWritten: 0 };
      },
    };
    const coordinator = new SigningCoordinator(
      { storage: { sql, setAlarm: vi.fn() } } as never,
      {} as SigningEnv
    );

    expect(coordinator.get(row.id, owner.id, row.repository_id)).toMatchObject({
      state: "failed",
      expiresAt: 1,
    });
  });

  it("serializes concurrent stage preparation and returns the same prepared generation", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      idempotency_key: "some-release-key-0001",
      profile_json: JSON.stringify({
        ...profile,
        platform: "macos",
        policy: {
          stage: "sign",
          teamId: "ABCDEFGHIJ",
          project: {
            id: "desktop",
            enabled: true,
            max_artifact_bytes: 1_000_000,
            macos: {
              bundle_id: "com.example.app",
              bundle_name: "Example.app",
              architecture: "arm64",
              profile: "electron",
              harden_electron_fuses: false,
              output_format: "dmg",
              max_unpacked_bytes: 2_000_000,
            },
          },
          sourceRepositories: profile.policy.sourceRepositories,
        },
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify({ ...submission, platform: "macos" }),
      state: "awaiting_source",
      current_stage: "sign",
      run_id: "22222222-2222-4222-8222-222222222222",
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: submission.sourceDigest,
      output_size: 3,
      authorized_at: 0,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
      expires_at: Date.now() + 100_000,
    };
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX"))
          return { toArray: () => [], rowsWritten: 0 };
        if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
        if (query.includes("FROM signing_stage_outputs"))
          return {
            toArray: () => [
              {
                digest: "sha256:" + "f".repeat(64),
                size: 9,
                verification_json: JSON.stringify({
                  schema_version: 1,
                  request_id: row.id,
                  generation: 1,
                  stage: "sign",
                  input_digest: submission.sourceDigest,
                  recipe_sha: "e".repeat(40),
                  policy_digest: "sha256:" + "f".repeat(64),
                  team_id: "ABCDEFGHIJ",
                  bundle_id: "com.example.app",
                  version: "1.2.3",
                  architecture: "arm64",
                  codesign_verified: true,
                  timestamp_verified: true,
                  asar_integrity_verified: true,
                  notarization_id: "44444444-4444-4444-8444-444444444444",
                  notarization_status: "Submitted",
                  notary_archive_sha256: "a".repeat(64),
                  gatekeeper_verified: false,
                  staple_verified: false,
                  files: [{ path: "signed.tar.gz", size: 9, sha256: "b".repeat(64) }],
                }),
              },
            ],
          };
        if (query.startsWith("UPDATE signing_requests SET state='accepted'")) {
          if (row.state !== "awaiting_source") return { toArray: () => [], rowsWritten: 0 };
          row.state = "accepted";
          row.current_stage = String(args[0]);
          row.run_id = null;
          row.generation += 1;
          row.nonce = String(args[1]);
          row.output_digest = null;
          row.output_size = null;
          row.authorized_at = 0;
          row.verification_json = null;
          return { toArray: () => [], rowsWritten: 1 };
        }
        return { toArray: () => [], rowsWritten: 0 };
      },
    };
    const context = { storage: { sql, transactionSync: (callback: () => unknown) => callback() } };
    const coordinator = new SigningCoordinator(context as never, {} as SigningEnv);
    const prepared = [
      coordinator.prepareNextStage(row.id, owner.id, row.repository_id, "B".repeat(43)),
      coordinator.prepareNextStage(row.id, owner.id, row.repository_id, "C".repeat(43)),
    ];

    expect(prepared[0]?.dispatch).toEqual(prepared[1]?.dispatch);
    expect(prepared[0]?.dispatch).toMatchObject({
      stage: "finalize",
      generation: 2,
      nonce: "B".repeat(43),
      inputDigest: "sha256:" + "f".repeat(64),
    });
    expect(row.state).toBe("accepted");
  });

  it("reaches all four macOS DMG stages and repeated ticks preserve the prepared stage", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      profile_json: JSON.stringify({
        ...profile,
        platform: "macos",
        policy: {
          stage: "sign",
          teamId: "ABCDEFGHIJ",
          project: {
            id: "desktop",
            enabled: true,
            max_artifact_bytes: 1_000_000,
            macos: {
              bundle_id: "com.example.app",
              bundle_name: "Example.app",
              architecture: "arm64",
              profile: "electron",
              harden_electron_fuses: false,
              output_format: "dmg",
              max_unpacked_bytes: 2_000_000,
            },
          },
          sourceRepositories: profile.policy.sourceRepositories,
        },
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify({ ...submission, platform: "macos" }),
      state: "awaiting_source",
      current_stage: "sign",
      run_id: "22222222-2222-4222-8222-222222222222",
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: submission.sourceDigest,
      output_size: 3,
      authorized_at: 0,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
      expires_at: Date.now() + 100_000,
    };
    const digests = new Map<string, { digest: string; size: number; verification_json: string }>();
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        if (
          query.startsWith("CREATE TABLE") ||
          query.startsWith("CREATE INDEX") ||
          query.startsWith("DELETE FROM")
        )
          return { toArray: () => [], rowsWritten: 0 };
        if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
        if (query.includes("FROM signing_stage_outputs")) {
          const saved = digests.get(String(args[1]));
          return { toArray: () => (saved ? [saved] : []) };
        }
        if (query.startsWith("UPDATE signing_requests SET state='accepted'")) {
          row.state = "accepted";
          row.current_stage = String(args[0]);
          row.run_id = null;
          row.generation += 1;
          row.nonce = String(args[1]);
          row.output_digest = null;
          row.output_size = null;
          row.authorized_at = 0;
          row.verification_json = null;
          return { toArray: () => [], rowsWritten: 1 };
        }
        return { toArray: () => [], rowsWritten: 0 };
      },
    };
    const coordinator = new SigningCoordinator(
      { storage: { sql, transactionSync: (callback: () => unknown) => callback() } } as never,
      {} as SigningEnv
    );
    const stages = ["finalize", "dmg_sign", "dmg_finalize"];
    let digest = submission.sourceDigest;
    let size = submission.sourceSize;
    for (const [index, next] of stages.entries()) {
      const completedStage = row.current_stage;
      const report = {
        schema_version: 1,
        request_id: row.id,
        generation: row.generation,
        stage: completedStage,
        input_digest: digest,
        recipe_sha: "d".repeat(40),
        policy_digest: "sha256:" + "f".repeat(64),
        team_id: "ABCDEFGHIJ",
        bundle_id: "com.example.app",
        version: "1.2.3",
        architecture: "arm64",
        codesign_verified: true,
        timestamp_verified: true,
        asar_integrity_verified: true,
        notarization_id: "44444444-4444-4444-8444-444444444444",
        notarization_status: "Submitted",
        notary_archive_sha256: "a".repeat(64),
        gatekeeper_verified: false,
        staple_verified: false,
        files: [
          {
            path:
              completedStage === "sign"
                ? "signed.tar.gz"
                : completedStage === "finalize"
                  ? "product.zip"
                  : "signed.dmg",
            size: 9,
            sha256: "b".repeat(64),
          },
        ],
      };
      digest = `sha256:${String(index + 1).repeat(64)}`;
      size = index + 10;
      digests.set(completedStage, { digest, size, verification_json: JSON.stringify(report) });
      row.state = "awaiting_source";
      const first = coordinator.prepareNextStage(
        row.id,
        owner.id,
        row.repository_id,
        "B".repeat(43)
      );
      const retry = coordinator.prepareNextStage(
        row.id,
        owner.id,
        row.repository_id,
        "C".repeat(43)
      );
      expect(first?.dispatch).toEqual(retry?.dispatch);
      expect(first?.dispatch).toMatchObject({ stage: next, inputDigest: digest, inputSize: size });
    }
    expect(row.current_stage).toBe("dmg_finalize");
    expect(row.generation).toBe(4);
  });

  it("records execution failure once and makes a repeated failure callback idempotent", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      profile_json: JSON.stringify({
        ...profile,
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify(submission),
      state: "running",
      current_stage: "windows_sign",
      run_id: "22222222-2222-4222-8222-222222222222",
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: null,
      output_size: null,
      authorized_at: 1,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
    };
    const sql = {
      exec: (query: string, ...args: unknown[]) => {
        if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX"))
          return { toArray: () => [], rowsWritten: 0 };
        if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
        if (query.startsWith("UPDATE signing_requests SET state='failed'")) {
          row.state = "failed";
          row.completed_at = Number(args[0]);
          row.verification_json = String(args[1]);
          return { toArray: () => [], rowsWritten: 1 };
        }
        return { toArray: () => [], rowsWritten: 0 };
      },
    };
    const coordinator = new SigningCoordinator({ storage: { sql } } as never, {} as SigningEnv);
    const context = {
      ownerId: owner.id,
      runnerId: "33333333-3333-4333-8333-333333333333",
      runId: row.run_id,
      requestId: row.id,
      leaseExpiresAt: Date.now() + 60_000,
      repositoryId: row.repository_id,
      workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40),
      platform: "windows",
      stage: "windows_sign",
      generation: 1,
      nonce: row.nonce,
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
    };

    expect(coordinator.machine(row.id, context, "fail", { code: "signing_tool_failed" })).toEqual({
      state: "failed",
    });
    expect(coordinator.machine(row.id, context, "fail", { code: "signing_tool_failed" })).toEqual({
      state: "failed",
    });
    expect(row.state).toBe("failed");
  });

  it("allows a queued signing lease to read its profile before the first start callback", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      profile_json: JSON.stringify({
        ...profile,
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify(submission),
      state: "queued",
      current_stage: "windows_sign",
      run_id: "22222222-2222-4222-8222-222222222222",
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: null,
      output_size: null,
      authorized_at: 0,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
    };
    const sql = {
      exec: (query: string) =>
        query.startsWith("SELECT * FROM signing_requests")
          ? { toArray: () => [row] }
          : { toArray: () => [] },
    };
    const coordinator = new SigningCoordinator({ storage: { sql } } as never, {} as SigningEnv);
    const context = {
      ownerId: owner.id,
      runnerId: "33333333-3333-4333-8333-333333333333",
      runId: row.run_id,
      requestId: row.id,
      leaseExpiresAt: Date.now() + 60_000,
      repositoryId: row.repository_id,
      workflowOid: profile.workflowOid,
      profileRevision: profile.revision,
      platform: "windows",
      stage: "windows_sign",
      generation: 1,
      nonce: row.nonce,
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
    };

    expect(coordinator.machine(row.id, context, "profile")).toMatchObject({
      profile: { revision: profile.revision },
      sourceDigest: submission.sourceDigest,
      sourceCommitOid: submission.sourceCommitOid,
      version: submission.version,
    });
    expect(row.state).toBe("queued");
  });

  it("returns the stored multipart completion plan without accessing R2 from the coordinator", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      repository_id: "runner-repo",
      owner_id: owner.id,
      profile_json: JSON.stringify({
        ...profile,
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      }),
      submission_json: JSON.stringify(submission),
      state: "running",
      current_stage: "windows_sign",
      run_id: "22222222-2222-4222-8222-222222222222",
      source_digest: submission.sourceDigest,
      source_size: 3,
      output_digest: null,
      output_size: null,
      authorized_at: 1,
      verification_json: null,
      generation: 1,
      nonce: "A".repeat(43),
      created_at: 1,
      completed_at: null,
    };
    const upload = {
      request_id: row.id,
      upload_id: "upload-1",
      digest: submission.sourceDigest,
      size: 3,
      part_size: 8 * 1024 * 1024,
      part_count: 1,
      verified: 0,
    };
    let getCount = 0;
    const artifact = {
      get: vi.fn(async () => {
        getCount++;
        if (getCount === 2) throw new Error("temporary R2 read failure");
        if (getCount === 1) return null;
        return { size: 3, body: new Response("abc").body! };
      }),
      resumeMultipartUpload: vi.fn(() => ({ complete: vi.fn(async () => undefined) })),
      delete: vi.fn(async () => undefined),
    };
    const sql = {
      exec: (query: string) => {
        if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX"))
          return { toArray: () => [], rowsWritten: 0 };
        if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
        if (query.includes("FROM signing_uploads")) return { toArray: () => [upload] };
        if (query.includes("FROM signing_upload_parts"))
          return { toArray: () => [{ part: 1, etag: "etag-1", size: 3 }] };
        if (query.startsWith("UPDATE signing_uploads SET verified=1")) {
          upload.verified = 1;
          return { toArray: () => [], rowsWritten: 1 };
        }
        return { toArray: () => [], rowsWritten: 0 };
      },
    };
    const coordinator = new SigningCoordinator(
      { storage: { sql } } as never,
      { SIGNING_ARTIFACTS: artifact } as unknown as SigningEnv
    );
    const context = {
      ownerId: owner.id,
      runnerId: "33333333-3333-4333-8333-333333333333",
      runId: row.run_id,
      requestId: row.id,
      leaseExpiresAt: Date.now() + 60_000,
      repositoryId: row.repository_id,
      workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40),
      platform: "windows",
      stage: "windows_sign",
      generation: 1,
      nonce: row.nonce,
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
    };

    expect(coordinator.outputCompletionPlan(row.id, context)).toEqual({
      key: `signing/${owner.id}/${row.repository_id}/${row.id}/windows_sign.zip`,
      uploadId: "upload-1",
      digest: submission.sourceDigest,
      size: 3,
      verified: false,
      parts: [{ partNumber: 1, etag: "etag-1" }],
    });
    expect(artifact.resumeMultipartUpload).not.toHaveBeenCalled();
    expect(artifact.get).not.toHaveBeenCalled();
  });

  it("advances an approved request once and enqueues the next stage with the prior output digest", async () => {
    const queued: unknown[] = [];
    const calls: string[] = [];
    const attempts: unknown[] = [];
    let preparePayload: unknown;
    let failBindOnce = true;
    let boundRunId: string | null = null;
    let bindPayload: unknown;
    const nextDispatch = {
      profile: {
        ...profile,
        platform: "macos",
        workflowOid: "e".repeat(40),
        policy: {
          stage: "sign",
          teamId: "ABCDEFGHIJ",
          project: {
            id: "desktop",
            enabled: true,
            max_artifact_bytes: 1_000_000,
            macos: {
              bundle_id: "com.example.app",
              bundle_name: "Example.app",
              architecture: "arm64",
              profile: "electron",
              harden_electron_fuses: false,
              output_format: "dmg",
              max_unpacked_bytes: 2_000_000,
            },
          },
          sourceRepositories: profile.policy.sourceRepositories,
        },
      },
      submission: { ...submission, platform: "macos" },
      generation: 2,
      nonce: "B".repeat(43),
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
      stage: "finalize",
      inputDigest: "sha256:" + "f".repeat(64),
      inputSize: 12,
      previousVerification: {
        schema_version: 1,
        request_id: "11111111-1111-4111-8111-111111111111",
        generation: 1,
        stage: "sign",
        input_digest: submission.sourceDigest,
        recipe_sha: "e".repeat(40),
        policy_digest: "sha256:" + "f".repeat(64),
        team_id: "ABCDEFGHIJ",
        bundle_id: "com.example.app",
        version: "1.2.3",
        architecture: "arm64",
        codesign_verified: true,
        timestamp_verified: true,
        asar_integrity_verified: true,
        notarization_id: "44444444-4444-4444-8444-444444444444",
        notarization_status: "Submitted",
        notary_archive_sha256: "a".repeat(64),
        gatekeeper_verified: false,
        staple_verified: false,
        files: [{ path: "signed.tar.gz", size: 9, sha256: "b".repeat(64) }],
      },
    };
    const stub = {
      fetch: vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path.startsWith("/prepare-next-stage/")) {
          preparePayload = await request.json();
          return Response.json({
            data: {
              request: {
                id: "11111111-1111-4111-8111-111111111111",
                ownerId: owner.id,
                repositoryId: "runner-repo",
                profile: "desktop-release",
                profileRevision: "c".repeat(40),
                platform: "macos",
                stage: "finalize",
                runId: null,
                state: "accepted",
                sourceDigest: submission.sourceDigest,
                sourceSize: 3,
                outputDigest: null,
                outputSize: null,
                createdAt: 1,
                expiresAt: 518400001,
                completedAt: null,
              },
              dispatch: nextDispatch,
            },
          });
        }
        if (path.startsWith("/bind-run/")) {
          const body = await request.json();
          bindPayload = body;
          const runId =
            typeof body === "object" &&
            body !== null &&
            "runId" in body &&
            typeof body.runId === "string"
              ? body.runId
              : "";
          if (failBindOnce) {
            failBindOnce = false;
            boundRunId = runId;
            throw new Error("bind response lost after commit");
          }
          if (boundRunId !== runId) return Response.json({ bound: false });
          return Response.json({ bound: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      }),
    };
    const env = {
      DB: {
        prepare: (sql: string) => ({
          all: async () => ({
            results: [
              {
                requestId: "11111111-1111-4111-8111-111111111111",
                ownerId: owner.id,
                repositoryId: "runner-repo",
                profileRevision: "c".repeat(40),
                platform: "macos",
              },
              {
                requestId: "11111111-1111-4111-8111-111111111111",
                ownerId: owner.id,
                repositoryId: "runner-repo",
                profileRevision: "c".repeat(40),
                platform: "macos",
              },
            ],
          }),
          bind: () => ({
            first: async () => ({ active: 1 }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
      },
      SIGNING_COORDINATORS: { getByName: () => stub },
    } as unknown as SigningEnv;
    const hooks = {
      verifySigningHost: vi.fn(async () => ({
        operatorApproved: true as const,
        approvedBy: owner.id,
        approvedAt: 10,
      })),
      verifySourceCurrent: vi.fn(async () => true),
      verifyNotarization: vi.fn(async () => "Accepted" as const),
      enqueue: vi.fn(async (input) => {
        attempts.push(input);
        if (!queued.length) queued.push(input);
        return { runId: "22222222-2222-4222-8222-222222222222" };
      }),
    } as unknown as SigningExecutionHooks;

    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({
      queued: 0,
      skipped: 0,
      failed: 1,
    });
    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({
      queued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(queued).toHaveLength(1);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(queued[0]).toMatchObject({
      stage: "finalize",
      inputDigest: "sha256:" + "f".repeat(64),
      generation: 2,
    });
    expect(calls.filter((path) => path.startsWith("/prepare-next-stage/"))).toHaveLength(2);
    expect(preparePayload).toEqual({
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      ownerId: owner.id,
      repositoryId: "runner-repo",
    });
    expect(bindPayload).toEqual({
      ownerId: owner.id,
      repositoryId: "runner-repo",
      runId: "22222222-2222-4222-8222-222222222222",
    });
    expect(calls.some((path) => path.startsWith("/bind-run/"))).toBe(true);
  });

  it("waits for notarization acceptance before enqueueing a finalize stage", async () => {
    const notaryReport = {
      schema_version: 1,
      request_id: "11111111-1111-4111-8111-111111111111",
      generation: 1,
      stage: "sign",
      input_digest: submission.sourceDigest,
      recipe_sha: "d".repeat(40),
      policy_digest: "sha256:" + "f".repeat(64),
      team_id: "ABCDEFGHIJ",
      bundle_id: "com.example.app",
      version: "1.2.3",
      architecture: "arm64",
      codesign_verified: true,
      timestamp_verified: true,
      asar_integrity_verified: true,
      notarization_id: "44444444-4444-4444-8444-444444444444",
      notarization_status: "Submitted",
      notary_archive_sha256: "a".repeat(64),
      gatekeeper_verified: false,
      staple_verified: false,
      files: [{ path: "signed.tar.gz", size: 9, sha256: "b".repeat(64) }],
    };
    const dispatch = {
      profile: {
        ...profile,
        platform: "macos",
        policy: {
          stage: "sign",
          teamId: "ABCDEFGHIJ",
          project: {
            id: "desktop",
            enabled: true,
            max_artifact_bytes: 1_000_000,
            macos: {
              bundle_id: "com.example.app",
              bundle_name: "Example.app",
              architecture: "arm64",
              profile: "electron",
              harden_electron_fuses: false,
              output_format: "dmg",
              max_unpacked_bytes: 2_000_000,
            },
          },
          sourceRepositories: profile.policy.sourceRepositories,
        },
      },
      submission: { ...submission, platform: "macos" },
      generation: 2,
      nonce: "B".repeat(43),
      operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 },
      stage: "finalize",
      inputDigest: "sha256:" + "f".repeat(64),
      inputSize: 9,
      previousVerification: notaryReport,
    };
    const stub = {
      fetch: vi.fn(async (request: Request) =>
        new URL(request.url).pathname.startsWith("/prepare-next-stage/")
          ? Response.json({
              data: {
                request: {
                  id: "11111111-1111-4111-8111-111111111111",
                  ownerId: owner.id,
                  repositoryId: "runner-repo",
                  profile: "desktop-release",
                  profileRevision: profile.revision,
                  platform: "macos",
                  stage: "finalize",
                  runId: null,
                  state: "accepted",
                  sourceDigest: submission.sourceDigest,
                  sourceSize: 3,
                  outputDigest: null,
                  outputSize: null,
                  createdAt: 1,
                  expiresAt: 518400001,
                  completedAt: null,
                },
                dispatch,
              },
            })
          : Response.json({ bound: true })
      ),
    };
    const env = {
      DB: {
        prepare: () => ({
          all: async () => ({
            results: [
              {
                requestId: "11111111-1111-4111-8111-111111111111",
                ownerId: owner.id,
                repositoryId: "runner-repo",
                profileRevision: profile.revision,
                platform: "macos",
              },
            ],
          }),
          bind: () => ({
            first: async () => ({ active: 1 }),
            run: async () => ({ meta: { changes: 1 } }),
          }),
        }),
      },
      SIGNING_COORDINATORS: { getByName: () => stub },
    } as unknown as SigningEnv;
    let notarization: "Accepted" | "In Progress" = "In Progress";
    const enqueue = vi.fn(async () => ({ runId: "22222222-2222-4222-8222-222222222222" }));
    const hooks = {
      verifySigningHost: vi.fn(async () => ({
        operatorApproved: true as const,
        approvedBy: owner.id,
        approvedAt: 10,
      })),
      verifySourceCurrent: vi.fn(async () => true),
      verifyNotarization: vi.fn(async () => notarization),
      enqueue,
    } as unknown as SigningExecutionHooks;

    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({
      queued: 0,
      skipped: 1,
      failed: 0,
    });
    expect(enqueue).not.toHaveBeenCalled();
    notarization = "Accepted";
    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({
      queued: 1,
      skipped: 0,
      failed: 0,
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("only scans current nonterminal signing stages so old completed runs do not occupy the reconciliation window", async () => {
    const queries: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          queries.push(sql);
          return { all: async () => ({ results: [] }) };
        },
      },
      SIGNING_COORDINATORS: {
        getByName: () => ({ fetch: async () => Response.json({ data: null }) }),
      },
    } as unknown as SigningEnv;
    const hooks = {
      verifySigningHost: vi.fn(),
      enqueue: vi.fn(),
    } as unknown as SigningExecutionHooks;

    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({
      queued: 0,
      skipped: 0,
      failed: 0,
    });
    const query = queries.join("\n");
    expect(query).toContain("s.stage='sign' AND r.status='completed' AND r.conclusion='success'");
    expect(query).toContain("s.stage='finalize' AND (r.status IN ('queued','running')");
    expect(query).toContain(
      "newer.generation>s.generation OR (newer.generation=s.generation AND newer.created_at>s.created_at)"
    );
    expect(query).toContain("ORDER BY COALESCE(s.last_reconciled_at,0),s.created_at DESC LIMIT 20");
  });

  it("rejects a signing callback with an expired runner lease before contacting coordinator state", async () => {
    const test = environment();
    const { handleSigningMachineRoute } = await import("../../workers/actions/src/signing");
    const context = {
      ownerId: owner.id,
      runnerId: "33333333-3333-4333-8333-333333333333",
      runId: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111",
      leaseExpiresAt: Date.now() - 1,
      repositoryId: "runner-repo",
      workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40),
      platform: "windows",
      stage: "windows_sign",
      generation: 1,
      nonce: "A".repeat(43),
      operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 1 },
    };
    const response = await handleSigningMachineRoute(
      new Request(
        "https://actions.test/runner/signing/requests/11111111-1111-4111-8111-111111111111/start",
        { method: "POST" }
      ),
      test.env,
      context,
      test.hooks(true)
    );
    expect(response.status).toBe(403);
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });
});
