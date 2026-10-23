import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { TrustedUser } from "../../packages/contracts/src/index";
import { sha256Hex } from "../../packages/contracts/src/index";
import type { RunnerCapacity } from "../../packages/contracts/src/runners";
import {
  claimSpecificCandidate,
  runnerMachineRequest,
  runnerManagement,
  runnersSelect,
  storeRunnerReport,
  type ClaimedJob,
  type RunnerEnv,
  type RunnerRow,
} from "../../workers/actions/src/runners";
import {
  claimRunnerCandidate,
  evaluateRunnerCandidate,
  listRunnerCandidates,
} from "../../workers/actions/src/runner-scheduler";
import { enqueueNativeSigningRun } from "../../workers/actions/src/signing-execution";
import { createPerson, createRepository, migrate, type Person } from "../support/stack";

let owner: Person;
let repositoryId: string;
let namespaceId: string;
let runnerId: string;
const runnerToken = `ge_runner_${"a".repeat(64)}`;
const actionEnv: RunnerEnv = {
  DB: env.DB,
  FORGE: { fetch: async () => Response.json({ data: {} }) },
  GIT: { fetch: async () => Response.json({ data: {} }) },
};

// Mirrors one dispatch pass for a single connected runner: report, list, evaluate, commit.
async function claimThroughScheduler(
  claimEnv: RunnerEnv,
  id: string,
  capacity: RunnerCapacity
): Promise<ClaimedJob | null> {
  const stored = await env.DB.prepare(`${runnersSelect} WHERE r.id=?`).bind(id).first<RunnerRow>();
  await storeRunnerReport(claimEnv, stored!, capacity, null, Date.now());
  const runner = await env.DB.prepare(`${runnersSelect} WHERE r.id=?`).bind(id).first<RunnerRow>();
  for (const candidate of await listRunnerCandidates(claimEnv, runner!)) {
    const evaluated = evaluateRunnerCandidate(runner!, capacity, null, 0, candidate);
    if (evaluated.reasons.length) continue;
    const outcome = await claimSpecificCandidate(
      claimEnv,
      runner!,
      candidate,
      evaluated,
      Date.now()
    );
    if (outcome.kind === "claimed") return outcome.claim;
  }
  return null;
}

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

const profileRevision = "d".repeat(40);
const signingWorkflowSource = `name: signing\non: workflow_dispatch\njobs:\n  sign:\n    runs-on: [self-hosted, Windows, ci, need-time-5m, need-mem-2g, need-cpu-2, need-tool-python]\n    steps:\n      - run: echo signing\n`;
const signingProfile = {
  name: "release",
  revision: profileRevision,
  policyDigest: `sha256:${"f".repeat(64)}`,
  workflowOid: "e".repeat(40),
  workflowPath: ".github/workflows/sign.yml",
  workflowSource: signingWorkflowSource,
  platform: "windows",
  timeoutMinutes: 60,
  enabled: true,
  policy: {
    stage: "windows_sign",
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

beforeAll(async () => {
  await migrate();
  owner = await createPerson("signing-runner-owner");
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
  await env.DB.prepare(
    `INSERT INTO actions_signing_profiles(owner_id,repository_id,name,revision,profile_json,approved_by,approved_at)
     VALUES(?,?,?,?,?,?,?)`
  )
    .bind(
      owner.id,
      repositoryId,
      signingProfile.name,
      profileRevision,
      JSON.stringify(signingProfile),
      owner.id,
      Date.now()
    )
    .run();
  runnerId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
     VALUES (?,'signing-node',?,?,?,'["self-hosted","Windows","ci"]',?,?)`
  )
    .bind(runnerId, namespaceId, repositoryId, owner.id, await sha256Hex(runnerToken), Date.now())
    .run();
});

describe("general-purpose native signing execution", () => {
  it("lets a scope owner replace custom routing labels without changing system labels", async () => {
    const scopedRunnerId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'tagged-node',?,?,?,'["self-hosted","Windows","x64","old-tag"]',?,?)`
    )
      .bind(
        scopedRunnerId,
        namespaceId,
        repositoryId,
        owner.id,
        await sha256Hex(`ge_runner_${"b".repeat(64)}`),
        Date.now()
      )
      .run();
    const update = (user: TrustedUser, labels: string[]) =>
      runnerManagement(
        request(`/runners/${scopedRunnerId}/labels`, "PUT", { labels }),
        actionEnv,
        user
      );

    const response = await update(trusted(owner), ["server-tokyo", "ip-residential"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { labels: ["self-hosted", "Windows", "x64", "server-tokyo", "ip-residential"] },
    });
    const stored = await env.DB.prepare("SELECT labels_json FROM actions_runners WHERE id=?")
      .bind(scopedRunnerId)
      .first<{ labels_json: string }>();
    expect(JSON.parse(stored!.labels_json)).toEqual([
      "self-hosted",
      "Windows",
      "x64",
      "server-tokyo",
      "ip-residential",
    ]);

    expect((await update(trusted(owner), ["self-hosted", "ip-datacenter"])).status).toBe(400);
    expect((await update(trusted(owner), ["Windows", "ip-datacenter"])).status).toBe(400);
    expect((await update(trusted(owner), ["need-mem-2g"])).status).toBe(400);
    expect((await update(trusted(owner), ["RAM-2G"])).status).toBe(400);
    expect((await update(trusted(owner), ["GPU-NVIDIA"])).status).toBe(400);
    expect((await update(trusted(owner), ["duplicate", "DUPLICATE"])).status).toBe(400);
    const cleared = await update(trusted(owner), []);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      data: { labels: ["self-hosted", "Windows", "x64"] },
    });
    const outsider = await createPerson("runner-label-outsider");
    expect((await update(trusted(outsider), ["ip-mobile"])).status).toBe(404);
  });

  it("reuses the same queued run after an enqueue response is retried", async () => {
    const input = {
      requestId: crypto.randomUUID(),
      ownerId: owner.id,
      repositoryId,
      workflowOid: "e".repeat(40),
      workflowPath: ".github/workflows/sign.yml",
      workflowSource: signingWorkflowSource,
      stage: "sign" as const,
      inputDigest: `sha256:${"b".repeat(64)}`,
      platform: "windows" as const,
      generation: 1,
      nonce: "c".repeat(43),
      timeoutMinutes: 60,
      sourceDigest: `sha256:${"b".repeat(64)}`,
      profileRevision: "d".repeat(40),
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
    const queuedRun = await env.DB.prepare(
      "SELECT labels_json,timeout_minutes,workflow_source FROM actions_runner_runs WHERE run_id=?"
    )
      .bind(first.runId)
      .first<{ labels_json: string; timeout_minutes: number; workflow_source: string }>();
    const queuedLabels = JSON.parse(queuedRun!.labels_json) as string[];
    expect(queuedLabels).toEqual(
      expect.arrayContaining([
        "windows",
        "ci",
        "need-time-60m",
        "need-mem-2g",
        "need-cpu-2",
        "need-tool-python",
      ])
    );
    expect(queuedLabels).not.toContain("need-time-5m");
    expect(queuedRun!.timeout_minutes).toBe(60);
    expect(queuedRun!.workflow_source).toBe(signingWorkflowSource);
    const schedulerRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(runnerId)
      .first<RunnerRow>();
    const candidates = await listRunnerCandidates(actionEnv, schedulerRunner!);
    expect(candidates.map((entry) => entry.id)).toContain(first.runId);
    const candidate = candidates.find((entry) => entry.id === first.runId);
    const evaluated = evaluateRunnerCandidate(
      schedulerRunner!,
      {
        os: "windows",
        arch: "x64",
        cpus: 4,
        memTotalMb: 8192,
        memFreeMb: 4096,
        diskFreeMb: 20_000,
        load1: 0,
        tools: ["node", "python"],
      },
      null,
      0,
      candidate!
    );
    expect(evaluated.claim.minutes).toBe(60);
    await expect(
      enqueueNativeSigningRun(actionEnv, {
        ...input,
        requestId: crypto.randomUUID(),
        workflowSource: signingWorkflowSource.replace("need-tool-python", "need-tool-invalid!"),
      })
    ).rejects.toThrow("literal runs-on labels");
    await expect(
      enqueueNativeSigningRun(actionEnv, {
        ...input,
        requestId: crypto.randomUUID(),
        workflowSource: signingWorkflowSource.replace("need-time-5m", "need-time-999m"),
      })
    ).rejects.toThrow("invalid_signing_workflow_requirements");
    await env.DB.prepare(
      "UPDATE actions_runner_runs SET status='completed',conclusion='success',completed_at=? WHERE run_id=?"
    )
      .bind(Date.now(), first.runId)
      .run();
  });

  it("returns the authoritative registration labels with an ordinary workflow claim", async () => {
    const runId = crypto.randomUUID();
    const customRunnerId = crypto.randomUUID();
    const runnerToken = `ge_runner_${"d".repeat(64)}`;
    const jobToken = `ge_job_${"e".repeat(64)}`;
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'build','.github/workflows/build.yml','refs/heads/main',?,?,'workflow_dispatch','runner')`
      ).bind(runId, repositoryId, "a".repeat(40), owner.id, now),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'name: build','["self-hosted","Windows","device","ip-residential"]','read',30,'{}')`
      ).bind(runId),
      env.DB.prepare(
        `INSERT INTO actions_runners(id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
         VALUES(?,'tagged-workflow-runner',?,?,?,'["self-hosted","Windows","x64","old-tag"]',?,?)`
      ).bind(
        customRunnerId,
        namespaceId,
        repositoryId,
        owner.id,
        await sha256Hex(runnerToken),
        now
      ),
    ]);
    const updated = await runnerManagement(
      request(`/runners/${customRunnerId}/labels`, "PUT", {
        labels: ["device", "ip-residential"],
      }),
      actionEnv,
      trusted(owner)
    );
    expect(updated.status).toBe(200);
    const staleRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(customRunnerId)
      .first<RunnerRow>();
    const candidate = (await listRunnerCandidates(actionEnv, staleRunner!)).find(
      (item) => item.id === runId
    );
    if (!candidate) throw new Error("The tagged workflow was not a scheduler candidate.");
    await env.DB.prepare("UPDATE actions_runners SET labels_json=? WHERE id=?")
      .bind(JSON.stringify(["self-hosted", "Windows", "x64"]), customRunnerId)
      .run();
    expect(
      await claimRunnerCandidate(
        actionEnv,
        staleRunner!,
        candidate,
        30,
        "b".repeat(64),
        now + 1,
        null
      )
    ).toBe(false);
    expect(
      await env.DB.prepare("SELECT status FROM actions_runner_runs WHERE run_id=?")
        .bind(runId)
        .first<{ status: string }>()
    ).toEqual({ status: "queued" });
    await runnerManagement(
      request(`/runners/${customRunnerId}/labels`, "PUT", {
        labels: ["device", "ip-residential"],
      }),
      actionEnv,
      trusted(owner)
    );
    const claimed = await claimThroughScheduler(
      {
        ...actionEnv,
        AUTH: {
          fetch: async () => {
            await env.DB.prepare(
              "INSERT INTO actions_job_tokens(run_id,token_hash,expires_at) VALUES(?,?,?)"
            )
              .bind(runId, await sha256Hex(jobToken), Date.now() + 60_000)
              .run();
            return Response.json({ data: { token: jobToken } });
          },
        },
      },
      customRunnerId,
      {
        os: "windows",
        arch: "x64",
        cpus: 2,
        load1: 0,
        memTotalMb: 4096,
        memFreeMb: 2048,
        diskFreeMb: 20_000,
        tools: ["node"],
        slots: 1,
        busy: 0,
      }
    );
    expect(claimed).toMatchObject({
      run: { id: runId, kind: "workflow" },
      runnerLabels: ["self-hosted", "Windows", "x64", "device", "ip-residential"],
    });
  });

  it("admits more than six approved native signing requests in an hour", async () => {
    const now = Date.now();
    const runIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const requestId = crypto.randomUUID();
      const result = await enqueueNativeSigningRun(actionEnv, {
        requestId,
        ownerId: owner.id,
        repositoryId,
        workflowOid: "e".repeat(40),
        workflowPath: ".github/workflows/sign.yml",
        workflowSource: signingWorkflowSource,
        stage: "windows_sign",
        inputDigest: `sha256:${String(index).padStart(64, "0")}`,
        platform: "windows",
        generation: 1,
        nonce: `${String(index).padStart(1, "0")}${"c".repeat(42)}`,
        timeoutMinutes: 60,
        sourceDigest: `sha256:${String(index).padStart(64, "0")}`,
        profileRevision,
      });
      runIds.push(result.runId);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM actions_signing_runs WHERE run_id IN (SELECT id FROM actions_runs WHERE repository_id=? AND created_at>=?) AND stage='windows_sign'"
    )
      .bind(repositoryId, now - 1000)
      .first<{ count: number }>();
    expect(new Set(runIds)).toHaveProperty("size", 7);
    expect(count?.count).toBeGreaterThanOrEqual(7);
  });

  it("requires an admitted initial request before queueing a continuation stage", async () => {
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
            generation,nonce,created_at)
          VALUES(?,?,?,?,?,?,'windows','windows_sign',?,1,?,?)`
        ).bind(
          runId,
          requestId,
          owner.id,
          repositoryId,
          "d".repeat(40),
          "e".repeat(40),
          `sha256:${"b".repeat(64)}`,
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
      workflowSource: signingWorkflowSource,
      stage: "finalize",
      inputDigest: `sha256:${"c".repeat(64)}`,
      platform: "windows",
      generation: 2,
      nonce: "g".repeat(43),
      timeoutMinutes: 60,
      sourceDigest: `sha256:${"c".repeat(64)}`,
      profileRevision: "d".repeat(40),
    });
    expect(run.runId).toMatch(/^[0-9a-f-]{36}$/i);
    await expect(
      enqueueNativeSigningRun(actionEnv, {
        requestId: crypto.randomUUID(),
        ownerId: owner.id,
        repositoryId,
        workflowOid: "e".repeat(40),
        workflowPath: ".github/workflows/release.yml",
        workflowSource: signingWorkflowSource,
        stage: "finalize",
        inputDigest: `sha256:${"c".repeat(64)}`,
        platform: "windows",
        generation: 2,
        nonce: "g".repeat(43),
        timeoutMinutes: 60,
        sourceDigest: `sha256:${"c".repeat(64)}`,
        profileRevision: "d".repeat(40),
      })
    ).rejects.toThrow("signing_initial_stage_not_admitted");
  });

  it("uses the same generic registrations for signing and normal work while binding each lease", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE actions_runner_runs SET status='completed',conclusion='success',completed_at=? WHERE status='queued' AND run_id IN (SELECT id FROM actions_runs WHERE repository_id=?)"
    )
      .bind(now, repositoryId)
      .run();
    const signingRunId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const ordinaryRunId = crypto.randomUUID();
    const digest = `sha256:${"b".repeat(64)}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'sign','/.gitedge/signing/sign.yml','main',?,?, 'workflow_dispatch','runner')`
      ).bind(signingRunId, repositoryId, "c".repeat(40), owner.id, now),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'workflow','["self-hosted","Windows","ci"]','read',60,'{}')`
      ).bind(signingRunId),
      env.DB.prepare(
        `INSERT INTO actions_signing_runs(run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
          generation,nonce,created_at)
         VALUES(?,?,?,?,?,?,'windows','windows_sign',?,1,?,?)`
      ).bind(
        signingRunId,
        requestId,
        owner.id,
        repositoryId,
        "d".repeat(40),
        "e".repeat(40),
        digest,
        "f".repeat(43),
        now
      ),
      env.DB.prepare(
        `INSERT INTO actions_runs(id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
         VALUES(?,?,?,'CI','.github/workflows/ci.yml','main',?,?, 'workflow_dispatch','runner')`
      ).bind(ordinaryRunId, repositoryId, "1".repeat(40), owner.id, now + 1),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
         VALUES(?,'workflow','["self-hosted","Windows","ci"]','read',60,'{}')`
      ).bind(ordinaryRunId),
    ]);
    const ordinaryRunnerId = crypto.randomUUID();
    const ordinaryToken = `ge_runner_${"c".repeat(64)}`;
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'ordinary-node',?,?,?,'["self-hosted","Windows","ci"]',?,?)`
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
    const candidates = (await listRunnerCandidates(actionEnv, ordinary!)).filter((candidate) =>
      [signingRunId, ordinaryRunId].includes(candidate.id)
    );
    expect(candidates.map((candidate) => candidate.id)).toEqual([signingRunId, ordinaryRunId]);
    expect(candidates.map((candidate) => candidate.execution_kind)).toEqual([
      "signing",
      "workflow",
    ]);
    const signingRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(runnerId)
      .first<RunnerRow>();
    const otherPlatformId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'other-platform-node',?,?,?,'["macOS"]',?,?)`
    )
      .bind(otherPlatformId, namespaceId, repositoryId, owner.id, `hash-${otherPlatformId}`, now)
      .run();
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
        candidates.find((candidate) => candidate.id === ordinaryRunId)!,
        60,
        "b".repeat(64),
        now + 3,
        null
      )
    ).toBe(true);
    const signingJobToken = `ge_job_${"a".repeat(64)}`;
    const signingClaim = await claimThroughScheduler(
      {
        ...actionEnv,
        AUTH: {
          fetch: async (request: Request) => {
            expect(new URL(request.url).pathname).toBe("/internal/actions-job-token");
            await env.DB.prepare(
              "INSERT INTO actions_job_tokens(run_id,token_hash,expires_at) VALUES(?,?,?)"
            )
              .bind(signingRunId, await sha256Hex(signingJobToken), Date.now() + 60_000)
              .run();
            return Response.json({ data: { token: signingJobToken } });
          },
        },
      },
      runnerId,
      {
        os: "windows",
        arch: "x64",
        cpus: 4,
        load1: 0,
        memTotalMb: 8192,
        memFreeMb: 4096,
        diskFreeMb: 100000,
        tools: [],
        slots: 1,
        busy: 0,
      }
    );
    if (!signingClaim) throw new Error("The signing job was not claimed.");
    const jobTokenCannotConnect = await runnerMachineRequest(
      new Request("https://actions.internal/runner/connect", {
        headers: { Authorization: `Bearer ${signingJobToken}`, Upgrade: "websocket" },
      }),
      actionEnv
    );
    expect(jobTokenCannotConnect.status).toBe(401);
    const signingLeaseToken = signingClaim.leaseToken;
    expect(signingClaim.run).toMatchObject({
      kind: "signing",
      token: signingJobToken,
      repository: "signing-runner-owner/runner",
      sha: "c".repeat(40),
    });
    expect(signingClaim.runnerLabels).toEqual(["self-hosted", "Windows", "ci"]);
    const outputBytes = new TextEncoder().encode("verified signing archive");
    const outputDigest = `sha256:${await sha256Hex(new TextDecoder().decode(outputBytes))}`;
    const outputKey = `signing/${owner.id}/${repositoryId}/${requestId}/output.zip`;
    const machineEnv = {
      ...actionEnv,
      AUTH: {
        fetch: async () =>
          Response.json({
            data: {
              id: owner.id,
              job: { runId: signingRunId, repositoryId },
              token: { repositoryIds: [repositoryId] },
            },
          }),
      },
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
                  submission: {
                    profile: "release",
                    platform: "windows",
                    sourceRepositoryId: "1",
                    sourceCommitOid: "e".repeat(40),
                    sourceRunId: "123",
                    sourceArtifactId: "release",
                    sourceDigest: digest,
                    sourceSize: 1,
                    version: "1.2.3",
                  },
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
          Authorization: `Bearer ${signingJobToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": "8".repeat(64),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId: "forged-owner", repositoryId: "forged" }),
      }),
      machineEnv
    );
    expect(wrongLease.status).toBe(401);
    const validLease = await runnerMachineRequest(
      new Request(signingUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${signingJobToken}`,
          "X-Runner-Run-Id": signingRunId,
          "X-Runner-Lease-Token": signingLeaseToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ownerId: "forged-owner", repositoryId: "forged" }),
      }),
      machineEnv
    );
    expect(validLease.status, await validLease.clone().text()).toBe(200);
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
          Authorization: `Bearer ${signingJobToken}`,
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
          Authorization: `Bearer ${signingJobToken}`,
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
         VALUES(?,'workflow','["self-hosted","Windows","ci"]','read',60,'{}')`
      ).bind(failedRunId),
      env.DB.prepare(
        `INSERT INTO actions_signing_runs(run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
          generation,nonce,created_at)
         VALUES(?,?,?,?,?,?,'windows','windows_sign',?,1,?,?)`
      ).bind(
        failedRunId,
        failedRequestId,
        owner.id,
        repositoryId,
        profileRevision,
        "e".repeat(40),
        digest,
        "g".repeat(43),
        Date.now()
      ),
    ]);
    const failedRunnerId = crypto.randomUUID();
    const failedRunnerToken = `ge_runner_${"f".repeat(64)}`;
    await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
       VALUES (?,'failure-node',?,?,?,'["self-hosted","Windows","ci"]',?,?)`
    )
      .bind(
        failedRunnerId,
        namespaceId,
        repositoryId,
        owner.id,
        await sha256Hex(failedRunnerToken),
        Date.now()
      )
      .run();
    const failedRunner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.id=?"
    )
      .bind(failedRunnerId)
      .first<RunnerRow>();
    const failedCandidate = (await listRunnerCandidates(actionEnv, failedRunner!)).find(
      (candidate) => candidate.id === failedRunId
    )!;
    expect(
      await claimRunnerCandidate(
        actionEnv,
        failedRunner!,
        failedCandidate,
        60,
        await sha256Hex(failedLeaseToken),
        Date.now(),
        null
      )
    ).toBe(true);
    const failedJobToken = `ge_job_${"b".repeat(64)}`;
    await env.DB.prepare(
      "INSERT INTO actions_job_tokens(run_id,token_hash,expires_at) VALUES(?,?,?)"
    )
      .bind(failedRunId, await sha256Hex(failedJobToken), Date.now() + 60_000)
      .run();
    const failRequest = () =>
      runnerMachineRequest(
        new Request(`https://actions.internal/runner/signing/requests/${failedRequestId}/fail`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${failedJobToken}`,
            "X-Runner-Run-Id": failedRunId,
            "X-Runner-Lease-Token": failedLeaseToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ code: "execution_failed" }),
        }),
        {
          ...machineEnv,
          AUTH: {
            fetch: async () =>
              Response.json({
                data: {
                  id: owner.id,
                  job: { runId: failedRunId, repositoryId },
                  token: { repositoryIds: [repositoryId] },
                },
              }),
          },
        }
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
      request(`/runners/${runnerId}`, "DELETE"),
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
    expect(afterRevocation.status).toBe(401);
  });
});
