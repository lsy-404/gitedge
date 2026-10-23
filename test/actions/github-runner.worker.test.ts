import { env } from "cloudflare:workers";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { importSealingKey, sealText } from "../../src/worker/common/secret-box";
import { githubRunnerOperation } from "../../workers/forge/src/github-runners";
import { receiveGithubWebhook } from "../../workers/forge/src/github-sync";
import { queueGithubRunner, expireGithubRunners } from "../../workers/actions/src/github-runners";
import {
  claimRunnerCandidate,
  listRunnerCandidates,
  recordRunnerFailure,
  runnerUsageMinutes24h,
  type RunnerCandidate,
} from "../../workers/actions/src/runner-scheduler";
import {
  runnerMachineRequest,
  runnerManagement,
  type RunnerRow,
  type RunnerEnv,
} from "../../workers/actions/src/runners";
import {
  createPerson,
  createRepository,
  data,
  forgeEnv,
  migrate,
  type Person,
} from "../support/stack";
import type { RegisteredRunner } from "../../packages/contracts/src/runners";

const secret = "signed-webhook-fixture";
const credential = "server-only-github-management-credential";
const encryption = btoa("e".repeat(32));
let owner: Person;
let repositoryA: string;
let repositoryB: string;
let remoteRunnerId = 500;
let lostResponse = false;
const deletions: number[] = [];
const inventory = new Map<number, string>();
const bridgeEnv = {
  ...forgeEnv,
  WEBHOOK_ENCRYPTION_KEY: encryption,
  ACTIONS: { fetch: (request: Request) => queueGithubRunner(request, machineEnv) },
};
const machineEnv: RunnerEnv = {
  DB: env.DB,
  LOG_LEVEL: "error",
  AUTH: {
    fetch: async () => {
      throw new Error("GitHub jobs must not receive GitEdge job credentials.");
    },
  },
  FORGE: { fetch: (request) => githubRunnerOperation(new Request(request), bridgeEnv) },
};

beforeAll(async () => {
  await migrate();
  owner = await createPerson("runner-owner");
  repositoryA = await createRepository(owner, "first");
  repositoryB = await createRepository(owner, "second");
});
afterEach(() => vi.unstubAllGlobals());

async function connection(
  repositoryId: string,
  remoteName: string,
  remoteId = 99
): Promise<string> {
  const id = crypto.randomUUID();
  const key = await importSealingKey(encryption);
  if (!key) throw new Error("Fixture encryption key is invalid.");
  const tokenBox = await sealText(key, credential),
    secretBox = await sealText(key, secret);
  await env.DB.prepare("DELETE FROM forge_github_connections WHERE repository_id=?")
    .bind(repositoryId)
    .run();
  await env.DB.prepare("UPDATE repositories SET actions_enabled=1 WHERE id=?")
    .bind(repositoryId)
    .run();
  await env.DB.prepare(
    `INSERT INTO forge_github_connections
    (id,repository_id,owner,name,github_repository_id,github_private,created_by,enabled,runner_enabled,callback_url,token_ciphertext,token_iv,secret_ciphertext,secret_iv,created_at)
    VALUES (?,?, 'remote-owner',?,?,1,?,1,1,'https://forge.test/hook',?,?,?,?,?)`
  )
    .bind(
      id,
      repositoryId,
      remoteName,
      remoteId,
      owner.id,
      tokenBox.ciphertext,
      tokenBox.iv,
      secretBox.ciphertext,
      secretBox.iv,
      Date.now()
    )
    .run();
  return id;
}

function demand(
  connectionId: string,
  id: number,
  action = "queued",
  labels = ["self-hosted", "macOS", "ARM64", "ci"]
): Request {
  return new Request("https://actions.internal/internal/github-runner", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId,
      action,
      workflow_job: {
        id,
        run_id: id + 100,
        head_sha: "a".repeat(40),
        labels,
      },
    }),
  });
}

async function registration(): Promise<string> {
  const response = await runnerManagement(
    new Request("https://actions.internal/runners", {
      method: "POST",
      headers: trustedHeaders(owner),
      body: JSON.stringify({
        name: "one-mac",
        scope: { owner: owner.identifier },
        labels: ["self-hosted", "macOS", "ARM64", "ci"],
      }),
    }),
    machineEnv,
    owner
  );
  expect(response.status).toBe(201);
  return (await data<{ runner: RegisteredRunner; token: string }>(response)).token;
}

function machine(token: string, path = "claim", body: unknown = {}): Promise<Response> {
  return runnerMachineRequest(
    new Request(`https://actions.internal/runner/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    machineEnv
  );
}

function remoteApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      );
      expect(url.origin).toBe("https://api.github.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${credential}`);
      const job = /\/actions\/jobs\/(\d+)$/.exec(url.pathname);
      if (job) {
        const queued = await env.DB.prepare(
          "SELECT labels_json FROM actions_github_runner_jobs WHERE github_job_id=? ORDER BY created_at DESC LIMIT 1"
        )
          .bind(Number(job[1]))
          .first<{ labels_json: string }>();
        return Response.json({
          id: Number(job[1]),
          run_id: Number(job[1]) + 100,
          head_sha: "a".repeat(40),
          status: "queued",
          labels: queued ? JSON.parse(queued.labels_json) : ["self-hosted", "macOS", "ARM64", "ci"],
        });
      }
      if (url.pathname.endsWith("/generate-jitconfig")) {
        const body = JSON.parse(String(init?.body));
        const id = ++remoteRunnerId;
        inventory.set(id, body.name);
        if (lostResponse) throw new Error("Response lost after GitHub created the runner.");
        return Response.json({ runner: { id }, encoded_jit_config: "opaque-single-use-jit" });
      }
      const runner = /\/actions\/runners\/(\d+)$/.exec(url.pathname);
      if (runner) {
        const id = Number(runner[1]);
        if (init?.method === "DELETE") {
          deletions.push(id);
          inventory.delete(id);
          return new Response(null, { status: 204 });
        }
        return Response.json({ busy: true });
      }
      if (url.pathname.endsWith("/actions/runners"))
        return Response.json({
          total_count: inventory.size,
          runners: [...inventory].map(([id, name]) => ({ id, name })),
        });
      return Response.json({
        id: url.pathname.endsWith("/second") ? 100 : 99,
        full_name: "remote-owner/repository",
        private: true,
        archived: false,
        default_branch: "main",
      });
    })
  );
}

describe("single-registration GitHub runner bridge", () => {
  it("returns the server label snapshot after the owner adds custom routing tags", async () => {
    remoteApi();
    const connectionId = await connection(repositoryA, "custom-label-snapshot");
    const token = await registration();
    const registrationRow = await env.DB.prepare(
      "SELECT id FROM actions_runners WHERE created_by=? ORDER BY created_at DESC LIMIT 1"
    )
      .bind(owner.id)
      .first<{ id: string }>();
    if (!registrationRow) throw new Error("Runner registration is missing.");
    const updated = await runnerManagement(
      new Request(`https://actions.internal/runners/${registrationRow.id}/labels`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: ["device", "ip-residential"] }),
      }),
      machineEnv,
      owner
    );
    expect(updated.status).toBe(200);
    const requested = ["self-hosted", "macOS", "ARM64", "device", "ip-residential"];
    expect(
      (await queueGithubRunner(demand(connectionId, 900, "queued", requested), machineEnv)).status
    ).toBe(202);
    const claimed = await data<{
      run: { labels: string[] };
      runnerLabels: string[];
    }>(
      await machine(token, "claim", {
        capacity: {
          os: "macos",
          arch: "arm64",
          cpus: 4,
          load1: 0.1,
          memTotalMb: 8192,
          memFreeMb: 4096,
          diskFreeMb: 100_000,
          tools: ["node"],
          slots: 1,
          busy: 0,
        },
      })
    );
    expect(claimed.run.labels).toEqual(requested);
    expect(claimed.runnerLabels).toEqual([
      "self-hosted",
      "macOS",
      "ARM64",
      "device",
      "ip-residential",
    ]);
  });

  it("leaves a resource-incompatible job queued for a capable runner", async () => {
    remoteApi();
    const connectionId = await connection(repositoryA, "resource-claim");
    const small = await registration();
    const largeRegistration = await runnerManagement(
      new Request("https://actions.internal/runners", {
        method: "POST",
        headers: trustedHeaders(owner),
        body: JSON.stringify({
          name: "large-linux",
          scope: { owner: owner.identifier },
          labels: ["self-hosted", "macOS", "ARM64", "ci"],
        }),
      }),
      machineEnv,
      owner
    );
    const large = (await data<{ token: string }>(largeRegistration)).token;
    const labels = ["self-hosted", "macOS", "ARM64", "ci", "need-mem-4g"];
    const capacity = (memFreeMb: number) => ({
      os: "linux",
      arch: "x64",
      cpus: 2,
      load1: 0.1,
      memTotalMb: 8192,
      memFreeMb,
      diskFreeMb: 20_000,
      tools: ["node"],
      slots: 1,
      busy: 0,
    });

    expect(
      await data<{ run: unknown }>(await machine(small, "claim", { capacity: capacity(8192) }))
    ).toMatchObject({ run: null });
    expect(
      (await queueGithubRunner(demand(connectionId, 901, "queued", labels), machineEnv)).status
    ).toBe(202);
    expect(
      await machine(small, "claim", {}).then((response) => data<{ run: unknown }>(response))
    ).toMatchObject({ run: null });
    expect(
      await data<{ run: unknown }>(await machine(small, "claim", { capacity: capacity(630) }))
    ).toMatchObject({ run: null });
    expect(
      await env.DB.prepare(
        "SELECT status FROM actions_github_runner_jobs WHERE github_job_id=901"
      ).first<{ status: string }>()
    ).toEqual({ status: "queued" });

    expect(
      await data<{ run: unknown }>(
        await machine(large, "claim", {
          capacity: capacity(4096),
          budget: { dailyMinutes: 100 },
        })
      )
    ).toMatchObject({ run: null });
    expect(
      await env.DB.prepare(
        "SELECT status FROM actions_github_runner_jobs WHERE github_job_id=901"
      ).first<{ status: string }>()
    ).toEqual({ status: "queued" });
    const claimed = await data<{
      run: { id: string; labels: string[]; timeoutMinutes: number } | null;
      leaseToken: string;
    }>(
      await machine(large, "claim", {
        capacity: capacity(4096),
        budget: { dailyMinutes: 1440 },
      })
    );
    expect(claimed.run).toMatchObject({ labels, timeoutMinutes: 360 });
    if (!claimed.run) throw new Error("The capable runner did not claim its job.");
    expect(
      await env.DB.prepare(
        "SELECT consecutive_failures,held_until FROM actions_runners WHERE name='large-linux'"
      ).first<{ consecutive_failures: number; held_until: number | null }>()
    ).toEqual({ consecutive_failures: 0, held_until: null });
    expect(
      (
        await machine(large, "github/complete", {
          runId: claimed.run.id,
          leaseToken: claimed.leaseToken,
          conclusion: "success",
          log: "",
        })
      ).status
    ).toBe(200);
    expect(
      (await queueGithubRunner(demand(connectionId, 903, "queued", labels), machineEnv)).status
    ).toBe(202);
    const leaseExpiry = await data<{
      run: { id: string } | null;
      leaseToken: string;
    }>(
      await machine(large, "claim", {
        capacity: capacity(4096),
        budget: { dailyMinutes: 1440 },
      })
    );
    if (!leaseExpiry.run) throw new Error("The runner did not claim the lease-expiry fixture.");
    await env.DB.prepare("UPDATE actions_github_runner_jobs SET lease_expires_at=? WHERE id=?")
      .bind(Date.now() - 1, leaseExpiry.run.id)
      .run();
    expect(
      await data(
        await machine(large, "github/heartbeat", {
          runId: leaseExpiry.run.id,
          leaseToken: leaseExpiry.leaseToken,
        })
      )
    ).toMatchObject({ cancelled: true });
    const runnerId = await env.DB.prepare(
      "SELECT id FROM actions_runners WHERE name='large-linux'"
    ).first<{ id: string }>();
    if (!runnerId) throw new Error("Runner fixture is missing.");
    const now = Date.now();
    expect(
      await env.DB.prepare("SELECT held_until FROM actions_runners WHERE id=?")
        .bind(runnerId.id)
        .first<{ held_until: number | null }>()
    ).toEqual({ held_until: null });
    await recordRunnerFailure(machineEnv, runnerId.id, now);
    expect(
      await env.DB.prepare("SELECT held_until FROM actions_runners WHERE id=?")
        .bind(runnerId.id)
        .first<{ held_until: number | null }>()
    ).toEqual({ held_until: null });
    await recordRunnerFailure(machineEnv, runnerId.id, now);
    expect(
      await env.DB.prepare("SELECT consecutive_failures,held_until FROM actions_runners WHERE id=?")
        .bind(runnerId.id)
        .first<{ consecutive_failures: number; held_until: number }>()
    ).toEqual({ consecutive_failures: 3, held_until: now + 10 * 60_000 });
    for (let failure = 0; failure < 70; failure++)
      await recordRunnerFailure(machineEnv, runnerId.id, now);
    expect(
      await env.DB.prepare("SELECT held_until FROM actions_runners WHERE id=?")
        .bind(runnerId.id)
        .first<{ held_until: number }>()
    ).toEqual({ held_until: now + 60 * 60_000 });
  });

  it("merges GitEdge and GitHub FIFO candidates and atomically grants only one cross-queue slot", async () => {
    const connectionId = await connection(repositoryA, "cross-queue");
    const token = await registration();
    const capacity = {
      os: "linux",
      arch: "x64",
      cpus: 2,
      load1: 0.1,
      memTotalMb: 4096,
      memFreeMb: 2048,
      diskFreeMb: 20_000,
      tools: ["node"],
      slots: 1,
      busy: 0,
    };
    expect((await machine(token, "claim", { capacity })).status).toBe(200);
    const createdAt = Date.now() - 60_000;
    const gitedgeId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE repositories SET actions_enabled=1,actions_runner_enabled=1 WHERE id=?"
      ).bind(repositoryA),
      env.DB.prepare(
        `INSERT INTO actions_runs (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,executor)
         VALUES (?,?,?,'build','ci.yml','refs/heads/main',?,?,'runner')`
      ).bind(gitedgeId, repositoryA, "a".repeat(40), owner.id, createdAt),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs (run_id,workflow_source,labels_json,permission,timeout_minutes,event_json,status)
         VALUES (?,'workflow','["self-hosted","macOS","ARM64","ci"]','read',360,'{}','queued')`
      ).bind(gitedgeId),
    ]);
    expect((await queueGithubRunner(demand(connectionId, 902), machineEnv)).status).toBe(202);
    const runner = await env.DB.prepare(
      "SELECT r.*,n.slug AS owner,p.slug AS repository FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id LEFT JOIN repositories p ON p.id=r.repository_id WHERE r.created_by=? ORDER BY r.created_at DESC LIMIT 1"
    )
      .bind(owner.id)
      .first<RunnerRow>();
    if (!runner) throw new Error("Runner fixture is missing.");
    const candidates = await listRunnerCandidates(machineEnv, runner);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["gitedge", "github"]);
    const now = Date.now();
    const results = await Promise.all(
      candidates.map((candidate: RunnerCandidate, index) =>
        claimRunnerCandidate(
          machineEnv,
          runner,
          candidate,
          candidate.default_minutes,
          String(index + 1).repeat(64),
          now,
          runner.capacity_reported_at
        )
      )
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const active = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM actions_runner_runs WHERE runner_id=? AND status='running') +
              (SELECT COUNT(*) FROM actions_github_runner_jobs WHERE runner_id=? AND status='running') AS count`
    )
      .bind(runner.id, runner.id)
      .first<{ count: number }>();
    expect(active?.count).toBe(1);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE actions_runner_runs SET status='completed',runner_id=?,started_at=?,completed_at=? WHERE run_id=?"
      ).bind(runner.id, now - 48 * 60 * 60_000, now - 12 * 60 * 60_000, gitedgeId),
      env.DB.prepare(
        "UPDATE actions_github_runner_jobs SET status='completed',runner_id=?,started_at=?,completed_at=? WHERE github_job_id=902"
      ).bind(runner.id, now - 3 * 60 * 60_000, now - 2 * 60 * 60_000),
    ]);
    expect(await runnerUsageMinutes24h(machineEnv, runner.id, now)).toBeCloseTo(780, 0);
  });

  it("serializes two repositories through one registration, owns leases, and removes temporary identities", async () => {
    remoteApi();
    lostResponse = false;
    const first = await connection(repositoryA, "first"),
      second = await connection(repositoryB, "second", 100);
    const token = await registration();
    expect((await queueGithubRunner(demand(first, 1), machineEnv)).status).toBe(202);
    expect((await queueGithubRunner(demand(first, 1), machineEnv)).status).toBe(202);
    expect((await queueGithubRunner(demand(second, 2), machineEnv)).status).toBe(202);
    const claims = await Promise.all([machine(token), machine(token)]);
    const values = await Promise.all(
      claims.map((response) =>
        data<{
          run: {
            id: string;
            kind: string;
            scope: { owner: string; repository: string };
            githubRunnerId: number;
          } | null;
          leaseToken: string;
        }>(response)
      )
    );
    expect(values.filter((value) => value.run !== null)).toHaveLength(1);
    const current = values.find((value) => value.run !== null);
    if (!current?.run) throw new Error("No job was claimed.");
    expect(current.run).toMatchObject({ kind: "github", scope: { owner: "runner-owner" } });
    expect(JSON.stringify(current)).not.toContain(credential);
    const lease = { runId: current.run.id, leaseToken: current.leaseToken };
    expect(
      (await machine(token, "github/heartbeat", { ...lease, leaseToken: "f".repeat(64) })).status
    ).toBe(409);
    const heartbeat = await machine(token, "github/heartbeat", lease);
    expect(await data(heartbeat)).toMatchObject({ cancelled: false, assigned: true });
    expect(
      (await machine(token, "github/complete", { ...lease, conclusion: "success", log: "" })).status
    ).toBe(200);
    expect(deletions).toContain(current.run.githubRunnerId);
    const next = await data<{
      run: { id: string; scope: { repository: string }; githubRunnerId: number };
      leaseToken: string;
    }>(await machine(token));
    expect(next.run.scope.repository).not.toBe(current.run.scope.repository);
    await env.DB.prepare("UPDATE forge_github_connections SET runner_enabled=0 WHERE id IN (?,?)")
      .bind(first, second)
      .run();
    expect(
      await data(
        await machine(token, "github/heartbeat", {
          runId: next.run.id,
          leaseToken: next.leaseToken,
        })
      )
    ).toMatchObject({ cancelled: true });
    expect(deletions).toContain(next.run.githubRunnerId);
  });

  it("accepts only a correctly signed webhook for its bound repository", async () => {
    const id = await connection(repositoryA, "webhook");
    const payload = JSON.stringify({
      repository: { id: 99 },
      action: "queued",
      workflow_job: {
        id: 3,
        run_id: 103,
        head_sha: "a".repeat(40),
        labels: ["self-hosted", "macOS"],
      },
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const bytes = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
    );
    const signature = `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const request = (value: string) =>
      new Request("https://forge.test/github-sync/hooks/" + id, {
        method: "POST",
        headers: { "X-GitHub-Event": "workflow_job", "X-Hub-Signature-256": value },
        body: payload,
      });
    expect(
      (await receiveGithubWebhook(bridgeEnv, request(`sha256=${"0".repeat(64)}`), id)).status
    ).toBe(401);
    expect(
      await env.DB.prepare("SELECT 1 FROM actions_github_runner_jobs WHERE connection_id=?")
        .bind(id)
        .first()
    ).toBeNull();
    expect((await receiveGithubWebhook(bridgeEnv, request(signature), id)).status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT github_job_id FROM actions_github_runner_jobs WHERE connection_id=?"
      )
        .bind(id)
        .first()
    ).toEqual({ github_job_id: 3 });
  });

  it("recovers temporary identities after a lost JIT response without replaying the job", async () => {
    remoteApi();
    lostResponse = true;
    const id = await connection(repositoryA, "lost-response");
    const token = await registration();
    await queueGithubRunner(demand(id, 4), machineEnv);
    await expect(machine(token)).rejects.toThrow();
    const job = await env.DB.prepare(
      "SELECT id,status,cleanup_pending FROM actions_github_runner_jobs WHERE connection_id=?"
    )
      .bind(id)
      .first<{ id: string; status: string; cleanup_pending: number }>();
    expect(job).toMatchObject({ status: "completed", cleanup_pending: 1 });
    if (!job) throw new Error("The demand disappeared.");
    await env.DB.prepare("UPDATE actions_github_runner_jobs SET started_at=? WHERE id=?")
      .bind(Date.now() - 180_000, job.id)
      .run();
    const before = deletions.length;
    await expireGithubRunners(machineEnv);
    expect(deletions.length).toBeGreaterThan(before);
    expect(
      await env.DB.prepare(
        "SELECT status,cleanup_pending FROM actions_github_runner_jobs WHERE id=?"
      )
        .bind(job.id)
        .first()
    ).toEqual({ status: "completed", cleanup_pending: 0 });
    expect(await data(await machine(token))).toMatchObject({ run: null });
    lostResponse = false;
  });
});
