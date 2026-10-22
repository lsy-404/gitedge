import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrustedUser } from "../../packages/contracts/src/index";
import { sha256Hex } from "../../packages/contracts/src/index";
import { type RunnerEnv, type RunnerRow } from "../../workers/actions/src/runners";
import { runnerMachineRequest, runnerManagement } from "../../workers/actions/src/runners";
import {
  claimRunnerCandidate,
  listRunnerCandidates,
} from "../../workers/actions/src/runner-scheduler";
import { enqueueNativeSigningRun } from "../../workers/actions/src/signing-execution";
import { createPerson, createRepository, migrate, type Person } from "../support/stack";

let owner: Person;
let member: Person;
let collaborator: Person;
let outsider: Person;
let repositoryId: string;
let namespaceId: string;
let runnerId: string;
const runnerToken = `ge_runner_${"a".repeat(64)}`;
const actionEnv: RunnerEnv = {
  DB: env.DB,
  FORGE: { fetch: async () => Response.json({ data: {} }) },
  GIT: { fetch: async () => Response.json({ data: {} }) },
};

function trusted(person: Person, extra: Partial<TrustedUser> = {}): TrustedUser {
  return {
    id: person.id,
    identifier: person.identifier,
    groupKey: person.groupKey,
    recentAuthAt: Date.now(),
    ...extra,
  };
}

function request(path: string, method: string, body?: unknown): Request {
  return new Request(`https://actions.internal${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function approve(
  user: TrustedUser,
  id = runnerId,
  platform: "windows" | "macos" | "ios" = "windows"
): Promise<Response> {
  return runnerManagement(
    request(`/runners/${id}/signing`, "POST", {
      platform,
      dedicatedHostConfirmed: true,
    }),
    actionEnv,
    user
  );
}

beforeAll(async () => {
  await migrate();
  owner = await createPerson("signing-runner-owner");
  member = await createPerson("signing-runner-member");
  collaborator = await createPerson("signing-runner-collaborator");
  outsider = await createPerson("signing-runner-outsider");
  repositoryId = await createRepository(owner, "signing-runner-test");
  const repo = await env.DB.prepare("SELECT namespace_id FROM repositories WHERE id=?")
    .bind(repositoryId)
    .first<{ namespace_id: string }>();
  namespaceId = repo!.namespace_id;
  await env.DB.prepare(
    "UPDATE repositories SET slug='runner',system_kind='account_runner',actions_enabled=1,actions_runner_enabled=1 WHERE id=?"
  )
    .bind(repositoryId)
    .run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id,user_id,role,created_at) VALUES (?,?,'member',?)"
    ).bind(namespaceId, member.id, Date.now()),
    env.DB.prepare(
      "INSERT INTO repository_collaborators (repository_id,user_id,role,created_at) VALUES (?,?,'admin',?)"
    ).bind(repositoryId, collaborator.id, Date.now()),
  ]);
  runnerId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
     VALUES (?,'signing-node',?,?,?,'["windows","signing"]',?,?)`
  )
    .bind(runnerId, namespaceId, repositoryId, owner.id, await sha256Hex(runnerToken), Date.now())
    .run();
});

describe("owner-approved signing runner execution class", () => {
  it("requires a recent human owner session and rejects members, collaborators, outsiders, and admin tokens", async () => {
    const noRecent = await approve(trusted(owner, { recentAuthAt: 0 }));
    expect(noRecent.status).toBe(403);
    for (const person of [member, collaborator, outsider]) {
      const denied = await approve(trusted(person));
      expect(denied.status).toBe(404);
    }
    const tokenDenied = await approve(trusted(owner, { token: { id: "pat", scopes: ["admin"] } }));
    expect(tokenDenied.status).toBe(403);
  });

  it("stores owner approval on the exact private Runner registration", async () => {
    const response = await approve(trusted(owner));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        runner: { executionClass: string; signingPlatform: string; operatorApprovedBy: string };
      };
    };
    expect(body.data.runner).toMatchObject({
      executionClass: "signing",
      signingPlatform: "windows",
      operatorApprovedBy: owner.id,
    });
    const immutable = await env.DB.prepare(
      "SELECT system_kind,visibility,created_by FROM repositories WHERE id=?"
    )
      .bind(repositoryId)
      .first<{ system_kind: string; visibility: string; created_by: string }>();
    expect(immutable).toEqual({
      system_kind: "account_runner",
      visibility: "private",
      created_by: owner.id,
    });
  });

  it("reuses the same queued run after an enqueue response is retried", async () => {
    expect((await approve(trusted(owner))).status).toBe(200);
    const row = await env.DB.prepare("SELECT operator_approved_at FROM actions_runners WHERE id=?")
      .bind(runnerId)
      .first<{ operator_approved_at: number }>();
    const input = {
      requestId: crypto.randomUUID(),
      ownerId: owner.id,
      repositoryId,
      workflowOid: "e".repeat(40),
      workflowPath: ".gitedge/signing/release.yml",
      workflowSource: "trusted-source",
      stage: "sign" as const,
      inputDigest: `sha256:${"b".repeat(64)}`,
      platform: "windows" as const,
      generation: 1,
      nonce: "c".repeat(43),
      timeoutMinutes: 60,
      sourceDigest: `sha256:${"b".repeat(64)}`,
      profileRevision: "d".repeat(40),
      operatorApproval: {
        operatorApproved: true as const,
        approvedBy: owner.id,
        approvedAt: row!.operator_approved_at,
      },
    };
    const first = await enqueueNativeSigningRun(actionEnv, input);
    const retried = await enqueueNativeSigningRun(actionEnv, input);
    expect(retried).toEqual(first);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM actions_signing_runs WHERE request_id=?"
    )
      .bind(input.requestId)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("does not count completed signing continuation stages against hourly admission", async () => {
    expect((await approve(trusted(owner))).status).toBe(200);
    const approval = await env.DB.prepare(
      "SELECT operator_approved_at FROM actions_runners WHERE id=?"
    )
      .bind(runnerId)
      .first<{ operator_approved_at: number }>();
    const now = Date.now();
    const admittedRequestId = crypto.randomUUID();
    for (let index = 0; index < 6; index += 1) {
      const runId = crypto.randomUUID();
      const requestId = index === 0 ? admittedRequestId : crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
           VALUES(?,?,?,'windows_sign','/.gitedge/signing/release.yml','main',?,?, 'workflow_dispatch','runner')`
        ).bind(runId, repositoryId, `${index}`.repeat(40), owner.id, now + index),
        env.DB.prepare(
          `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
           VALUES(?,'workflow','[]','read',60,'{}')`
        ).bind(runId),
        env.DB.prepare(
          `INSERT INTO actions_signing_runs(run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
            operator_approved_by,operator_approved_at,generation,nonce,created_at)
          VALUES(?,?,?,?,?,?,'windows','windows_sign',?,?,?,1,?,?)`
        ).bind(
          runId,
          requestId,
          owner.id,
          repositoryId,
          "d".repeat(40),
          "e".repeat(40),
          `sha256:${"b".repeat(64)}`,
          owner.id,
          approval!.operator_approved_at,
          `${String(index).padStart(1, "0")}${"f".repeat(42)}`,
          now + index
        ),
      ]);
    }
    const run = await enqueueNativeSigningRun(actionEnv, {
      requestId: admittedRequestId,
      ownerId: owner.id,
      repositoryId,
      workflowOid: "e".repeat(40),
      workflowPath: ".github/workflows/release.yml",
      workflowSource: "trusted workflow",
      stage: "finalize",
      inputDigest: `sha256:${"c".repeat(64)}`,
      platform: "windows",
      generation: 2,
      nonce: "g".repeat(43),
      timeoutMinutes: 60,
      sourceDigest: `sha256:${"c".repeat(64)}`,
      profileRevision: "d".repeat(40),
      operatorApproval: {
        operatorApproved: true,
        approvedBy: owner.id,
        approvedAt: approval!.operator_approved_at,
      },
    });
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("does not allow a machine or direct database insert to self-promote a registration", async () => {
    const id = crypto.randomUUID();
    await expect(
      env.DB.prepare(
        `INSERT INTO actions_runners
         (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at,execution_class,signing_platform,dedicated_host_confirmed,operator_approved_at,operator_approved_by)
         VALUES (?,'forged-signing-node',?,?,?,'["windows"]',?,?,'signing','windows',1,?,?)`
      )
        .bind(
          id,
          namespaceId,
          repositoryId,
          owner.id,
          `hash-${id}`,
          Date.now(),
          Date.now(),
          owner.id
        )
        .run()
    ).rejects.toThrow();
  });

  it("requires claim execution class to match the authoritative registration", async () => {
    const url = "https://actions.internal/runner/claim";
    const missingClass = await runnerMachineRequest(
      new Request(url, { method: "POST", headers: { Authorization: `Bearer ${runnerToken}` } }),
      actionEnv
    );
    expect(missingClass.status).toBe(409);
    const spoofedClass = await runnerMachineRequest(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Execution-Class": "ordinary",
        },
      }),
      actionEnv
    );
    expect(spoofedClass.status).toBe(409);
  });

  it("does not let ordinary labels claim a signing binding, while normal work remains claimable", async () => {
    expect((await approve(trusted(owner))).status).toBe(200);
    const now = Date.now();
    const signingRunId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const ordinaryRunId = crypto.randomUUID();
    const digest = `sha256:${"b".repeat(64)}`;
    const approval = await env.DB.prepare(
      "SELECT operator_approved_at FROM actions_runners WHERE id=?"
    )
      .bind(runnerId)
      .first<{ operator_approved_at: number }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'sign','/.gitedge/signing/sign.yml','main',?,?, 'workflow_dispatch','runner')`
      ).bind(signingRunId, repositoryId, "c".repeat(40), owner.id, now),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'workflow','["windows","signing"]','read',60,'{}')`
      ).bind(signingRunId),
      env.DB.prepare(
        `INSERT INTO actions_signing_runs(run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
          operator_approved_by,operator_approved_at,generation,nonce,created_at)
         VALUES(?,?,?,?,?,?,'windows','windows_sign',?,?,?,1,?,?)`
      ).bind(
        signingRunId,
        requestId,
        owner.id,
        repositoryId,
        "d".repeat(40),
        "e".repeat(40),
        digest,
        owner.id,
        approval!.operator_approved_at,
        "f".repeat(43),
        now
      ),
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'CI','.github/workflows/ci.yml','main',?,?, 'workflow_dispatch','runner')`
      ).bind(ordinaryRunId, repositoryId, "1".repeat(40), owner.id, now + 1),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'workflow','["windows","signing"]','read',60,'{}')`
      ).bind(ordinaryRunId),
    ]);
    const ordinaryRunnerId = crypto.randomUUID();
    const ordinaryToken = `ge_runner_${"c".repeat(64)}`;
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'ordinary-node',?,?,?,'["windows","signing"]',?,?)`
    )
      .bind(
        ordinaryRunnerId,
        namespaceId,
        repositoryId,
        owner.id,
        await sha256Hex(ordinaryToken),
        now
      )
      .run();
    const ordinary = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(ordinaryRunnerId)
      .first<RunnerRow>();
    const candidates = await listRunnerCandidates(actionEnv, ordinary!);
    expect(candidates.map((candidate) => candidate.id)).toEqual([ordinaryRunId]);
    expect(candidates.map((candidate) => candidate.execution_class)).toEqual(["ordinary"]);
    const signingRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(runnerId)
      .first<RunnerRow>();
    const signingCandidate = (await listRunnerCandidates(actionEnv, signingRunner!)).find(
      (candidate) => candidate.id === signingRunId
    )!;
    const otherPlatformId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'other-platform-node',?,?,?,'["windows"]',?,?)`
    )
      .bind(otherPlatformId, namespaceId, repositoryId, owner.id, `hash-${otherPlatformId}`, now)
      .run();
    expect((await approve(trusted(owner), otherPlatformId, "macos")).status).toBe(200);
    const otherPlatformRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(otherPlatformId)
      .first<RunnerRow>();
    expect(
      (await listRunnerCandidates(actionEnv, otherPlatformRunner!)).some(
        (candidate) => candidate.id === signingRunId
      )
    ).toBe(false);
    expect(
      await claimRunnerCandidate(
        actionEnv,
        ordinary!,
        signingCandidate,
        60,
        "a".repeat(64),
        now + 2,
        null
      )
    ).toBe(false);
    expect(
      await claimRunnerCandidate(
        actionEnv,
        ordinary!,
        candidates[0]!,
        60,
        "b".repeat(64),
        now + 3,
        null
      )
    ).toBe(true);
    const signingLeaseToken = "9".repeat(64);
    const signingLeaseHash = await sha256Hex(signingLeaseToken);
    expect(
      await claimRunnerCandidate(
        actionEnv,
        signingRunner!,
        signingCandidate,
        60,
        signingLeaseHash,
        Date.now(),
        null
      )
    ).toBe(true);
    const outputBytes = new TextEncoder().encode("verified signing archive");
    const outputDigest = `sha256:${await sha256Hex(new TextDecoder().decode(outputBytes))}`;
    const outputKey = `signing/${owner.id}/${repositoryId}/${requestId}/output.zip`;
    const profileRevision = "d".repeat(40);
    const signingProfile = {
      name: "release",
      revision: profileRevision,
      policyDigest: `sha256:${"f".repeat(64)}`,
      workflowOid: "e".repeat(40),
      workflowPath: ".github/workflows/sign.yml",
      workflowSource: "name: signing\non: workflow_dispatch\njobs: {}\n",
      platform: "windows",
      timeoutMinutes: 60,
      enabled: true,
      policy: {
        stage: "windows_sign",
        windowsIdentity: "azure-workload-identity",
        project: {
          id: "release",
          enabled: true,
          max_artifact_bytes: 1024,
          windows: {
            bundle_id: "com.example.app",
            architecture: "x64",
            max_unpacked_bytes: 2048,
            product_name: "Example",
            electron_version: "1.2.3",
            executable_name: "example.exe",
            installer: "nsis",
            portable: false,
          },
        },
        sourceRepositories: [
          {
            id: "1",
            fullName: "example/source",
            workflowPath: ".github/workflows/ci.yml",
            artifactName: "release",
            actorIds: [1],
            events: ["workflow_run"],
            refs: ["refs/heads/main"],
          },
        ],
        azure: {
          endpoint: "https://example.codesigning.azure.net/",
          account: "example",
          certificate_profile: "release",
          subject: "CN=Example Publisher",
        },
      },
    };
    const machineEnv = {
      ...actionEnv,
      SIGNING_COORDINATORS: {
        getByName: () => ({
          fetch: async (rpc: Request) => {
            const operation = new URL(rpc.url).pathname.split("/").at(-1);
            const body = (await rpc.json()) as {
              context?: { requestId: string };
              payload?: unknown;
            };
            if (operation === "profile")
              return Response.json({
                data: {
                  profile: signingProfile,
                  sourceDigest: digest,
                  sourceCommitOid: "e".repeat(40),
                  version: "1.2.3",
                },
              });
            if (operation === "output-target")
              return Response.json({
                data: { key: outputKey, digest: outputDigest, size: outputBytes.length },
              });
            if (operation === "complete")
              return Response.json({ data: { state: "awaiting_source" } });
            if (operation === "fail") return Response.json({ data: { state: "failed" } });
            return Response.json({
              data: {
                state: "running",
                manifest: {
                  schema_version: 1,
                  request_id: requestId,
                  generation: 1,
                  stage: "windows_sign",
                  project_id: "release",
                  version: "1.2.3",
                  source_sha: "e".repeat(40),
                  input_digest: digest,
                  recipe_sha: "e".repeat(40),
                  policy_digest: `sha256:${"f".repeat(64)}`,
                  bundle_id: "com.example.app",
                  architecture: "x64",
                  windows: {
                    product_name: "Example",
                    electron_version: "1.2.3",
                    executable_name: "example.exe",
                    installer: "nsis",
                    portable: false,
                  },
                  azure: {
                    endpoint: "https://example.codesigning.azure.net/",
                    account: "example",
                    certificate_profile: "release",
                    subject: "CN=Example Publisher",
                  },
                  identity_mode: "azure-workload-identity",
                  max_artifact_bytes: 1024,
                  max_unpacked_bytes: 2048,
                },
              },
            });
          },
        }),
      },
      SIGNING_ARTIFACTS: {
        get: async (key: string) =>
          key === outputKey
            ? { size: outputBytes.length, body: new Blob([outputBytes]).stream() }
            : null,
      } as unknown as R2Bucket,
      SIGNING_ENCRYPTION_KEY: "unused",
    } as RunnerEnv;
    const signingUrl = `https://actions.internal/runner/signing/requests/${requestId}/start`;
    const wrongLease = await runnerMachineRequest(
      new Request(signingUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": "8".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId: outsider.id, repositoryId: "forged" }),
      }),
      machineEnv
    );
    expect(wrongLease.status).toBe(403);
    const validLease = await runnerMachineRequest(
      new Request(signingUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": signingLeaseToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId: outsider.id, repositoryId: "forged" }),
      }),
      machineEnv
    );
    expect(validLease.status).toBe(200);
    const report = {
      schema_version: 1,
      request_id: requestId,
      generation: 1,
      stage: "windows_sign",
      input_digest: digest,
      recipe_sha: signingProfile.workflowOid,
      policy_digest: signingProfile.policyDigest,
      bundle_id: "com.example.app",
      version: "1.2.3",
      architecture: "x64",
      subject: "CN=Example Publisher",
      authenticode_verified: true,
      timestamp_verified: true,
      nested_signatures_verified: true,
      files: [{ path: "product.exe", size: 1, sha256: "1".repeat(64) }],
    };
    const completed = await runnerMachineRequest(
      new Request(`https://actions.internal/runner/signing/requests/${requestId}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": signingLeaseToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          digest: outputDigest,
          size: outputBytes.length,
          verificationReport: report,
        }),
      }),
      machineEnv
    );
    expect(completed.status).toBe(202);
    const completedReplay = await runnerMachineRequest(
      new Request(`https://actions.internal/runner/signing/requests/${requestId}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": signingLeaseToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          digest: outputDigest,
          size: outputBytes.length,
          verificationReport: report,
        }),
      }),
      machineEnv
    );
    expect(completedReplay.status).toBe(202);
    const persisted = await env.DB.prepare(
      "SELECT status,conclusion,completed_at FROM actions_runner_runs WHERE run_id=?"
    )
      .bind(signingRunId)
      .first<{ status: string; conclusion: string; completed_at: number | null }>();
    expect(persisted).toMatchObject({ status: "completed", conclusion: "success" });
    expect(persisted?.completed_at).toBeTypeOf("number");
    const failedRunId = crypto.randomUUID();
    const failedRequestId = crypto.randomUUID();
    const failedLeaseToken = "7".repeat(64);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'sign','/.gitedge/signing/sign.yml','main',?,?, 'workflow_dispatch','runner')`
      ).bind(failedRunId, repositoryId, "2".repeat(40), owner.id, Date.now()),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'workflow','["windows","signing"]','read',60,'{}')`
      ).bind(failedRunId),
      env.DB.prepare(
        `INSERT INTO actions_signing_runs(run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
          operator_approved_by,operator_approved_at,generation,nonce,created_at)
         VALUES(?,?,?,?,?,?,'windows','windows_sign',?,?,?,1,?,?)`
      ).bind(
        failedRunId,
        failedRequestId,
        owner.id,
        repositoryId,
        profileRevision,
        "e".repeat(40),
        digest,
        owner.id,
        approval!.operator_approved_at,
        "g".repeat(43),
        Date.now()
      ),
    ]);
    const failedCandidate = (await listRunnerCandidates(actionEnv, signingRunner!)).find(
      (candidate) => candidate.id === failedRunId
    )!;
    expect(
      await claimRunnerCandidate(
        actionEnv,
        signingRunner!,
        failedCandidate,
        60,
        await sha256Hex(failedLeaseToken),
        Date.now(),
        null
      )
    ).toBe(true);
    const failRequest = () =>
      runnerMachineRequest(
        new Request(`https://actions.internal/runner/signing/requests/${failedRequestId}/fail`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${runnerToken}`,
            "X-Runner-Run-Id": failedRunId,
            "X-Runner-Lease-Token": failedLeaseToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: "execution_failed" }),
        }),
        machineEnv
      );
    expect((await failRequest()).status).toBe(200);
    expect((await failRequest()).status).toBe(200);
    const failedPersisted = await env.DB.prepare(
      "SELECT status,conclusion FROM actions_runner_runs WHERE run_id=?"
    )
      .bind(failedRunId)
      .first<{ status: string; conclusion: string }>();
    expect(failedPersisted).toEqual({ status: "completed", conclusion: "failure" });
    const revoked = await runnerManagement(
      request(`/runners/${runnerId}/signing`, "DELETE"),
      actionEnv,
      trusted(owner)
    );
    expect(revoked.status).toBe(200);
    const afterRevocation = await runnerMachineRequest(
      new Request(signingUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runnerToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": signingLeaseToken,
        },
      }),
      machineEnv
    );
    expect(afterRevocation.status).toBe(403);
  });
});
