import { describe, expect, it, vi } from "vitest";
import { handleSigningRoute, reconcileSigningRequests, SigningCoordinator } from "../../workers/actions/src/signing";
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
  policyDigest: "sha256:" + "f".repeat(64),
  workflowOid: "d".repeat(40),
  workflowPath: ".github/workflows/desktop-release.yml",
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

  it("allows a queue job or repository-scoped write token to submit only for its bound Runner repository", async () => {
    const jobTest = environment();
    const jobResponse = await handleSigningRoute(request(), jobTest.env,
      { ...owner, job: { runId: "job-run", repositoryId: "runner-repo", commitOid: "a".repeat(40) } } as TrustedUser,
      jobTest.hooks(true));
    expect(jobResponse.status).toBe(202);

    const tokenTest = environment();
    const tokenRequest = new Request("https://actions.test/signing/requests?repositoryId=runner-repo", {
      method: "POST", headers: { "Idempotency-Key": "release-2026-10-21-00001", "Content-Type": "application/json" }, body: JSON.stringify(submission),
    });
    const tokenResponse = await handleSigningRoute(tokenRequest, tokenTest.env,
      { ...owner, token: { id: "token-1", scopes: ["repo:write"], repositoryIds: ["runner-repo"] } } as TrustedUser,
      tokenTest.hooks(true));
    expect(tokenResponse.status).toBe(202);

    const denied = environment();
    const deniedRequest = new Request("https://actions.test/signing/requests?repositoryId=another-repo", {
      method: "POST", headers: { "Idempotency-Key": "release-2026-10-21-00001", "Content-Type": "application/json" }, body: JSON.stringify(submission),
    });
    const deniedResponse = await handleSigningRoute(deniedRequest, denied.env,
      { ...owner, token: { id: "token-2", scopes: ["repo:write"], repositoryIds: ["another-repo"] } } as TrustedUser,
      denied.hooks(true));
    expect(deniedResponse.status).toBe(503);
    expect(denied.stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects job and agent identities before reading or changing signing state", async () => {
    const test = environment();
    const hooks = test.hooks(true);
    const response = await handleSigningRoute(request(), test.env, { ...owner, job: { runId: "r", repositoryId: "different-repo", commitOid: "a".repeat(40) } } as TrustedUser, hooks);

    expect(response.status).toBe(503);
    expect(hooks.loadApprovedProfile).not.toHaveBeenCalled();
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });

  it("requires a recent human session to approve profiles", async () => {
    const test = environment();
    const response = await handleSigningRoute(new Request("https://actions.test/signing/profiles?repositoryId=runner-repo", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "desktop-release" }),
    }), test.env, { ...owner, job: { runId: "r", repositoryId: "runner-repo", commitOid: "a".repeat(40) } } as TrustedUser, test.hooks(true));

    expect(response.status).toBe(403);
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });
});

describe("native signing stage reconciliation", () => {
  it("serializes concurrent stage preparation and returns the same prepared generation", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111", repository_id: "runner-repo", owner_id: owner.id,
      idempotency_key: "some-release-key-0001", profile_json: JSON.stringify({ ...profile, platform: "macos", policy: { stage: "sign", project: { macos: { output_format: "zip" } } },
        operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 } }),
      submission_json: JSON.stringify({ ...submission, platform: "macos" }), state: "awaiting_source", current_stage: "sign",
      run_id: "22222222-2222-4222-8222-222222222222", source_digest: submission.sourceDigest, source_size: 3,
      output_digest: submission.sourceDigest, output_size: 3, authorized_at: 0, verification_json: null,
      generation: 1, nonce: "A".repeat(43), created_at: 1, completed_at: null,
    };
    const sql = { exec: (query: string, ...args: unknown[]) => {
      if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) return { toArray: () => [], rowsWritten: 0 };
      if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
      if (query.includes("FROM signing_stage_outputs")) return { toArray: () => [{ digest: "sha256:" + "f".repeat(64), size: 9, verification_json: "{}" }] };
      if (query.startsWith("UPDATE signing_requests SET state='accepted'")) {
        if (row.state !== "awaiting_source") return { toArray: () => [], rowsWritten: 0 };
        row.state = "accepted"; row.current_stage = String(args[0]); row.run_id = null; row.generation += 1; row.nonce = String(args[1]);
        row.output_digest = null; row.output_size = null; row.authorized_at = 0; row.verification_json = null;
        return { toArray: () => [], rowsWritten: 1 };
      }
      return { toArray: () => [], rowsWritten: 0 };
    } };
    const context = { storage: { sql, transactionSync: (callback: () => unknown) => callback() } };
    const coordinator = new SigningCoordinator(context as never, {} as SigningEnv);
    const prepared = [coordinator.prepareNextStage(row.id, owner.id, row.repository_id, "B".repeat(43)),
      coordinator.prepareNextStage(row.id, owner.id, row.repository_id, "C".repeat(43))];

    expect(prepared[0]?.dispatch).toEqual(prepared[1]?.dispatch);
    expect(prepared[0]?.dispatch).toMatchObject({ stage: "finalize", generation: 2, nonce: "B".repeat(43), inputDigest: "sha256:" + "f".repeat(64) });
    expect(row.state).toBe("accepted");
  });

  it("records execution failure once and makes a repeated failure callback idempotent", () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111", repository_id: "runner-repo", owner_id: owner.id,
      profile_json: JSON.stringify({ ...profile, operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 } }),
      submission_json: JSON.stringify(submission), state: "running", current_stage: "windows_sign",
      run_id: "22222222-2222-4222-8222-222222222222", source_digest: submission.sourceDigest, source_size: 3,
      output_digest: null, output_size: null, authorized_at: 1, verification_json: null,
      generation: 1, nonce: "A".repeat(43), created_at: 1, completed_at: null,
    };
    const sql = { exec: (query: string, ...args: unknown[]) => {
      if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) return { toArray: () => [], rowsWritten: 0 };
      if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
      if (query.startsWith("UPDATE signing_requests SET state='failed'")) {
        row.state = "failed"; row.completed_at = Number(args[0]); row.verification_json = String(args[1]);
        return { toArray: () => [], rowsWritten: 1 };
      }
      return { toArray: () => [], rowsWritten: 0 };
    } };
    const coordinator = new SigningCoordinator({ storage: { sql } } as never, {} as SigningEnv);
    const context = {
      ownerId: owner.id, runnerId: "33333333-3333-4333-8333-333333333333", runId: row.run_id,
      requestId: row.id, leaseExpiresAt: Date.now() + 60_000, repositoryId: row.repository_id, workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40), platform: "windows", stage: "windows_sign", generation: 1, nonce: row.nonce,
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
    };

    expect(coordinator.machine(row.id, context, "fail", { code: "signing_tool_failed" })).toEqual({ state: "failed" });
    expect(coordinator.machine(row.id, context, "fail", { code: "signing_tool_failed" })).toEqual({ state: "failed" });
    expect(row.state).toBe("failed");
  });

  it("recovers multipart verification after R2 committed the archive but its first read failed", async () => {
    const row = {
      id: "11111111-1111-4111-8111-111111111111", repository_id: "runner-repo", owner_id: owner.id,
      profile_json: JSON.stringify({ ...profile, operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 10 } }),
      submission_json: JSON.stringify(submission), state: "running", current_stage: "windows_sign",
      run_id: "22222222-2222-4222-8222-222222222222", source_digest: submission.sourceDigest, source_size: 3,
      output_digest: null, output_size: null, authorized_at: 1, verification_json: null,
      generation: 1, nonce: "A".repeat(43), created_at: 1, completed_at: null,
    };
    const upload = { request_id: row.id, upload_id: "upload-1", digest: submission.sourceDigest, size: 3, part_size: 8 * 1024 * 1024, part_count: 1, verified: 0 };
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
    const sql = { exec: (query: string) => {
      if (query.startsWith("CREATE TABLE") || query.startsWith("CREATE INDEX")) return { toArray: () => [], rowsWritten: 0 };
      if (query.startsWith("SELECT * FROM signing_requests")) return { toArray: () => [row] };
      if (query.includes("FROM signing_uploads")) return { toArray: () => [upload] };
      if (query.includes("FROM signing_upload_parts")) return { toArray: () => [{ part: 1, etag: "etag-1", size: 3 }] };
      if (query.startsWith("UPDATE signing_uploads SET verified=1")) { upload.verified = 1; return { toArray: () => [], rowsWritten: 1 }; }
      return { toArray: () => [], rowsWritten: 0 };
    } };
    const coordinator = new SigningCoordinator({ storage: { sql } } as never, { SIGNING_ARTIFACTS: artifact } as unknown as SigningEnv);
    const context = {
      ownerId: owner.id, runnerId: "33333333-3333-4333-8333-333333333333", runId: row.run_id,
      requestId: row.id, leaseExpiresAt: Date.now() + 60_000, repositoryId: row.repository_id, workflowOid: "d".repeat(40),
      profileRevision: "c".repeat(40), platform: "windows", stage: "windows_sign", generation: 1, nonce: row.nonce,
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
    };

    await expect(coordinator.finishOutput(row.id, context)).rejects.toThrow("temporary R2 read failure");
    await expect(coordinator.finishOutput(row.id, context)).resolves.toEqual({ digest: submission.sourceDigest, size: 3, verified: true });
    expect(artifact.resumeMultipartUpload).toHaveBeenCalledTimes(1);
  });

  it("advances an approved request once and enqueues the next stage with the prior output digest", async () => {
    const queued: unknown[] = [];
    const calls: string[] = [];
    const attempts: unknown[] = [];
    let failEnqueueOnce = true;
    const nextDispatch = {
      profile: { ...profile, platform: "macos", workflowOid: "e".repeat(40), policy: { stage: "sign" } },
      submission: { ...submission, platform: "macos" },
      generation: 2,
      nonce: "B".repeat(43),
      operatorApproval: { operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 },
      stage: "finalize",
      inputDigest: "sha256:" + "f".repeat(64),
      inputSize: 12,
    };
    const stub = { fetch: vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path.startsWith("/prepare-next-stage/")) return Response.json({ data: { dispatch: nextDispatch } });
      if (path.startsWith("/bind-run/")) return Response.json({ bound: true });
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) };
    const env = {
      DB: { prepare: (sql: string) => ({
        all: async () => ({ results: [
          { requestId: "11111111-1111-4111-8111-111111111111", ownerId: owner.id, repositoryId: "runner-repo", profileRevision: "c".repeat(40), platform: "macos" },
          { requestId: "11111111-1111-4111-8111-111111111111", ownerId: owner.id, repositoryId: "runner-repo", profileRevision: "c".repeat(40), platform: "macos" },
        ] }),
        bind: () => ({ first: async () => ({ active: 1 }) }),
      }) },
      SIGNING_COORDINATORS: { getByName: () => stub },
    } as unknown as SigningEnv;
    const hooks = {
      verifySigningHost: vi.fn(async () => ({ operatorApproved: true as const, approvedBy: owner.id, approvedAt: 10 })),
      enqueue: vi.fn(async input => {
        attempts.push(input);
        if (failEnqueueOnce) { failEnqueueOnce = false; throw new Error("unknown enqueue outcome"); }
        queued.push(input);
        return { runId: "22222222-2222-4222-8222-222222222222" };
      }),
    } as unknown as SigningExecutionHooks;

    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({ queued: 0, skipped: 0, failed: 1 });
    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({ queued: 1, skipped: 0, failed: 0 });
    expect(queued).toHaveLength(1);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(queued[0]).toMatchObject({ stage: "finalize", inputDigest: "sha256:" + "f".repeat(64), generation: 2 });
    expect(calls.filter(path => path.startsWith("/prepare-next-stage/"))).toHaveLength(2);
    expect(calls.some(path => path.startsWith("/bind-run/"))).toBe(true);
  });

  it("only scans current nonterminal signing stages so old completed runs do not occupy the reconciliation window", async () => {
    let query = "";
    const env = {
      DB: { prepare: (sql: string) => {
        query = sql;
        return { all: async () => ({ results: [] }) };
      } },
      SIGNING_COORDINATORS: { getByName: () => ({ fetch: async () => Response.json({ data: null }) }) },
    } as unknown as SigningEnv;
    const hooks = { verifySigningHost: vi.fn(), enqueue: vi.fn() } as unknown as SigningExecutionHooks;

    await expect(reconcileSigningRequests(env, hooks)).resolves.toEqual({ queued: 0, skipped: 0, failed: 0 });
    expect(query).toContain("s.stage='sign' AND r.status='completed' AND r.conclusion='success'");
    expect(query).toContain("s.stage='finalize' AND r.status IN ('queued','running')");
    expect(query).toContain("NOT EXISTS (SELECT 1 FROM actions_signing_runs newer");
    expect(query).toContain("ORDER BY s.created_at DESC LIMIT 100");
  });

  it("rejects a signing callback with an expired runner lease before contacting coordinator state", async () => {
    const test = environment();
    const { handleSigningMachineRoute } = await import("../../workers/actions/src/signing");
    const context = {
      ownerId: owner.id, runnerId: "33333333-3333-4333-8333-333333333333", runId: "22222222-2222-4222-8222-222222222222",
      requestId: "11111111-1111-4111-8111-111111111111", leaseExpiresAt: Date.now() - 1, repositoryId: "runner-repo",
      workflowOid: "d".repeat(40), profileRevision: "c".repeat(40), platform: "windows", stage: "windows_sign",
      generation: 1, nonce: "A".repeat(43), operatorApproval: { operatorApproved: true, approvedBy: owner.id, approvedAt: 1 },
    };
    const response = await handleSigningMachineRoute(new Request("https://actions.test/runner/signing/requests/11111111-1111-4111-8111-111111111111/start", { method: "POST" }),
      test.env, context, test.hooks(true));
    expect(response.status).toBe(403);
    expect(test.stub.fetch).not.toHaveBeenCalled();
  });
});
