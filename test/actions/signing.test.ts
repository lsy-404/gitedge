import { describe, expect, it, vi } from "vitest";
import { handleSigningRoute } from "../../workers/actions/src/signing";
import type { SigningExecutionHooks, SigningEnv } from "../../workers/actions/src/signing/types";
import type { TrustedUser } from "../../packages/contracts/src/index";

const owner: TrustedUser = { id: "owner-1", identifier: "owner", groupKey: "free" };
const submission = {
  profile: "desktop-release",
  platform: "windows" as const,
  sourceRepositoryId: "source-repo",
  sourceCommitOid: "a".repeat(40),
  sourceRunId: "run-123",
  sourceArtifactId: "artifact-9",
  sourceDigest: "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  sourceSize: 3,
  version: "1.2.3",
};
const profile = {
  name: "desktop-release",
  revision: "c".repeat(40),
  workflowOid: "d".repeat(40),
  workflowPath: ".gitedge/signing/desktop-release.yml",
  workflowSource: "runner",
  platform: "windows" as const,
  timeoutMinutes: 30,
  enabled: true,
  policy: { stage: "windows_sign" },
};

const cryptoWithDigest = crypto as unknown as {
  DigestStream?: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
};
if (!cryptoWithDigest.DigestStream) {
  cryptoWithDigest.DigestStream = class extends WritableStream<Uint8Array> {
    readonly digest: Promise<ArrayBuffer>;
    constructor(algorithm: string) {
      const chunks: Uint8Array[] = [];
      let resolveDigest!: (value: ArrayBuffer) => void;
      let rejectDigest!: (reason: unknown) => void;
      const digest = new Promise<ArrayBuffer>((resolve, reject) => { resolveDigest = resolve; rejectDigest = reject; });
      super({
        write(chunk) { chunks.push(chunk); },
        async close() {
          const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          try { resolveDigest(await crypto.subtle.digest(algorithm, bytes)); } catch (error) { rejectDigest(error); }
        },
      });
      this.digest = digest;
    }
  };
}

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
        return { bind: () => ({ first: async () => ({ id: "runner-repo", namespace_id: "ns-1" }) }) };
      },
    },
    SIGNING_COORDINATORS: { getByName: () => stub },
    SIGNING_ARTIFACTS: {
      head: async () => storedSource ? { size: storedSource.byteLength } : null,
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
        for (const chunk of chunks) { storedSource.set(chunk, offset); offset += chunk.byteLength; }
      },
      get: async () => storedSource ? { size: storedSource.byteLength, body: new Response(storedSource).body } : null,
      delete: async () => { storedSource = null; },
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
        verifySigningHost: vi.fn(async () => approved ? { operatorApproved: true as const, approvedBy: owner.id, approvedAt: Date.now() } : null),
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
      data: { request: { ownerId: "owner-1", repositoryId: "runner-repo", state: "queued", runId: "22222222-2222-4222-8222-222222222222" } },
    });
    expect(hooks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "owner-1",
      repositoryId: "runner-repo",
      workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40),
      sourceDigest: submission.sourceDigest,
    }));
    expect(test.state().bound).toMatchObject({ ownerId: "owner-1", repositoryId: "runner-repo", runId: "22222222-2222-4222-8222-222222222222" });
  });

  it("rejects job and agent identities before reading or changing signing state", async () => {
    const test = environment();
    const hooks = test.hooks(true);
    const response = await handleSigningRoute(request(), test.env, { ...owner, job: { runId: "r", repositoryId: "p", commitOid: "a".repeat(40) } } as TrustedUser, hooks);

    expect(response.status).toBe(403);
    expect(hooks.loadApprovedProfile).not.toHaveBeenCalled();
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });
});
