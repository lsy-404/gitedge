import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrustedUser } from "../../packages/contracts/src/index";
import type {
  SigningMachineContext,
  SigningProfile,
  SigningStage,
} from "../../packages/contracts/src/signing";
import {
  handleSigningMachineRoute,
  handleSigningRoute,
  reconcileSigningRequests,
} from "../../workers/actions/src/signing";
import type { SigningEnv, SigningExecutionHooks } from "../../workers/actions/src/signing/types";
import { enqueueNativeSigningRun } from "../../workers/actions/src/signing-execution";
import { createPerson, migrate, type Person } from "../support/stack";
import { runSigning } from "../../scripts/signing/client.mjs";

const workflowPath = ".github/workflows/native-signing.yml";
const workflowSource = `name: Native signing\non:\n  workflow_dispatch:\njobs:\n  sign:\n    runs-on: [self-hosted, need-tool-node, need-time-5m]\n    steps:\n      - run: echo signing\n`;
const commitOid = "a".repeat(40);
const workflowOid = "b".repeat(40);
const revision = "c".repeat(40);
const policyDigest = `sha256:${"d".repeat(64)}`;

let owner: Person;
let repositoryId: string;
const signingEnv = env as unknown as SigningEnv & {
  AUTH: Fetcher;
  FORGE: Fetcher;
  GIT: Fetcher;
  RELEASE_ASSETS: R2Bucket;
};

function trusted(person: Person): TrustedUser {
  return {
    id: person.id,
    identifier: person.identifier,
    groupKey: person.groupKey,
    recentAuthAt: Date.now(),
  };
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function profile(
  platform: "macos" | "windows" | "ios",
  stage: SigningStage,
  outputFormat: "zip" | "dmg" = "zip"
): SigningProfile {
  const project: Record<string, unknown> = {
    id: `sample-${platform}`,
    enabled: true,
    max_artifact_bytes: 900_000_000,
  };
  if (platform === "macos")
    project.macos = {
      bundle_id: "com.example.product",
      bundle_name: "Product.app",
      architecture: "arm64",
      profile: "native",
      harden_electron_fuses: false,
      output_format: outputFormat,
      max_unpacked_bytes: 8_000_000_000,
    };
  if (platform === "windows")
    project.windows = {
      bundle_id: "com.example.product",
      architecture: "x64",
      product_name: "Product",
      electron_version: "1.2.3",
      executable_name: "Product.exe",
      installer: "nsis",
      portable: false,
      max_unpacked_bytes: 8_000_000_000,
    };
  if (platform === "ios")
    project.ios = {
      bundle_id: "com.example.product",
      architecture: "arm64",
      max_unpacked_bytes: 4_000_000_000,
    };
  return {
    name: `release-${platform}-${outputFormat}`,
    revision,
    policyDigest,
    workflowOid,
    workflowPath,
    workflowSource,
    platform,
    timeoutMinutes: 60,
    enabled: true,
    policy: {
      stage,
      project,
      sourceRepositories: [
        {
          id: "12345",
          fullName: "example/source",
          workflowPath,
          artifactName: "build-output",
          actorIds: [1],
          events: ["workflow_dispatch"],
          refs: ["refs/heads/main"],
        },
      ],
      teamId: "ABCDE12345",
      azure: {
        endpoint: "https://example.codesigning.azure.net/",
        account: "test-account",
        certificate_profile: "test-profile",
        subject: "CN=Example Publisher",
      },
    },
  };
}

function verification(manifest: Record<string, unknown>, file: string, bytes: Uint8Array) {
  const common = {
    schema_version: 1,
    request_id: manifest.request_id,
    generation: manifest.generation,
    stage: manifest.stage,
    input_digest: manifest.input_digest,
    recipe_sha: manifest.recipe_sha,
    policy_digest: manifest.policy_digest,
    version: manifest.version ?? "1.2.3",
    files: [
      {
        path: file,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  if (manifest.stage === "windows_sign")
    return {
      ...common,
      bundle_id: manifest.bundle_id,
      architecture: manifest.architecture,
      subject: "CN=Example Publisher",
      authenticode_verified: true,
      timestamp_verified: true,
      nested_signatures_verified: true,
    };
  if (manifest.stage === "ios_sign")
    return {
      ...common,
      source_sha: manifest.source_sha,
      bundle_id: manifest.bundle_id,
      architecture: manifest.architecture,
      team_id: manifest.team_id,
      codesign_verified: true,
      identity_class: "Apple Development",
      certificate_expiration: "2030-01-01T00:00:00Z",
      profile_uuid: "11111111-1111-4111-8111-111111111111",
      profile_expiration: "2030-01-01T00:00:00Z",
      profile_type: "development",
      authorized_device_count: 1,
    };
  return {
    ...common,
    team_id: manifest.team_id,
    bundle_id: manifest.bundle_id,
    architecture: manifest.architecture,
    codesign_verified: true,
    timestamp_verified: true,
    asar_integrity_verified: true,
    notarization_id: manifest.notarization_id ?? "22222222-2222-4222-8222-222222222222",
    notarization_status: manifest.stage === "finalize" ? "Accepted" : "Submitted",
    notary_archive_sha256: manifest.notary_archive_sha256 ?? "e".repeat(64),
    gatekeeper_verified: manifest.stage === "finalize",
    staple_verified: manifest.stage === "finalize",
  };
}

async function createRunner(platform: "macos" | "windows" | "ios") {
  const runnerId = crypto.randomUUID();
  const runnerToken = `ge_runner_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
  const repo = await signingEnv.DB.prepare("SELECT namespace_id FROM repositories WHERE id=?")
    .bind(repositoryId)
    .first<{ namespace_id: string }>();
  await signingEnv.DB.prepare(
    `INSERT INTO actions_runners(id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
     VALUES(?,?,?,?,?,?,?,?)`
  )
    .bind(
      runnerId,
      `signing-${platform}-${crypto.randomUUID()}`,
      repo!.namespace_id,
      repositoryId,
      owner.id,
      JSON.stringify([
        "self-hosted",
        platform === "windows" ? "Windows" : "macOS",
        ...(platform === "ios" ? ["ARM64"] : []),
      ]),
      createHash("sha256").update(runnerToken).digest("hex"),
      Date.now()
    )
    .run();
  return { runnerId, runnerToken };
}

async function executeStage(input: {
  profile: SigningProfile;
  stage?: SigningStage;
  requestId: string;
  runId: string;
  runnerId: string;
  runnerToken: string;
  leaseToken: string;
  generation: number;
  nonce: string;
  clientLeaseExpiresAt?: number;
}) {
  const clientLeaseExpiresAt = input.clientLeaseExpiresAt ?? Date.now() + 60_000;
  const machineContext: SigningMachineContext = {
    ownerId: owner.id,
    runnerId: input.runnerId,
    runId: input.runId,
    requestId: input.requestId,
    leaseExpiresAt: Date.now() + 60 * 60_000,
    repositoryId,
    workflowOid,
    profileRevision: revision,
    platform: input.profile.platform,
    stage: input.stage ?? (input.profile.policy.stage as SigningStage),
    generation: input.generation,
    nonce: input.nonce,
  };
  const hooks: SigningExecutionHooks = {
    loadApprovedProfile: async () => input.profile,
    verifySource: async () => false,
    verifySourceCurrent: async () => true,
    enqueue: async () => ({ runId: input.runId }),
    authorizeCredentials: async (context) => ({
      expiresAt: Math.min(context.leaseExpiresAt, Date.now() + 5 * 60_000),
      credentials:
        input.profile.platform === "windows"
          ? {
              tenant_id: "11111111-1111-4111-8111-111111111111",
              client_id: "22222222-2222-4222-8222-222222222222",
              client_secret: "task-scoped-secret",
            }
          : input.profile.platform === "ios"
            ? {
                certificate_p12: "Y2VydA==",
                certificate_password: "temporary",
                provisioning_profile: "cHJvZmlsZQ==",
              }
            : {
                certificate_p12: "Y2VydA==",
                certificate_password: "temporary",
                notarization: {
                  key_id: "ABCDE12345",
                  issuer_id: "33333333-3333-4333-8333-333333333333",
                  private_key: "x".repeat(120),
                },
              },
    }),
    verifyOutput: async () => true,
    verifyNotarization: async () => "Accepted",
  };
  const fetchImpl: typeof fetch = async (inputUrl, init) => {
    const url = new URL(String(inputUrl));
    url.pathname = url.pathname.replace(/^\/api\/actions/, "");
    const request = new Request(url, { ...init, redirect: "manual" });
    const response = await handleSigningMachineRoute(request, signingEnv, machineContext, hooks);
    if (url.pathname.endsWith("/authorize-sign")) {
      expect(await response.clone().json()).toMatchObject({
        data: { leaseExpiresAt: machineContext.leaseExpiresAt },
      });
    }
    return response;
  };
  const root = await mkdtemp(path.join(os.tmpdir(), "signing-worker-e2e-"));
  const contextFile = path.join(root, "context.json");
  await writeFile(contextFile, "test-only-context", { mode: 0o600 });
  try {
    return await runSigning({
      contextFile,
      outputParent: root,
      fetchImpl,
      sleep: async () => {},
      contextReader: async () => ({
        schemaVersion: 1,
        baseUrl: "http://localhost/api/actions",
        ownerId: owner.id,
        repositoryId,
        runnerId: input.runnerId,
        runId: input.runId,
        requestId: input.requestId,
        platform: input.profile.platform,
        workflowOid,
        profileRevision: revision,
        generation: input.generation,
        nonce: input.nonce,
        leaseToken: input.leaseToken,
        leaseExpiresAt: clientLeaseExpiresAt,
        jobToken: `ge_job_${"e".repeat(64)}`,
      }),
      platformExecutor: async (
        manifest,
        _inputPath,
        outputDirectory,
        credentialsProvider,
        templateFile
      ) => {
        if (credentialsProvider) await credentialsProvider();
        const file =
          manifest.stage === "windows_sign"
            ? "product.exe"
            : manifest.stage === "ios_sign"
              ? "signed.ipa"
              : manifest.stage === "finalize"
                ? "product.zip"
                : manifest.stage === "dmg_sign"
                  ? "signed.dmg"
                  : manifest.stage === "dmg_finalize"
                    ? "product.dmg"
                    : "signed.tar.gz";
        if (manifest.stage === "dmg_sign") {
          expect(templateFile).toBeTruthy();
          expect(digest(new Uint8Array(await readFile(templateFile!)))).toBe(
            manifest.template_digest
          );
        }
        const payload = new TextEncoder().encode(`simulated ${manifest.stage} output`);
        await writeFile(path.join(outputDirectory, file), payload);
        const report = verification(manifest as Record<string, unknown>, file, payload);
        await writeFile(path.join(outputDirectory, "verification.json"), JSON.stringify(report));
      },
      bundleBuilder: async (_outputDirectory, _report, work) => {
        const bytes = new TextEncoder().encode("simulated signed output archive");
        const bundlePath = path.join(work, "simulated-output.zip");
        await writeFile(bundlePath, bytes);
        return { path: bundlePath, size: bytes.byteLength, digest: digest(bytes) };
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Actions signing Worker integration", () => {
  beforeAll(async () => {
    await migrate();
    owner = await createPerson("signing-worker-integration-owner");
    repositoryId = crypto.randomUUID();
    const namespace = await signingEnv.DB.prepare(
      "SELECT id FROM namespaces WHERE created_by=? AND kind='personal'"
    )
      .bind(owner.id)
      .first<{ id: string }>();
    const now = Date.now();
    await signingEnv.DB.prepare(
      `INSERT INTO repositories(id,namespace_id,created_by,slug,do_name,visibility,description,default_branch,
        actions_enabled,actions_runner_enabled,system_kind,created_at,updated_at)
       VALUES(?,?,?,'runner',?,'private','Private account workflows and service configuration','main',1,1,'account_runner',?,?)`
    )
      .bind(repositoryId, namespace!.id, owner.id, `repo:${repositoryId}`, now, now)
      .run();
  });

  it.each([
    ["windows", "windows_sign", "zip"],
    ["ios", "ios_sign", "zip"],
    ["macos", "sign", "zip"],
    ["macos", "sign", "dmg"],
  ] as const)(
    "creates, executes, uploads, verifies, and reconciles %s (%s) with a newer server lease snapshot",
    async (platform, stage, outputFormat) => {
      const runner = await createRunner(platform);
      const sourceBytes =
        platform === "windows"
          ? new Uint8Array(8 * 1024 * 1024 + 17).fill(91)
          : new TextEncoder().encode(`validated source archive ${platform}`);
      const sourceDigest = digest(sourceBytes);
      const selectedProfile = profile(platform, stage, outputFormat);
      await signingEnv.DB.prepare(
        `INSERT INTO actions_signing_profiles(owner_id,repository_id,name,revision,profile_json,approved_by,approved_at)
       VALUES(?,?,?,?,?,?,?)`
      )
        .bind(
          owner.id,
          repositoryId,
          selectedProfile.name,
          revision,
          JSON.stringify(selectedProfile),
          owner.id,
          Date.now()
        )
        .run();
      const hooks: SigningExecutionHooks = {
        loadApprovedProfile: async (_user, _repository, name) =>
          name === selectedProfile.name ? selectedProfile : null,
        verifySource: async () => true,
        verifySourceCurrent: async () => true,
        enqueue: (input) => enqueueNativeSigningRun(signingEnv, input),
        verifyNotarization: async () => "Accepted",
        authorizeCredentials: async () => ({ credentials: {}, expiresAt: Date.now() + 5 * 60_000 }),
        verifyOutput: async () => true,
      };
      const response = await handleSigningRoute(
        new Request(`https://actions.test/signing/requests?repositoryId=${repositoryId}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `${platform}-${outputFormat}-integration-run-0001`,
          },
          body: JSON.stringify({
            profile: selectedProfile.name,
            platform,
            sourceRepositoryId: "12345",
            sourceCommitOid: commitOid,
            sourceRunId: "12345",
            sourceDigest,
            sourceSize: sourceBytes.byteLength,
            version: "1.2.3",
          }),
        }),
        signingEnv,
        trusted(owner),
        hooks
      );
      expect(response.status, await response.clone().text()).toBe(202);
      const created = (await response.json()) as {
        data: { request: { id: string; runId: string } };
      };
      const requestId = created.data.request.id;
      const partSize = 8 * 1024 * 1024;
      const firstPart = sourceBytes.slice(0, partSize);
      const invalidPart = await handleSigningRoute(
        new Request(
          `https://actions.test/signing/requests/${requestId}/source/parts/1?repositoryId=${repositoryId}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Content-Length": String(firstPart.byteLength),
              "Content-Range": `bytes 0-${firstPart.byteLength - 1}/${sourceBytes.byteLength}`,
              "X-Part-Digest": `sha256:${"0".repeat(64)}`,
            },
            body: firstPart,
          }
        ),
        signingEnv,
        trusted(owner),
        hooks
      );
      expect(invalidPart.status).toBe(422);
      for (
        let start = 0, partNumber = 1;
        start < sourceBytes.byteLength;
        start += partSize, partNumber++
      ) {
        const bytes = sourceBytes.slice(start, start + partSize);
        const part = await handleSigningRoute(
          new Request(
            `https://actions.test/signing/requests/${requestId}/source/parts/${partNumber}?repositoryId=${repositoryId}`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(bytes.byteLength),
                "Content-Range": `bytes ${start}-${start + bytes.byteLength - 1}/${sourceBytes.byteLength}`,
                "X-Part-Digest": digest(bytes),
              },
              body: bytes,
            }
          ),
          signingEnv,
          trusted(owner),
          hooks
        );
        expect(part.status, await part.clone().text()).toBe(200);
      }
      const complete = await handleSigningRoute(
        new Request(
          `https://actions.test/signing/requests/${requestId}/source/complete?repositoryId=${repositoryId}`,
          { method: "POST" }
        ),
        signingEnv,
        trusted(owner),
        hooks
      );
      expect(complete.status, await complete.clone().text()).toBe(202);
      created.data.request = (
        (await complete.json()) as { data: { request: { id: string; runId: string } } }
      ).data.request;
      const listing = await handleSigningRoute(
        new Request(
          `https://actions.test/signing/requests?repositoryId=${repositoryId}&sourceRunId=12345`
        ),
        signingEnv,
        trusted(owner),
        hooks
      );
      expect(await listing.json()).toMatchObject({
        data: {
          requests: expect.arrayContaining([
            expect.objectContaining({
              request: expect.objectContaining({ id: requestId }),
              submission: expect.objectContaining({ sourceRunId: "12345" }),
            }),
          ]),
        },
      });
      const signingRow = await signingEnv.DB.prepare(
        "SELECT generation,nonce FROM actions_signing_runs WHERE run_id=?"
      )
        .bind(created.data.request.runId)
        .first<{ generation: number; nonce: string }>();
      expect(signingRow).not.toBeNull();
      const output = await executeStage({
        profile: selectedProfile,
        requestId: created.data.request.id,
        runId: created.data.request.runId,
        runnerId: runner.runnerId,
        runnerToken: runner.runnerToken,
        leaseToken: "1".repeat(64),
        generation: signingRow!.generation,
        nonce: signingRow!.nonce,
      });
      expect(output.requestId).toBe(created.data.request.id);
      const sourceObject = await signingEnv.SIGNING_ARTIFACTS.get(
        `signing/${owner.id}/${repositoryId}/${created.data.request.id}/source.zip`
      );
      if (platform === "macos") {
        expect(sourceObject?.size).toBe(sourceBytes.byteLength);
        expect(digest(new Uint8Array(await sourceObject!.arrayBuffer()))).toBe(sourceDigest);
      } else expect(sourceObject).toBeNull();
      const stageObject = await signingEnv.SIGNING_ARTIFACTS.get(
        `signing/${owner.id}/${repositoryId}/${created.data.request.id}/${stage}.zip`
      );
      expect(stageObject).not.toBeNull();
      expect(stageObject?.size).toBeGreaterThan(0);
      expect(stageObject?.customMetadata?.sha256).toBeTruthy();
      const requestState = await signingEnv.SIGNING_COORDINATORS.getByName(owner.id).fetch(
        new Request(`https://signing.test/requests/${created.data.request.id}`, {
          headers: { "X-Signing-Owner": owner.id, "X-Signing-Repository": repositoryId },
        })
      );
      const state = (await requestState.json()) as {
        request: { state: string; outputDigest: string };
      };
      expect(state.request.state).toBe(platform === "macos" ? "awaiting_source" : "succeeded");
      if (platform === "macos") {
        const continuationStages: SigningStage[] =
          outputFormat === "dmg" ? ["finalize", "dmg_sign", "dmg_finalize"] : ["finalize"];
        let previousRunId = created.data.request.runId;
        for (let index = 0; index < continuationStages.length; index += 1) {
          const nextStage = continuationStages[index];
          await signingEnv.DB.prepare(
            "UPDATE actions_runner_runs SET status='completed',conclusion='success',completed_at=? WHERE run_id=?"
          )
            .bind(Date.now(), previousRunId)
            .run();
          const reconciled = await reconcileSigningRequests(signingEnv, hooks);
          expect(reconciled.queued).toBe(1);
          const next = await signingEnv.DB.prepare(
            "SELECT s.run_id,s.generation,s.nonce FROM actions_signing_runs s WHERE s.request_id=? AND s.stage=?"
          )
            .bind(created.data.request.id, nextStage)
            .first<{
              run_id: string;
              generation: number;
              nonce: string;
            }>();
          expect(next).not.toBeNull();
          const finalOutput = await executeStage({
            profile: selectedProfile,
            stage: nextStage,
            requestId: created.data.request.id,
            runId: next!.run_id,
            runnerId: runner.runnerId,
            runnerToken: runner.runnerToken,
            leaseToken: `${index + 2}`.repeat(64),
            generation: next!.generation,
            nonce: next!.nonce,
          });
          expect(finalOutput.requestId).toBe(created.data.request.id);
          previousRunId = next!.run_id;
        }
        const finalState = await signingEnv.SIGNING_COORDINATORS.getByName(owner.id).fetch(
          new Request(`https://signing.test/requests/${created.data.request.id}`, {
            headers: { "X-Signing-Owner": owner.id, "X-Signing-Repository": repositoryId },
          })
        );
        expect(await finalState.json()).toMatchObject({ request: { state: "succeeded" } });
        const finalObject = await signingEnv.SIGNING_ARTIFACTS.get(
          `signing/${owner.id}/${repositoryId}/${created.data.request.id}/finalize.zip`
        );
        if (outputFormat === "dmg") expect(finalObject).toBeNull();
        else expect(finalObject?.size).toBeGreaterThan(0);
        expect(
          await signingEnv.SIGNING_ARTIFACTS.head(
            `signing/${owner.id}/${repositoryId}/${created.data.request.id}/source.zip`
          )
        ).toBeNull();
      }
      const finalStage =
        platform === "macos" ? (outputFormat === "dmg" ? "dmg_finalize" : "finalize") : stage;
      const outputKey = `signing/${owner.id}/${repositoryId}/${requestId}/${finalStage}.zip`;
      expect(await signingEnv.SIGNING_ARTIFACTS.head(outputKey)).not.toBeNull();
      const deletion = await handleSigningRoute(
        new Request(
          `https://actions.test/signing/requests/${requestId}/output?repositoryId=${repositoryId}`,
          { method: "DELETE" }
        ),
        signingEnv,
        trusted(owner),
        hooks
      );
      expect(deletion.status).toBe(200);
      expect(await signingEnv.SIGNING_ARTIFACTS.head(outputKey)).toBeNull();
      if (platform === "windows") {
        const abandoned = await handleSigningRoute(
          new Request(`https://actions.test/signing/requests?repositoryId=${repositoryId}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "abandoned-source-0001",
            },
            body: JSON.stringify({
              profile: selectedProfile.name,
              platform,
              sourceRepositoryId: "12345",
              sourceCommitOid: commitOid,
              sourceRunId: "12345",
              sourceDigest,
              sourceSize: sourceBytes.byteLength,
              version: "1.2.3",
            }),
          }),
          signingEnv,
          trusted(owner),
          hooks
        );
        expect(abandoned.status).toBe(202);
        const abandonedId = ((await abandoned.json()) as { data: { request: { id: string } } }).data
          .request.id;
        const stub = signingEnv.SIGNING_COORDINATORS.getByName(owner.id);
        const uploadId = await runInDurableObject(stub, (_instance, state) => {
          const row = state.storage.sql
            .exec<{ upload_id: string; expires_at: number; created_at: number }>(
              "SELECT u.upload_id,u.expires_at,r.created_at FROM signing_source_uploads u JOIN signing_requests r ON r.id=u.request_id WHERE u.request_id=?",
              abandonedId
            )
            .one();
          expect(row.expires_at - row.created_at).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000);
          expect(row.expires_at - row.created_at).toBeLessThan(3 * 60 * 60 * 1000 + 10_000);
          state.storage.sql.exec(
            "UPDATE signing_source_uploads SET expires_at=? WHERE request_id=?",
            Date.now() - 1,
            abandonedId
          );
          return row.upload_id;
        });
        const key = `signing/${owner.id}/${repositoryId}/${abandonedId}/source.zip`;
        await signingEnv.SIGNING_ARTIFACTS.put(key, sourceBytes);
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(await signingEnv.SIGNING_ARTIFACTS.head(key)).toBeNull();
        await expect(
          signingEnv.SIGNING_ARTIFACTS.resumeMultipartUpload(key, uploadId).uploadPart(
            1,
            sourceBytes
          )
        ).rejects.toThrow();
        const failed = await stub.get(abandonedId, owner.id, repositoryId);
        expect(failed?.state).toBe("failed");
      }
    }
  );
});
