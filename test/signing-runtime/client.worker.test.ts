import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSigningClient, runSigning } from "../../scripts/signing/client.mjs";
import {
  parseSigningContext,
  readSigningContext,
  SigningContextError,
} from "../../scripts/signing/context.mjs";
import { manifestSchema, verificationSchema } from "../../scripts/signing/contract.mjs";
import { approvedAzureIdentityMode } from "../../scripts/signing/windows-identity.mjs";

const tempDirs = [];
const input = Buffer.from("validated source archive");
const inputDigest = `sha256:${createHash("sha256").update(input).digest("hex")}`;
const hash = "a".repeat(40);
const digest = "b".repeat(64);
const requestId = randomUUID();

function context(overrides = {}) {
  return {
    schemaVersion: 1,
    baseUrl: "https://gitedge.test/api/actions",
    ownerId: randomUUID(),
    repositoryId: randomUUID(),
    runnerId: randomUUID(),
    runId: randomUUID(),
    requestId,
    platform: "macos",
    workflowOid: hash,
    profileRevision: hash,
    generation: 1,
    nonce: "A".repeat(43),
    leaseToken: "c".repeat(64),
    leaseExpiresAt: Date.now() + 60_000,
    runnerToken: `ge_runner_${"d".repeat(64)}`,
    operatorApproved: true,
    approvedBy: "owner-id",
    approvedAt: Date.now(),
    ...overrides,
  };
}

function manifest() {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "sign",
    project_id: "product",
    version: "1.2.3",
    source_sha: hash,
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    team_id: "ABCDEFGHIJ",
    bundle_id: "com.example.product",
    bundle_name: "Product.app",
    architecture: "arm64",
    profile: "native",
    harden_electron_fuses: false,
    max_artifact_bytes: 20_000_000,
    max_unpacked_bytes: 30_000_000,
  };
}

function verification(size, sha256) {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "sign",
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    team_id: "ABCDEFGHIJ",
    bundle_id: "com.example.product",
    version: "1.2.3",
    architecture: "arm64",
    codesign_verified: true,
    timestamp_verified: true,
    asar_integrity_verified: true,
    notarization_id: randomUUID(),
    notarization_status: "Submitted",
    notary_archive_sha256: digest,
    gatekeeper_verified: false,
    staple_verified: false,
    files: [{ path: "signed.tar.gz", size, sha256 }],
  };
}

async function temporaryDirectory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gitedge-signing-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("native signing context and Actions client", () => {
  it("requires a GitEdge UUID context and explicit owner approval", () => {
    expect(parseSigningContext(context()).requestId).toBe(requestId);
    expect(() => parseSigningContext(context({ operatorApproved: false }))).toThrow(
      SigningContextError
    );
    expect(() => parseSigningContext(context({ runId: "1234567890" }))).toThrow(
      SigningContextError
    );
    expect(() =>
      parseSigningContext(context({ baseUrl: "http://example.invalid/api/actions" }))
    ).toThrow(SigningContextError);
  });

  it("only accepts the profile-approved Azure host identity providers", () => {
    expect(
      approvedAzureIdentityMode({ policy: { windowsIdentity: "azure-managed-identity" } })
    ).toBe("azure-managed-identity");
    expect(
      approvedAzureIdentityMode({ policy: { windowsIdentity: "azure-workload-identity" } })
    ).toBe("azure-workload-identity");
    expect(() => approvedAzureIdentityMode({ policy: { windowsIdentity: "azure-cli" } })).toThrow(
      "approved Azure identity provider missing"
    );
    expect(() => approvedAzureIdentityMode({ policy: {} })).toThrow(
      "approved Azure identity provider missing"
    );
  });

  it("rejects a context file with broad POSIX permissions", async () => {
    if (process.platform === "win32") return;
    const dir = await temporaryDirectory();
    const file = path.join(dir, "context.json");
    await writeFile(file, JSON.stringify(context()), { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(readSigningContext(file, { platform: "linux" })).rejects.toThrow(
      "INSECURE_CONTEXT_FILE"
    );
  });

  it("sends the GitEdge UUID and lease proof on every authenticated callback", async () => {
    const runContext = context();
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toMatchObject({
        runId: runContext.runId,
        leaseToken: runContext.leaseToken,
      });
      return Response.json({ data: { leaseExpiresAt: Date.now() + 60_000 } });
    });
    await createSigningClient({ context: runContext, fetchImpl }).heartbeat();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/requests/${requestId}/heartbeat`);
  });

  it("runs a signed request through native UUID API and multipart output using verified mock tooling", async () => {
    const dir = await temporaryDirectory();
    const contextFile = path.join(dir, "run-context.json");
    const workParent = path.join(dir, "work");
    const runContext = context();
    await writeFile(contextFile, JSON.stringify(runContext), { mode: 0o600 });
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const action = parsed.pathname.split("/").slice(-1)[0];
      calls.push({ url: parsed, init, action });
      expect(init.headers.authorization).toBe(`Bearer ${runContext.runnerToken}`);
      expect(init.headers["x-runner-run-id"]).toBe(runContext.runId);
      expect(init.headers["x-runner-lease-token"]).toBe(runContext.leaseToken);
      if (action === "start") return Response.json({ data: { manifest: manifest() } });
      if (action === "download") {
        expect(init.method).toBe("GET");
        expect(parsed.searchParams.get("object")).toBe("input");
        return new Response(input, { headers: { "content-length": String(input.byteLength) } });
      }
      if (action === "authorize-sign")
        return Response.json({
          data: {
            credentials: {
              certificate_p12: "YQ==",
              certificate_password: "temporary-password",
              notarization: {
                key_id: "ABCDEFGHIJ",
                issuer_id: randomUUID(),
                private_key: "k".repeat(100),
              },
            },
          },
        });
      if (action === "output")
        return Response.json({
          data: { partSize: 8 * 1024 * 1024, partCount: 1, receivedParts: [] },
        });
      if (init.method === "PUT") {
        const [, rangeStart, rangeEnd] = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          init.headers["content-range"]
        );
        expect(Number(init.headers["content-length"])).toBe(
          Number(rangeEnd) - Number(rangeStart) + 1
        );
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname.endsWith("/output/complete")) return Response.json({ data: {} });
      if (action === "complete")
        return Response.json({ data: { state: "verifying" } }, { status: 202 });
      throw new Error(`Unexpected signing route ${parsed.pathname}`);
    });
    const signed = Buffer.from("signed native payload");
    const signedHash = createHash("sha256").update(signed).digest("hex");
    const report = verification(signed.byteLength, signedHash);
    expect(() => manifestSchema.parse(manifest())).not.toThrow();
    expect(() => verificationSchema.parse(report)).not.toThrow();
    const result = await runSigning({
      contextFile,
      outputParent: workParent,
      fetchImpl,
      sleep: async () => {},
      contextReader: async (file) => parseSigningContext(JSON.parse(await readFile(file, "utf8"))),
      platformExecutor: async (_manifest, _input, outputDir, credentialsProvider) => {
        const credentials = await credentialsProvider();
        expect(credentials.certificate_password).toBe("temporary-password");
        await writeFile(path.join(outputDir, "signed.tar.gz"), signed, { mode: 0o600 });
        await writeFile(path.join(outputDir, "verification.json"), JSON.stringify(report), {
          mode: 0o600,
        });
      },
      bundleBuilder: async (_outputDir, _report, work) => {
        const bytes = Buffer.from("multipart archive bytes");
        const bundlePath = path.join(work, "mock-output.zip");
        await writeFile(bundlePath, bytes, { mode: 0o600 });
        return {
          path: bundlePath,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      },
    });

    expect(result).toMatchObject({ requestId, outputDigest: expect.stringMatching(/^sha256:/) });
    expect(calls.map((call) => call.action)).toEqual([
      "start",
      "download",
      "authorize-sign",
      "output",
      "1",
      "complete",
      "complete",
    ]);
    expect(
      calls.some(
        (call) => call.url.searchParams.has("run_id") || call.url.searchParams.has("nonce")
      )
    ).toBe(false);
    expect(await readFile(contextFile).catch(() => null)).toBeNull();
    expect(await readdirSafe(workParent)).toEqual([]);
  });
});

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
