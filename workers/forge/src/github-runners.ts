import { z } from "zod";
import {
  GitHubRunnerOperationSchema,
  type GitHubRunnerJobRecord,
} from "../../../packages/contracts/src/runners";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { createLogger } from "../../../src/worker/common/logger";
import { auditStatement } from "../../../src/worker/common/audit";
import {
  githubNetworkRetryKey,
  isNetworkFailure,
  permitsNetworkRetry,
  type RunnerNetworkRetry,
} from "../../../src/worker/common/runner-network";
import { githubCredentials, type GithubConnectionRow } from "./github-sync-store";
import {
  GithubApiError,
  githubRepoPath,
  githubRequest,
  githubJobLog,
  GithubRepositorySchema,
} from "./github-client";
import type { ForgeEnv } from "./common";

const JobSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  head_sha: z.string(),
  status: z.enum(["queued", "in_progress", "completed", "waiting", "pending"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "cancelled",
      "neutral",
      "skipped",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
    ])
    .nullable(),
  labels: z.array(z.string()).max(40),
  steps: z
    .array(
      z.object({
        number: z.number().int().positive(),
        conclusion: z.string().nullable(),
        started_at: z.string().nullable(),
        completed_at: z.string().nullable(),
      })
    )
    .default([]),
});
const JitSchema = z.object({
  runner: z.object({ id: z.number().int().positive() }),
  encoded_jit_config: z.string().min(1).max(1_048_576),
});

async function allowed(
  env: ForgeEnv,
  connection: GithubConnectionRow,
  runnerId: string | null
): Promise<boolean> {
  const found = await env.DB.prepare(
    `SELECT 1 FROM repositories p JOIN users u ON u.id=?
     JOIN actions_runners r ON r.id=? AND r.namespace_id=p.namespace_id
     JOIN users runner_owner ON runner_owner.id=r.created_by AND runner_owner.disabled_at IS NULL
     WHERE p.id=? AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
     AND u.disabled_at IS NULL AND r.revoked_at IS NULL AND (r.repository_id IS NULL OR r.repository_id=p.id)`
  )
    .bind(connection.created_by, runnerId, connection.repository_id)
    .first();
  return (
    connection.enabled === 1 &&
    connection.runner_enabled === 1 &&
    found !== null &&
    (await repositoryRole(env.DB, connection.repository_id, connection.created_by)) === "admin"
  );
}

async function cleanup(
  env: ForgeEnv,
  job: GitHubRunnerJobRecord,
  connection: GithubConnectionRow
): Promise<void> {
  const credentials = await githubCredentials(env, connection);
  let runnerId = job.github_runner_id;
  if (runnerId === null && job.cleanup_pending === 1) {
    if ((job.started_at ?? 0) + 120_000 > Date.now())
      throw new Error("github_runner_start_pending");
    const inventory = z
      .object({
        total_count: z.number(),
        runners: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
      })
      .parse(
        await githubRequest(
          credentials.token,
          `${githubRepoPath(connection.owner, connection.name)}/actions/runners?per_page=100`
        )
      );
    runnerId = inventory.runners.find((runner) => runner.name === `gitedge-${job.id}`)?.id ?? null;
    if (runnerId === null && inventory.total_count > inventory.runners.length)
      throw new Error("github_runner_inventory_truncated");
  }
  if (runnerId !== null) {
    try {
      await githubRequest(
        credentials.token,
        `${githubRepoPath(connection.owner, connection.name)}/actions/runners/${runnerId}`,
        "DELETE"
      );
    } catch (cause) {
      if (!(cause instanceof GithubApiError && cause.status === 404)) throw cause;
    }
  }
  let remote: z.infer<typeof JobSchema> | undefined;
  try {
    remote = JobSchema.parse(
      await githubRequest(
        credentials.token,
        `${githubRepoPath(connection.owner, connection.name)}/actions/jobs/${job.github_job_id}`
      )
    );
  } catch (cause) {
    if (!(cause instanceof GithubApiError && cause.status === 404)) throw cause;
  }
  if (
    remote &&
    (remote.id !== job.github_job_id ||
      remote.run_id !== job.github_run_id ||
      remote.head_sha !== job.head_oid)
  )
    throw new Error("github_runner_job_mismatch");
  if (
    remote?.status === "queued" &&
    job.started_at !== null &&
    job.completed_at !== null &&
    (job.conclusion !== "cancelled" || job.assigned === 0) &&
    (await allowed(env, connection, job.runner_id))
  ) {
    const owner = await env.DB.prepare(
      "SELECT created_by,namespace_id FROM actions_runners WHERE id=?"
    )
      .bind(job.runner_id)
      .first<{ created_by: string; namespace_id: string }>();
    if (!owner) throw new Error("github_runner_owner_missing");
    const changed = await env.DB.batch([
      env.DB.prepare(
        `UPDATE actions_github_runner_jobs SET status='queued',runner_id=NULL,github_runner_id=NULL,
         lease_hash=NULL,lease_expires_at=NULL,assigned=0,started_at=NULL,completed_at=NULL,
         conclusion=NULL,cleanup_pending=0
         WHERE id=? AND status='completed' AND cleanup_pending=1
         AND github_runner_id IS ? AND lease_hash IS ?
         AND EXISTS (SELECT 1 FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id
           WHERE c.id=connection_id AND c.enabled=1 AND c.runner_enabled=1
           AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1)`
      ).bind(job.id, job.github_runner_id, job.lease_hash),
      auditStatement(
        env.DB,
        {
          action: "actions.runner_demand_requeued",
          actor: { kind: "system", id: job.runner_id, name: "GitEdge runner", ref: job.id },
          target: { type: "runner", id: job.runner_id },
          repositoryId: connection.repository_id,
          namespaceId: owner.namespace_id,
          subjectUserId: owner.created_by,
          metadata: {
            startedAt: job.started_at,
            completedAt: job.completed_at,
            githubJobId: job.github_job_id,
            githubRunId: job.github_run_id,
          },
        },
        job.completed_at,
        true
      ),
    ]);
    if (changed[0].meta.changes === 1) {
      createLogger(env.LOG_LEVEL, { service: "github-runner" }).info(
        "github-runner:demand-requeued",
        { id: job.id, githubJobId: job.github_job_id }
      );
      return;
    }
  }
  let conclusion = job.conclusion;
  if (remote && remote.status !== "queued") {
    if (remote.status !== "completed" || remote.conclusion === null)
      throw new Error("github_runner_job_pending");
    conclusion =
      remote.conclusion === "success" ||
      remote.conclusion === "neutral" ||
      remote.conclusion === "skipped"
        ? "success"
        : remote.conclusion === "cancelled"
          ? "cancelled"
          : "failure";
  }
  if (await retryNetworkJob(env, job, connection, remote)) return;
  await env.DB.prepare(
    `UPDATE actions_github_runner_jobs SET cleanup_pending=0,conclusion=? WHERE id=? AND status='completed'
     AND github_runner_id IS ? AND lease_hash IS ?`
  )
    .bind(conclusion, job.id, job.github_runner_id, job.lease_hash)
    .run();
}

async function retryNetworkJob(
  env: ForgeEnv,
  job: GitHubRunnerJobRecord,
  connection: GithubConnectionRow,
  remote: z.infer<typeof JobSchema> | undefined
): Promise<boolean> {
  if (
    !remote ||
    remote.status !== "completed" ||
    remote.conclusion !== "failure" ||
    job.conclusion === "cancelled" ||
    job.started_at === null ||
    job.completed_at === null ||
    !(await allowed(env, connection, job.runner_id))
  )
    return false;
  const key = githubNetworkRetryKey(connection.id, job.github_run_id);
  let retry = await env.DB.prepare("SELECT * FROM actions_runner_network_retries WHERE retry_key=?")
    .bind(key)
    .first<RunnerNetworkRetry>();
  if (retry && retry.source_job_id !== job.id) return false;
  if (retry && retry.state !== "pending") return false;
  const credentials = await githubCredentials(env, connection);
  if (!retry) {
    const runner = await env.DB.prepare("SELECT labels_json FROM actions_runners WHERE id=?")
      .bind(job.runner_id)
      .first<{ labels_json: string }>();
    const labels = z.array(z.string()).parse(JSON.parse(job.labels_json));
    const available = runner ? z.array(z.string()).parse(JSON.parse(runner.labels_json)) : [];
    if (!permitsNetworkRetry(labels, available)) return false;
    const failed = remote.steps.filter((step) => step.conclusion === "failure").at(-1);
    if (!failed?.started_at || !failed.completed_at) return false;
    const started = Date.parse(failed.started_at),
      completed =
        Date.parse(failed.completed_at) + (/\.\d+Z$/.test(failed.completed_at) ? 1 : 1000);
    if (!Number.isFinite(started) || !Number.isFinite(completed)) return false;
    const log = await githubJobLog(
      credentials.token,
      connection.owner,
      connection.name,
      job.github_job_id
    );
    if (log === null) return false;
    const failedLog = log
      .split(/\r?\n/)
      .filter((line) => {
        const timestamp = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(line)?.[0];
        const at = timestamp ? Date.parse(timestamp) : NaN;
        return at >= started && at < completed;
      })
      .join("\n");
    if (!isNetworkFailure(failedLog)) return false;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO actions_runner_network_retries
      (retry_key,kind,repository_id,connection_id,github_run_id,source_job_id,source_runner_id,
       source_lease_hash,failure_log,started_at,completed_at,state,created_at)
      VALUES (?,'github',?,?,?,?,?,?,?,?,?,'pending',?)`
    )
      .bind(
        key,
        connection.repository_id,
        connection.id,
        job.github_run_id,
        job.id,
        job.runner_id,
        job.lease_hash,
        `GitHub failed step ${failed.number} reported a network transport error.`,
        job.started_at,
        job.completed_at,
        Date.now()
      )
      .run();
    retry = await env.DB.prepare("SELECT * FROM actions_runner_network_retries WHERE retry_key=?")
      .bind(key)
      .first<RunnerNetworkRetry>();
    if (!retry || retry.source_job_id !== job.id || retry.state !== "pending") return false;
  }
  const path = githubRepoPath(connection.owner, connection.name);
  const run = z
    .object({ id: z.number(), head_sha: z.string(), status: z.string() })
    .parse(await githubRequest(credentials.token, `${path}/actions/runs/${job.github_run_id}`));
  if (
    run.id !== job.github_run_id ||
    run.head_sha !== job.head_oid ||
    Date.now() - retry.created_at > 21_600_000
  ) {
    await env.DB.prepare(
      "UPDATE actions_runner_network_retries SET state='failed',error_code='retry_identity_or_deadline' WHERE retry_key=? AND state='pending'"
    )
      .bind(key)
      .run();
    return false;
  }
  if (run.status !== "completed") return true;
  const claimed = await env.DB.prepare(
    "UPDATE actions_runner_network_retries SET state='requested',requested_at=? WHERE retry_key=? AND state='pending' RETURNING retry_key"
  )
    .bind(Date.now(), key)
    .first();
  if (!claimed) return false;
  try {
    await githubRequest(
      credentials.token,
      `${path}/actions/jobs/${job.github_job_id}/rerun`,
      "POST"
    );
    createLogger(env.LOG_LEVEL, { service: "github-runner" }).info(
      "github-runner:network-retry-requested",
      { id: job.id, githubRunId: job.github_run_id }
    );
  } catch (cause) {
    const code =
      cause instanceof GithubApiError
        ? `github_http_${cause.status}`
        : "github_request_outcome_unknown";
    await env.DB.prepare(
      "UPDATE actions_runner_network_retries SET state=?,error_code=? WHERE retry_key=?"
    )
      .bind(cause instanceof GithubApiError ? "failed" : "requested", code, key)
      .run();
    createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn(
      "github-runner:network-retry-failed",
      { id: job.id, code }
    );
  }
  return false;
}

export async function stopGithubRunners(
  env: ForgeEnv,
  connection: GithubConnectionRow
): Promise<boolean> {
  await env.DB.prepare(
    `UPDATE actions_github_runner_jobs SET status='completed',conclusion='cancelled',completed_at=?,
     cleanup_pending=CASE WHEN github_runner_id IS NULL THEN cleanup_pending ELSE 1 END
     WHERE connection_id=? AND status!='completed'`
  )
    .bind(Date.now(), connection.id)
    .run();
  const jobs = await env.DB.prepare(
    "SELECT * FROM actions_github_runner_jobs WHERE connection_id=? AND cleanup_pending=1 LIMIT 20"
  )
    .bind(connection.id)
    .all<GitHubRunnerJobRecord>();
  for (const job of jobs.results) {
    try {
      await cleanup(env, job, connection);
    } catch {
      createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn(
        "github-runner:cleanup-pending",
        { id: job.id }
      );
    }
  }
  return (
    (await env.DB.prepare(
      "SELECT 1 FROM actions_github_runner_jobs WHERE connection_id=? AND cleanup_pending=1 LIMIT 1"
    )
      .bind(connection.id)
      .first()) === null
  );
}

export async function githubRunnerOperation(request: Request, env: ForgeEnv): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "forge.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = GitHubRunnerOperationSchema.safeParse(await readJsonLimited(request, 4096));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid runner operation.");
  const job = await env.DB.prepare("SELECT * FROM actions_github_runner_jobs WHERE id=?")
    .bind(parsed.data.id)
    .first<GitHubRunnerJobRecord>();
  if (!job) return errorResponse(404, "not_found", "Runner demand was not found.");
  const connection = await env.DB.prepare("SELECT * FROM forge_github_connections WHERE id=?")
    .bind(job.connection_id)
    .first<GithubConnectionRow>();
  if (!connection) return errorResponse(404, "not_found", "GitHub connection was not found.");
  try {
    if (parsed.data.operation === "cleanup") {
      if (job.status !== "completed")
        return errorResponse(409, "conflict", "Runner is still leased.");
      await cleanup(env, job, connection);
      return dataResponse({ cleaned: true });
    }
    if (
      job.status !== "running" ||
      (job.lease_expires_at ?? 0) <= Date.now() ||
      !(await allowed(env, connection, job.runner_id))
    )
      return dataResponse({ allowed: false, assigned: job.assigned === 1 });
    const credentials = await githubCredentials(env, connection);
    const path = githubRepoPath(connection.owner, connection.name);
    if (parsed.data.operation === "status") {
      if (job.github_runner_id === null) return dataResponse({ allowed: false, assigned: false });
      try {
        const runner = z
          .object({ busy: z.boolean() })
          .parse(
            await githubRequest(
              credentials.token,
              `${path}/actions/runners/${job.github_runner_id}`
            )
          );
        return dataResponse({ allowed: true, assigned: job.assigned === 1 || runner.busy });
      } catch (cause) {
        if (cause instanceof GithubApiError && cause.status === 404)
          return dataResponse({ allowed: job.assigned === 1, assigned: job.assigned === 1 });
        throw cause;
      }
    }
    if (job.github_runner_id !== null)
      return errorResponse(409, "conflict", "A temporary runner was already issued.");
    const repo = GithubRepositorySchema.parse(await githubRequest(credentials.token, path));
    const remote = JobSchema.parse(
      await githubRequest(credentials.token, `${path}/actions/jobs/${job.github_job_id}`)
    );
    const required = z.array(z.string()).parse(JSON.parse(job.labels_json));
    if (
      repo.id !== connection.github_repository_id ||
      repo.archived ||
      remote.status !== "queued" ||
      remote.id !== job.github_job_id ||
      remote.run_id !== job.github_run_id ||
      remote.head_sha !== job.head_oid ||
      required.length !== remote.labels.length ||
      !remote.labels.every((label) => required.includes(label))
    )
      return dataResponse({ allowed: false, assigned: false });
    const jit = JitSchema.parse(
      await githubRequest(credentials.token, `${path}/actions/runners/generate-jitconfig`, "POST", {
        name: `gitedge-${job.id}`,
        runner_group_id: 1,
        labels: required,
        work_folder: "_work",
      })
    );
    const stored = await env.DB.prepare(
      `UPDATE actions_github_runner_jobs SET github_runner_id=?,cleanup_pending=1
       WHERE id=? AND status='running' AND github_runner_id IS NULL AND lease_expires_at>?
       AND EXISTS (SELECT 1 FROM actions_runners r WHERE r.id=runner_id AND r.revoked_at IS NULL)
       AND EXISTS (SELECT 1 FROM forge_github_connections c WHERE c.id=connection_id AND c.enabled=1 AND c.runner_enabled=1)`
    )
      .bind(jit.runner.id, job.id, Date.now())
      .run();
    if (stored.meta.changes !== 1) {
      await githubRequest(credentials.token, `${path}/actions/runners/${jit.runner.id}`, "DELETE");
      return dataResponse({ allowed: false, assigned: false });
    }
    if (!(await allowed(env, connection, job.runner_id))) {
      await env.DB.prepare(
        "UPDATE actions_github_runner_jobs SET status='completed',conclusion='cancelled',completed_at=? WHERE id=?"
      )
        .bind(Date.now(), job.id)
        .run();
      await cleanup(env, { ...job, github_runner_id: jit.runner.id }, connection);
      return dataResponse({ allowed: false, assigned: false });
    }
    return dataResponse({
      allowed: true,
      encodedJitConfig: jit.encoded_jit_config,
      githubRunnerId: jit.runner.id,
    });
  } catch (cause) {
    if (parsed.data.operation === "start")
      await env.DB.prepare("UPDATE actions_github_runner_jobs SET cleanup_pending=1 WHERE id=?")
        .bind(job.id)
        .run();
    createLogger(env.LOG_LEVEL, { service: "github-runner" }).warn(
      "github-runner:operation-failed",
      {
        operation: parsed.data.operation,
        id: job.id,
        status: cause instanceof GithubApiError ? cause.status : null,
      }
    );
    return errorResponse(
      503,
      "github_runner_unavailable",
      "The GitHub runner operation failed. Check connection permissions."
    );
  }
}
