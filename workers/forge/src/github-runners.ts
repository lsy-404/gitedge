import { z } from "zod";
import {
  GitHubRunnerOperationSchema,
  type GitHubRunnerJobRecord,
} from "../../../packages/contracts/src/runners";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { createLogger } from "../../../src/worker/common/logger";
import { githubCredentials, type GithubConnectionRow } from "./github-sync-store";
import {
  GithubApiError,
  githubRepoPath,
  githubRequest,
  GithubRepositorySchema,
} from "./github-client";
import type { ForgeEnv } from "./common";

const JobSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  head_sha: z.string(),
  status: z.enum(["queued", "in_progress", "completed", "waiting", "pending"]),
  labels: z.array(z.string()).max(40),
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
  await env.DB.prepare("UPDATE actions_github_runner_jobs SET cleanup_pending=0 WHERE id=?")
    .bind(job.id)
    .run();
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
