import { z } from "zod";
import {
  GitHubRunnerDemandSchema,
  RunnerLeaseInputSchema,
  RunnerCompleteInputSchema,
  RUNNER_LEASE_MS,
  sha256Hex,
  type GitHubRunnerJobRecord,
  type JobClaim,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { createLogger } from "../../../src/worker/common/logger";
import type { RunnerEnv, RunnerRow } from "./runners";
import { clearRunnerFailures, recordRunnerFailure } from "./runner-scheduler";

export async function queueGithubRunner(request: Request, env: RunnerEnv): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "actions.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = GitHubRunnerDemandSchema.safeParse(await readJsonLimited(request, 16_384));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid GitHub runner demand.");
  const input = parsed.data,
    job = input.workflow_job;
  if (input.action === "in_progress") return dataResponse({ accepted: true });
  if (!job.labels.some((label) => label.toLowerCase() === "self-hosted"))
    return dataResponse({ ignored: true });
  const now = Date.now();
  const queued = await env.DB.prepare(
    `INSERT INTO actions_github_runner_jobs
     (id,connection_id,github_job_id,github_run_id,head_oid,labels_json,status,created_at,completed_at)
     SELECT ?,?,?,?,?,?,?,?,? FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id
     WHERE c.id=? AND c.enabled=1 AND c.runner_enabled=1 AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
     AND (?='completed' OR (SELECT COUNT(*) FROM actions_github_runner_jobs WHERE connection_id=c.id AND status='queued')<100
       OR EXISTS (SELECT 1 FROM actions_github_runner_jobs WHERE connection_id=c.id AND github_job_id=?))
     ON CONFLICT(connection_id,github_job_id) DO UPDATE SET status=CASE
       WHEN excluded.status='completed' AND actions_github_runner_jobs.status='queued' THEN 'completed'
       ELSE actions_github_runner_jobs.status END,
       completed_at=CASE WHEN excluded.status='completed' AND actions_github_runner_jobs.status='queued' THEN excluded.completed_at
       ELSE actions_github_runner_jobs.completed_at END`
  )
    .bind(
      crypto.randomUUID(),
      input.connectionId,
      job.id,
      job.run_id,
      job.head_sha,
      JSON.stringify(job.labels),
      input.action === "queued" ? "queued" : "completed",
      now,
      input.action === "completed" ? now : null,
      input.connectionId,
      input.action,
      job.id
    )
    .run();
  if (queued.meta.changes === 0)
    return errorResponse(
      503,
      "runner_queue_unavailable",
      "The runner connection is unavailable or its queue is full."
    );
  return dataResponse({ accepted: true }, 202);
}

async function forgeOperation(
  env: RunnerEnv,
  operation: "start" | "status" | "cleanup",
  id: string
): Promise<unknown> {
  const response = await env.FORGE.fetch(
    new Request("https://forge.internal/internal/github-runner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, id }),
    })
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub runner ${operation} failed: ${response.status}.`);
  }
  const result = z.object({ data: z.unknown() }).parse(await response.json());
  return result.data;
}

async function finish(
  env: RunnerEnv,
  id: string,
  conclusion: "success" | "failure" | "cancelled",
  infrastructureFailure = false
): Promise<void> {
  const changed = await env.DB.prepare(
    "UPDATE actions_github_runner_jobs SET status='completed',conclusion=?,completed_at=? WHERE id=? AND status!='completed' RETURNING runner_id"
  )
    .bind(conclusion, Date.now(), id)
    .first<{ runner_id: string | null }>();
  if (changed) {
    if (infrastructureFailure) await recordRunnerFailure(env, changed.runner_id, Date.now());
    else await clearRunnerFailures(env, changed.runner_id);
  }
  try {
    await forgeOperation(env, "cleanup", id);
  } catch {
    createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn(
      "github-runner:cleanup-pending",
      { id }
    );
  }
}

export async function claimGithubRunner(
  env: RunnerEnv,
  runner: RunnerRow,
  jobId: string,
  claim: JobClaim,
  leaseToken: string,
  hash: string,
  now: number
): Promise<Response | null> {
  const job = await env.DB.prepare(
    "SELECT * FROM actions_github_runner_jobs WHERE id=? AND status='running' AND runner_id=? AND lease_hash=?"
  )
    .bind(jobId, runner.id, hash)
    .first<GitHubRunnerJobRecord>();
  if (!job) return null;
  try {
    const result = z
      .object({
        allowed: z.boolean(),
        encodedJitConfig: z.string().optional(),
        githubRunnerId: z.number().int().positive().optional(),
      })
      .parse(await forgeOperation(env, "start", job.id));
    if (!result.allowed || !result.encodedJitConfig || !result.githubRunnerId) {
      await finish(env, job.id, "cancelled");
      return null;
    }
    const source = await env.DB.prepare(
      `SELECT c.owner,c.name,p.slug,n.slug AS namespace FROM forge_github_connections c
       JOIN repositories p ON p.id=c.repository_id JOIN namespaces n ON n.id=p.namespace_id WHERE c.id=?`
    )
      .bind(job.connection_id)
      .first<{ owner: string; name: string; slug: string; namespace: string }>();
    if (!source) throw new Error("GitHub runner connection disappeared.");
    return dataResponse({
      run: {
        kind: "github",
        id: job.id,
        owner: source.owner,
        repository: source.name,
        scope: { owner: source.namespace, repository: source.slug },
        jobId: job.github_job_id,
        runId: job.github_run_id,
        labels: JSON.parse(job.labels_json),
        encodedJitConfig: result.encodedJitConfig,
        githubRunnerId: result.githubRunnerId,
        timeoutMinutes: claim.minutes,
      },
      leaseToken,
      leaseExpiresAt: now + RUNNER_LEASE_MS,
    });
  } catch (cause) {
    await finish(env, job.id, "failure", true);
    createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn("github-runner:start-failed", {
      id: job.id,
    });
    throw cause;
  }
}

export async function githubRunnerLease(
  request: Request,
  env: RunnerEnv,
  runner: RunnerRow
): Promise<Response> {
  const complete = new URL(request.url).pathname.endsWith("/complete");
  const input = (complete ? RunnerCompleteInputSchema : RunnerLeaseInputSchema).safeParse(
    await readJsonLimited(request, 102_400)
  );
  if (!input.success) return errorResponse(400, "bad_request", "Invalid GitHub runner lease.");
  const now = Date.now(),
    hash = await sha256Hex(input.data.leaseToken);
  const job = await env.DB.prepare(
    "SELECT * FROM actions_github_runner_jobs WHERE id=? AND runner_id=? AND lease_hash=?"
  )
    .bind(input.data.runId, runner.id, hash)
    .first<GitHubRunnerJobRecord>();
  if (!job) return errorResponse(409, "conflict", "The runner does not own this job lease.");
  if (complete) {
    const parsed = RunnerCompleteInputSchema.parse(input.data);
    if (job.status === "completed") {
      if (job.conclusion !== parsed.conclusion)
        return errorResponse(409, "conflict", "The job already completed.");
    } else {
      if ((job.lease_expires_at ?? 0) <= now || (job.started_at ?? 0) + 21_600_000 <= now) {
        await finish(env, job.id, "failure", true);
        return errorResponse(409, "conflict", "The job lease expired.");
      }
      await finish(env, job.id, parsed.conclusion);
    }
    return dataResponse({ completed: true });
  }
  if (
    job.status !== "running" ||
    (job.lease_expires_at ?? 0) <= now ||
    (job.started_at ?? 0) + 21_600_000 <= now
  ) {
    if (job.status === "running") await finish(env, job.id, "failure", true);
    return dataResponse({ cancelled: true, assigned: job.assigned === 1, leaseExpiresAt: now });
  }
  const status = z
    .object({ allowed: z.boolean(), assigned: z.boolean() })
    .parse(await forgeOperation(env, "status", job.id));
  if (!status.allowed) {
    await finish(env, job.id, "cancelled");
    return dataResponse({ cancelled: true, assigned: status.assigned, leaseExpiresAt: now });
  }
  const renewedAt = Date.now();
  const renewed = await env.DB.prepare(
    `UPDATE actions_github_runner_jobs SET lease_expires_at=MIN(started_at+21600000,MAX(lease_expires_at,?)),assigned=MAX(assigned,?)
     WHERE id=? AND status='running' AND lease_hash=? AND lease_expires_at>? RETURNING lease_expires_at`
  )
    .bind(renewedAt + RUNNER_LEASE_MS, Number(status.assigned), job.id, hash, renewedAt)
    .first<{ lease_expires_at: number }>();
  return dataResponse({
    cancelled: renewed === null,
    assigned: status.assigned,
    leaseExpiresAt: renewed?.lease_expires_at ?? renewedAt,
  });
}

export async function expireGithubRunners(env: RunnerEnv): Promise<void> {
  const now = Date.now();
  const expired = await env.DB.prepare(
    `SELECT j.id FROM actions_github_runner_jobs j LEFT JOIN actions_runners r ON r.id=j.runner_id
     WHERE j.status='running' AND (j.lease_expires_at<=? OR j.started_at+21600000<=? OR r.id IS NULL OR r.revoked_at IS NOT NULL)
     ORDER BY j.started_at LIMIT 20`
  )
    .bind(now, now)
    .all<{ id: string }>();
  for (const job of expired.results) await finish(env, job.id, "failure", true);
  await env.DB.prepare(
    `UPDATE actions_github_runner_jobs SET status='completed',conclusion='failure',completed_at=?
     WHERE id IN (SELECT j.id FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id
       JOIN repositories p ON p.id=c.repository_id LEFT JOIN actions_runners r ON r.id=j.runner_id
       WHERE j.status!='completed' AND ((j.status='running' AND (j.lease_expires_at<=? OR j.started_at+21600000<=? OR r.id IS NULL OR r.revoked_at IS NOT NULL))
         OR (j.status='queued' AND j.created_at<?) OR c.enabled=0 OR c.runner_enabled=0 OR p.deleted_at IS NOT NULL OR p.archived=1 OR p.actions_enabled=0)
       ORDER BY j.created_at LIMIT 20)`
  )
    .bind(now, now, now, now - 86_400_000)
    .run();
  const jobs = await env.DB.prepare(
    "SELECT id FROM actions_github_runner_jobs WHERE status='completed' AND cleanup_pending=1 LIMIT 10"
  ).all<{ id: string }>();
  for (const job of jobs.results) {
    try {
      await forgeOperation(env, "cleanup", job.id);
    } catch {
      createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn(
        "github-runner:cleanup-pending",
        { id: job.id }
      );
    }
  }
}
