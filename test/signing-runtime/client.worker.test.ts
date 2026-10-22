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
import {
  manifestSchema,
  verificationSchema,
  windowsManifestSchema,
} from "../../scripts/signing/contract.mjs";
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

function windowsVerification(size, sha256) {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "windows_sign",
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    bundle_id: "com.example.product",
    version: "1.2.3",
    architecture: "x64",
    subject: "CN=Example, O=Example",
    authenticode_verified: true,
    timestamp_verified: true,
    nested_signatures_verified: true,
    files: [{ path: "product.exe", size, sha256 }],
  };
}

function windowsManifest() {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "windows_sign",
    project_id: "product",
    version: "1.2.3",
    source_sha: hash,
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    bundle_id: "com.example.product",
    architecture: "x64",
    windows: {
      product_name: "Product",
      electron_version: "38.1.0",
      executable_name: "Product.exe",
      installer: "nsis",
      portable: false,
    },
    azure: {
      endpoint: "https://eus.codesigning.azure.net/",
      account: "account-one",
      certificate_profile: "public-trust",
      subject: "CN=Example, O=Example",
    },
    identity_mode: "azure-managed-identity",
    max_artifact_bytes: 20_000_000,
    max_unpacked_bytes: 30_000_000,
  };
}

function iosManifest() {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "ios_sign",
    project_id: "product",
    version: "1.2.3",
    source_sha: hash,
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    team_id: "ABCDEFGHIJ",
    bundle_id: "com.example.product",
    architecture: "arm64",
    max_artifact_bytes: 20_000_000,
    max_unpacked_bytes: 30_000_000,
  };
}

function iosVerification(size, sha256) {
  return {
    schema_version: 1,
    request_id: requestId,
    generation: 1,
    stage: "ios_sign",
    input_digest: inputDigest,
    recipe_sha: hash,
    policy_digest: `sha256:${digest}`,
    source_sha: hash,
    version: "1.2.3",
    architecture: "arm64",
    team_id: "ABCDEFGHIJ",
    bundle_id: "com.example.product",
    codesign_verified: true,
    identity_class: "Apple Development",
    certificate_expiration: "2099-01-01T00:00:00Z",
    profile_uuid: randomUUID(),
    profile_expiration: "2099-01-01T00:00:00Z",
    profile_type: "development",
    authorized_device_count: 1,
    files: [{ path: "signed.ipa", size, sha256 }],
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
    expect(approvedAzureIdentityMode("azure-managed-identity")).toBe("azure-managed-identity");
    expect(approvedAzureIdentityMode("azure-workload-identity")).toBe("azure-workload-identity");
    expect(() => approvedAzureIdentityMode("azure-cli")).toThrow(
      "approved Azure identity provider missing"
    );
    expect(() => approvedAzureIdentityMode(undefined)).toThrow(
      "approved Azure identity provider missing"
    );
  });

  it("validates account-specific Azure signing policy and an explicit host identity", () => {
    const windowsManifest = {
      schema_version: 1,
      request_id: requestId,
      generation: 1,
      stage: "windows_sign",
      project_id: "product",
      version: "1.2.3",
      source_sha: hash,
      input_digest: inputDigest,
      recipe_sha: hash,
      policy_digest: `sha256:${digest}`,
      bundle_id: "com.example.product",
      architecture: "x64",
      windows: {
        product_name: "Product",
        electron_version: "38.1.0",
        executable_name: "Product.exe",
        installer: "nsis",
        portable: false,
      },
      azure: {
        endpoint: "https://eus.codesigning.azure.net/",
        account: "account-one",
        certificate_profile: "public-trust",
        subject: "CN=Example, O=Example",
      },
      identity_mode: "azure-managed-identity",
      max_artifact_bytes: 20_000_000,
      max_unpacked_bytes: 30_000_000,
    };
    expect(() => windowsManifestSchema.parse(windowsManifest)).not.toThrow();
    expect(() =>
      windowsManifestSchema.parse({ ...windowsManifest, identity_mode: "azure-cli" })
    ).toThrow();
    expect(() =>
      windowsManifestSchema.parse({
        ...windowsManifest,
        azure: {
          ...windowsManifest.azure,
          endpoint: "https://evil.codesigning.azure.net.example/",
        },
      })
    ).toThrow();
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

  it("sends the GitEdge UUID and lease proof only in authenticated headers", async () => {
    const runContext = context();
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.method).toBe("POST");
      expect(init.headers["x-runner-run-id"]).toBe(runContext.runId);
      expect(init.headers["x-runner-lease-token"]).toBe(runContext.leaseToken);
      expect(JSON.parse(init.body)).toEqual({});
      return Response.json({ data: { leaseExpiresAt: Date.now() + 60_000 } });
    });
    const client = createSigningClient({ context: runContext, fetchImpl });
    const previousExpiry = client.getLeaseExpiresAt();
    await client.heartbeat();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/requests/${requestId}/heartbeat`);
    expect(client.getLeaseExpiresAt()).toBeGreaterThan(previousExpiry);
  });

  it("aborts the active platform executor when the signing lease heartbeat fails", async () => {
    const dir = await temporaryDirectory();
    const contextFile = path.join(dir, "run-context.json");
    const runContext = context();
    await writeFile(contextFile, JSON.stringify(runContext), { mode: 0o600 });
    let executorStarted;
    const started = new Promise((resolve) => {
      executorStarted = resolve;
    });
    let executorAborted;
    const aborted = new Promise((resolve) => {
      executorAborted = resolve;
    });
    const fetchImpl = vi.fn(async (url) => {
      const action = new URL(url).pathname.split("/").slice(-1)[0];
      if (action === "start") return Response.json({ data: { manifest: manifest() } });
      if (action === "download")
        return new Response(input, { headers: { "content-length": String(input.byteLength) } });
      if (action === "heartbeat") return Response.json({ error: "lease expired" }, { status: 409 });
      throw new Error(`Unexpected signing route ${action}`);
    });

    const execution = runSigning({
      contextFile,
      outputParent: path.join(dir, "work"),
      fetchImpl,
      sleep: async () => {},
      heartbeatIntervalMs: 5,
      contextReader: async (file) => parseSigningContext(JSON.parse(await readFile(file, "utf8"))),
      platformExecutor: async (_manifest, _input, _output, _credentials, _template, signal) => {
        executorStarted();
        await new Promise((resolve) => {
          if (signal.aborted) {
            executorAborted(signal.reason);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              executorAborted(signal.reason);
              resolve();
            },
            { once: true }
          );
        });
      },
    });

    await started;
    await expect(aborted).resolves.toBeDefined();
    await expect(execution).rejects.toMatchObject({ code: "HEARTBEAT_FAILED" });
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).pathname.endsWith("/heartbeat"))).toBe(
      true
    );
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
            expiresAt: Date.now() + 30_000,
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
        expect(init.headers["content-range"]).toMatch(/^bytes 0-\d+\/\d+$/);
        expect(init.headers["x-part-digest"]).toMatch(/^sha256:[a-f0-9]{64}$/);
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

  it("uses the server-approved Windows identity only after native input validation", async () => {
    const dir = await temporaryDirectory();
    const contextFile = path.join(dir, "run-context.json");
    const workParent = path.join(dir, "work");
    const runContext = context({ platform: "windows" });
    await writeFile(contextFile, JSON.stringify(runContext), { mode: 0o600 });
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const action = parsed.pathname.split("/").slice(-1)[0];
      calls.push({ url: parsed, init, action });
      expect(init.headers.authorization).toBe(`Bearer ${runContext.runnerToken}`);
      expect(init.headers["x-runner-run-id"]).toBe(runContext.runId);
      expect(init.headers["x-runner-lease-token"]).toBe(runContext.leaseToken);
      if (action === "start") return Response.json({ data: { manifest: windowsManifest() } });
      if (action === "download")
        return new Response(input, { headers: { "content-length": String(input.byteLength) } });
      if (action === "authorize-sign")
        return Response.json({
          data: {
            credentials: { identityMode: "azure-managed-identity" },
            expiresAt: Date.now() + 30_000,
          },
        });
      if (action === "output")
        return Response.json({
          data: { partSize: 8 * 1024 * 1024, partCount: 1, receivedParts: [] },
        });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith("/output/complete")) return Response.json({ data: {} });
      if (action === "complete")
        return Response.json({ data: { state: "succeeded" } }, { status: 202 });
      throw new Error(`Unexpected signing route ${parsed.pathname}`);
    });
    const signed = Buffer.from("mock Windows-signed payload");
    const report = windowsVerification(
      signed.byteLength,
      createHash("sha256").update(signed).digest("hex")
    );
    expect(() => windowsManifestSchema.parse(windowsManifest())).not.toThrow();
    expect(() => verificationSchema.parse(report)).not.toThrow();
    await runSigning({
      contextFile,
      outputParent: workParent,
      fetchImpl,
      sleep: async () => {},
      contextReader: async (file) => parseSigningContext(JSON.parse(await readFile(file, "utf8"))),
      platformExecutor: async (_manifest, _input, outputDir, credentialsProvider) => {
        expect(await credentialsProvider()).toEqual({ identityMode: "azure-managed-identity" });
        await writeFile(path.join(outputDir, "product.exe"), signed, { mode: 0o600 });
        await writeFile(path.join(outputDir, "verification.json"), JSON.stringify(report), {
          mode: 0o600,
        });
      },
      bundleBuilder: async (_outputDir, _report, work) => {
        const bytes = Buffer.from("mock Windows output archive");
        const bundlePath = path.join(work, "mock-output.zip");
        await writeFile(bundlePath, bytes, { mode: 0o600 });
        return {
          path: bundlePath,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      },
    });
    expect(calls.map((call) => call.action)).toEqual([
      "start",
      "download",
      "authorize-sign",
      "output",
      "1",
      "complete",
      "complete",
    ]);
  });

  it("authorizes macOS finalization while keeping signing credentials out of the native finalizer", async () => {
    const dir = await temporaryDirectory();
    const contextFile = path.join(dir, "run-context.json");
    const workParent = path.join(dir, "work");
    const runContext = context();
    await writeFile(contextFile, JSON.stringify(runContext), { mode: 0o600 });
    const finalManifest = {
      ...manifest(),
      stage: "finalize",
      notarization_id: randomUUID(),
      notary_archive_sha256: digest,
    };
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const action = parsed.pathname.split("/").slice(-1)[0];
      calls.push({ action, init });
      if (action === "start") return Response.json({ data: { manifest: finalManifest } });
      if (action === "download")
        return new Response(input, { headers: { "content-length": String(input.byteLength) } });
      if (action === "authorize-sign")
        return Response.json({
          data: {
            expiresAt: Date.now() + 30_000,
          },
        });
      if (action === "output")
        return Response.json({
          data: { partSize: 8 * 1024 * 1024, partCount: 1, receivedParts: [] },
        });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith("/output/complete")) return Response.json({ data: {} });
      if (action === "complete")
        return Response.json({ data: { state: "succeeded" } }, { status: 202 });
      throw new Error(`Unexpected signing route ${parsed.pathname}`);
    });
    const product = Buffer.from("notarized product archive");
    const report = {
      ...verification(product.byteLength, createHash("sha256").update(product).digest("hex")),
      stage: "finalize",
      notarization_id: finalManifest.notarization_id,
      notarization_status: "Accepted",
      gatekeeper_verified: true,
      staple_verified: true,
      files: [
        {
          path: "product.zip",
          size: product.byteLength,
          sha256: createHash("sha256").update(product).digest("hex"),
        },
      ],
    };
    expect(() => manifestSchema.parse(finalManifest)).not.toThrow();
    expect(() => verificationSchema.parse(report)).not.toThrow();
    await runSigning({
      contextFile,
      outputParent: workParent,
      fetchImpl,
      sleep: async () => {},
      contextReader: async (file) => parseSigningContext(JSON.parse(await readFile(file, "utf8"))),
      platformExecutor: async (_manifest, _input, outputDir, credentialsProvider) => {
        expect(credentialsProvider).toBeUndefined();
        await writeFile(path.join(outputDir, "product.zip"), product, { mode: 0o600 });
        await writeFile(path.join(outputDir, "verification.json"), JSON.stringify(report), {
          mode: 0o600,
        });
      },
      bundleBuilder: async (_outputDir, _report, work) => {
        const bytes = Buffer.from("mock finalized output archive");
        const bundlePath = path.join(work, "mock-output.zip");
        await writeFile(bundlePath, bytes, { mode: 0o600 });
        return {
          path: bundlePath,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      },
    });
    expect(calls.map((call) => call.action)).toEqual([
      "start",
      "download",
      "authorize-sign",
      "output",
      "1",
      "complete",
      "complete",
    ]);
  });

  it("runs an iOS request through the pinned profile and strict per-file verification report", async () => {
    const dir = await temporaryDirectory();
    const contextFile = path.join(dir, "run-context.json");
    const workParent = path.join(dir, "work");
    const runContext = context({ platform: "ios" });
    await writeFile(contextFile, JSON.stringify(runContext), { mode: 0o600 });
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      const action = parsed.pathname.split("/").slice(-1)[0];
      calls.push({ action, init });
      if (action === "start") return Response.json({ data: { manifest: iosManifest() } });
      if (action === "download")
        return new Response(input, { headers: { "content-length": String(input.byteLength) } });
      if (action === "authorize-sign")
        return Response.json({
          data: {
            credentials: {
              certificate_p12: "YQ==",
              certificate_password: "one-time-credential",
              provisioning_profile: "YQ==",
            },
            expiresAt: Date.now() + 30_000,
          },
        });
      if (action === "output")
        return Response.json({
          data: { partSize: 8 * 1024 * 1024, partCount: 1, receivedParts: [] },
        });
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith("/output/complete")) return Response.json({ data: {} });
      if (action === "complete")
        return Response.json({ data: { state: "succeeded" } }, { status: 202 });
      throw new Error(`Unexpected signing route ${parsed.pathname}`);
    });
    const signed = Buffer.from("mock iOS-signed payload");
    const report = iosVerification(
      signed.byteLength,
      createHash("sha256").update(signed).digest("hex")
    );
    expect(() => manifestSchema.parse(iosManifest())).not.toThrow();
    expect(() => verificationSchema.parse(report)).not.toThrow();
    await runSigning({
      contextFile,
      outputParent: workParent,
      fetchImpl,
      sleep: async () => {},
      contextReader: async (file) => parseSigningContext(JSON.parse(await readFile(file, "utf8"))),
      platformExecutor: async (_manifest, _input, outputDir, credentialsProvider) => {
        expect(await credentialsProvider()).toMatchObject({
          certificate_password: "one-time-credential",
          provisioning_profile: "YQ==",
        });
        await writeFile(path.join(outputDir, "signed.ipa"), signed, { mode: 0o600 });
        await writeFile(path.join(outputDir, "verification.json"), JSON.stringify(report), {
          mode: 0o600,
        });
      },
      bundleBuilder: async (_outputDir, _report, work) => {
        const bytes = Buffer.from("mock iOS output archive");
        const bundlePath = path.join(work, "mock-output.zip");
        await writeFile(bundlePath, bytes, { mode: 0o600 });
        return {
          path: bundlePath,
          size: bytes.length,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        };
      },
    });
    expect(calls.map((call) => call.action)).toEqual([
      "start",
      "download",
      "authorize-sign",
      "output",
      "1",
      "complete",
      "complete",
    ]);
  });
});

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
