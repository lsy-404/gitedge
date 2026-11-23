import { z } from "zod";
import {
  COLAB_SESSION_MAX_MS,
  COLAB_WAKER_STALE_MS,
  ColabDispatchReportSchema,
  RUNNER_TOKEN_PREFIX,
  RunnerLabelsSchema,
  isRunnerSystemLabel,
  runnerTypeRank,
  sha256Hex,
  type ColabDispatchState,
  type ColabDispatchSummary,
  type ColabWaker,
  type RunnerJobKind,
  type RunnerOverviewColab,
} from "../../../packages/contracts/src/index";
import { matchesLabels, parseJobClaim } from "../../../packages/contracts/runner-scheduling.mjs";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { accountScope, readRunnerSettings } from "./github-quota";
import { recentlySeenPrivateRunner } from "./hosted-runners";
import { currentRunnerKit } from "./runner-kit";
import type { RunnerEnv, RunnerRow } from "./runners";

const CLAIM_WINDOW_MS = 10 * 60_000;
const BOOTSTRAP_WINDOW_MS = 15 * 60_000;
// Node, the official runner and the runner kit are installed in the fresh runtime first.
const SETUP_ALLOWANCE_MS = 30 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const RETRYABLE_ERRORS = ["colab_waker_unavailable", "colab_connection_failed"];
const ACTIVE_STATES = "('pending','claimed','starting','running')";
const RECENT_LIMIT = 10;

const bootstrapSchema = z
  .object({
    bootstrapToken: z.string().regex(/^[a-f0-9]{64}$/),
    labels: RunnerLabelsSchema,
  })
  .strict();

interface QueuedColabJob {
  kind: RunnerJobKind;
  id: string;
  repository_id: string;
  owner_id: string;
  namespace_id: string;
  labels_json: string;
  default_minutes: number;
  github_connection: string | null;
  quota_exhausted: number;
  hosted_status: string | null;
}

interface DispatchRow {
  id: string;
  owner_id: string;
  job_kind: RunnerJobKind;
  job_id: string;
  repository_id: string;
  session_ms: number;
  state: ColabDispatchState;
  waker_runner_id: string | null;
  runner_id: string | null;
  claimed_at: number | null;
  expires_at: number;
  error: string | null;
}

function jobLabels(json: string): string[] | null {
  try {
    return RunnerLabelsSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

// Colab runtimes are Linux x64 without a selectable accelerator through colab-mcp.
export function colabSessionMs(labels: string[], defaultMinutes: number): number | null {
  const claim = parseJobClaim(labels, defaultMinutes);
  if (!claim.valid || claim.gpuVendor || claim.vramMb) return null;
  const normalized = labels.map((label) => label.toLowerCase());
  if (normalized.some((label) => ["windows", "macos"].includes(label))) return null;
  if (normalized.some((label) => ["arm", "arm64", "aarch64"].includes(label))) return null;
  const sessionMs = claim.minutes * 60_000 + SETUP_ALLOWANCE_MS;
  return sessionMs <= COLAB_SESSION_MAX_MS ? sessionMs : null;
}

const jobStillQueued = `((d.job_kind='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=d.job_id AND j.status='queued'))
  OR (d.job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=d.job_id AND j.status='queued')))`;
const jobRunningOnRunner = `((d.job_kind='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=d.job_id AND j.status='running' AND j.runner_id=d.runner_id))
  OR (d.job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=d.job_id AND j.status='running' AND j.runner_id=d.runner_id)))`;
const jobCompletedOnRunner = `((d.job_kind='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=d.job_id AND j.status='completed' AND j.runner_id=d.runner_id))
  OR (d.job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=d.job_id AND j.status='completed' AND j.runner_id=d.runner_id)))`;
const colabEnabledFor = (owner: string): string =>
  `EXISTS (SELECT 1 FROM actions_runner_settings rs JOIN namespaces rn ON rn.id=rs.namespace_id
    WHERE rn.kind='personal' AND rn.created_by=${owner} AND rs.colab_enabled=1)`;

async function revokeRunner(env: RunnerEnv, runnerId: string | null, now: number): Promise<void> {
  if (!runnerId) return;
  await env.DB.prepare("UPDATE actions_runners SET revoked_at=COALESCE(revoked_at,?) WHERE id=?")
    .bind(now, runnerId)
    .run();
}

async function settleDispatches(env: RunnerEnv, now: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM actions_colab_dispatches WHERE state='failed' AND error IN (${RETRYABLE_ERRORS.map(() => "?").join(",")}) AND created_at<?`
  )
    .bind(...RETRYABLE_ERRORS, now - RETRY_AFTER_MS)
    .run();
  const rows = await env.DB.prepare(
    `SELECT d.id,d.runner_id,
      CASE
        WHEN d.state='running' AND ${jobCompletedOnRunner} THEN 'finished'
        WHEN d.state='pending' AND d.expires_at<=? THEN 'failed:colab_waker_unavailable'
        WHEN d.state IN ('claimed','starting') AND d.claimed_at<=? THEN 'failed:colab_bootstrap_timeout'
        WHEN d.expires_at<=? THEN 'failed:colab_session_expired'
        WHEN d.state IN ('pending','claimed','starting') AND NOT ${colabEnabledFor("d.owner_id")} THEN 'cancelled'
        WHEN NOT ${jobStillQueued} AND NOT (d.state='running' AND ${jobRunningOnRunner}) THEN 'cancelled'
        WHEN EXISTS (SELECT 1 FROM users u WHERE u.id=d.owner_id AND u.disabled_at IS NOT NULL) THEN 'cancelled'
      END AS outcome
    FROM actions_colab_dispatches d WHERE d.state IN ${ACTIVE_STATES} LIMIT 50`
  )
    .bind(now, now - BOOTSTRAP_WINDOW_MS, now)
    .all<{ id: string; runner_id: string | null; outcome: string | null }>();
  for (const row of rows.results) {
    if (!row.outcome) continue;
    const [state, error] = row.outcome.split(":");
    await env.DB.prepare(
      `UPDATE actions_colab_dispatches SET state=?,error=COALESCE(?,error),bootstrap_token_hash=NULL WHERE id=? AND state IN ${ACTIVE_STATES}`
    )
      .bind(state, error ?? null, row.id)
      .run();
    await revokeRunner(env, row.runner_id, now);
  }
}

export async function reconcileColabRunners(env: RunnerEnv): Promise<void> {
  const now = Date.now();
  await settleDispatches(env, now);
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const ownerReady = `${colabEnabledFor("q.owner_id")} AND EXISTS (SELECT 1 FROM actions_runners w JOIN users wu ON wu.id=w.created_by
    WHERE w.created_by=q.owner_id AND w.revoked_at IS NULL AND w.hosted_job_id IS NULL AND wu.disabled_at IS NULL AND w.colab_waker_seen_at>?)`;
  const jobs = await env.DB.prepare(
    `SELECT q.*,
      (SELECT h.connection_id FROM forge_hosted_runner_settings h WHERE h.owner_id=q.owner_id) AS github_connection,
      EXISTS (SELECT 1 FROM actions_github_quota gq JOIN namespaces qn ON qn.id=gq.namespace_id
        WHERE qn.kind='personal' AND qn.created_by=q.owner_id AND gq.state='exhausted' AND gq.checked_at>=?) AS quota_exhausted,
      (SELECT h.status FROM actions_hosted_runner_dispatches h WHERE h.job_kind=q.kind AND h.job_id=q.id) AS hosted_status
    FROM (
      SELECT 'gitedge' AS kind,j.run_id AS id,p.id AS repository_id,a.created_by AS owner_id,p.namespace_id,j.labels_json,j.timeout_minutes AS default_minutes,a.created_at
        FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id JOIN repositories p ON p.id=a.repository_id LEFT JOIN actions_signing_runs s ON s.run_id=j.run_id
        WHERE j.status='queued' AND s.run_id IS NULL AND (a.created_at<=? OR NOT ${recentlySeenPrivateRunner(false)})
          AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1 AND p.actions_runner_enabled=1
      UNION ALL
      SELECT 'github',j.id,p.id,c.created_by,p.namespace_id,j.labels_json,360,j.created_at
        FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id JOIN repositories p ON p.id=c.repository_id
        WHERE j.status='queued' AND (j.created_at<=? OR NOT ${recentlySeenPrivateRunner(false)})
          AND c.enabled=1 AND c.runner_enabled=1 AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
    ) q
    WHERE ${ownerReady}
      AND NOT EXISTS (SELECT 1 FROM actions_colab_dispatches d WHERE d.job_kind=q.kind AND d.job_id=q.id)
      AND NOT EXISTS (SELECT 1 FROM actions_hosted_runner_dispatches h WHERE h.job_kind=q.kind AND h.job_id=q.id
        AND h.status IN ('dispatching','dispatched','consumed','cancel_pending'))
    ORDER BY q.created_at,q.id LIMIT 10`
  )
    .bind(
      monthStart,
      now - 15 * 60_000,
      now - 5 * 60_000,
      now - 15 * 60_000,
      now - 5 * 60_000,
      now - COLAB_WAKER_STALE_MS
    )
    .all<QueuedColabJob>();
  const priorities = new Map<string, boolean>();
  for (const job of jobs.results) {
    const labels = jobLabels(job.labels_json);
    const sessionMs = labels ? colabSessionMs(labels, job.default_minutes) : null;
    if (sessionMs === null) continue;
    let colabFirst = priorities.get(job.owner_id);
    if (colabFirst === undefined) {
      const scope = await accountScope(env.DB, job.owner_id);
      const priority = scope
        ? (await readRunnerSettings(env.DB, scope.namespaceId)).typePriority
        : null;
      colabFirst =
        priority !== null &&
        runnerTypeRank(priority, "colab") < runnerTypeRank(priority, "github-hosted");
      priorities.set(job.owner_id, colabFirst);
    }
    // The GitHub tier keeps the job when it ranks first and can still take it.
    const githubCanTake =
      job.github_connection !== null && job.quota_exhausted !== 1 && job.hosted_status !== "failed";
    if (!colabFirst && githubCanTake) continue;
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO actions_colab_dispatches (id,owner_id,job_kind,job_id,repository_id,session_ms,state,created_at,expires_at)
      SELECT ?,?,?,?,?,?,'pending',?,? WHERE (?='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs WHERE run_id=? AND status='queued'))
        OR (?='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs WHERE id=? AND status='queued'))`
    )
      .bind(
        crypto.randomUUID(),
        job.owner_id,
        job.kind,
        job.id,
        job.repository_id,
        sessionMs,
        now,
        now + CLAIM_WINDOW_MS,
        job.kind,
        job.id,
        job.kind,
        job.id
      )
      .run();
    if (inserted.meta.changes === 1)
      createLogger(env.LOG_LEVEL, { service: "colab-runner" }).info(
        "colab-runner:dispatch-created",
        {
          jobKind: job.kind,
          jobId: job.id,
        }
      );
  }
}

async function touchWaker(env: RunnerEnv, runnerId: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE actions_runners SET colab_waker_seen_at=? WHERE id=?")
    .bind(now, runnerId)
    .run();
}

async function claimDispatch(env: RunnerEnv, runner: RunnerRow): Promise<Response> {
  const now = Date.now();
  await touchWaker(env, runner.id, now);
  const token = randomHex(32);
  const claimed = await env.DB.prepare(
    `UPDATE actions_colab_dispatches SET state='claimed',waker_runner_id=?,claimed_at=?,bootstrap_token_hash=?,expires_at=?+session_ms
    WHERE id=(SELECT d.id FROM actions_colab_dispatches d WHERE d.owner_id=? AND d.state='pending' AND d.expires_at>?
      AND ${colabEnabledFor("d.owner_id")} AND ${jobStillQueued} ORDER BY d.created_at LIMIT 1)
    AND state='pending' RETURNING id,job_kind,job_id,expires_at`
  )
    .bind(runner.id, now, await sha256Hex(token), now, runner.created_by, now)
    .first<{ id: string; job_kind: RunnerJobKind; job_id: string; expires_at: number }>();
  const kit = await currentRunnerKit(env);
  if (!claimed) return dataResponse({ dispatch: null, kit });
  createLogger(env.LOG_LEVEL, { service: "colab-runner" }).info("colab-runner:dispatch-claimed", {
    id: claimed.id,
    wakerId: runner.id,
  });
  return dataResponse({
    dispatch: {
      id: claimed.id,
      jobKind: claimed.job_kind,
      jobId: claimed.job_id,
      bootstrapToken: token,
      bootstrapBy: now + BOOTSTRAP_WINDOW_MS,
      expiresAt: claimed.expires_at,
    },
    kit,
  });
}

async function reportDispatch(
  request: Request,
  env: RunnerEnv,
  runner: RunnerRow,
  id: string
): Promise<Response> {
  const now = Date.now();
  await touchWaker(env, runner.id, now);
  const body = ColabDispatchReportSchema.safeParse(await readJsonLimited(request, 2048));
  if (!body.success) return errorResponse(400, "bad_request", "Invalid Colab dispatch report.");
  const row = await env.DB.prepare(
    "SELECT * FROM actions_colab_dispatches WHERE id=? AND waker_runner_id=?"
  )
    .bind(id, runner.id)
    .first<DispatchRow>();
  if (!row) return errorResponse(404, "not_found", "Colab dispatch was not found.");
  const { state, error } = body.data;
  if (state === "starting")
    await env.DB.prepare(
      "UPDATE actions_colab_dispatches SET state='starting' WHERE id=? AND state='claimed'"
    )
      .bind(id)
      .run();
  else if (state === "finished" || state === "failed") {
    // A runner that exits without ever bootstrapping never took the job.
    const finished = state === "finished" && row.runner_id !== null;
    const next: ColabDispatchState = finished ? "finished" : "failed";
    const reason = finished
      ? null
      : (error ?? (state === "finished" ? "colab_runner_exited" : "colab_session_failed"));
    await env.DB.prepare(
      `UPDATE actions_colab_dispatches SET state=?,error=COALESCE(?,error),bootstrap_token_hash=NULL WHERE id=? AND state IN ${ACTIVE_STATES}`
    )
      .bind(next, reason, id)
      .run();
    await revokeRunner(env, row.runner_id, now);
    if (next === "failed")
      createLogger(env.LOG_LEVEL, { service: "colab-runner" }).warn("colab-runner:session-failed", {
        id,
        reason,
      });
  }
  const current = await env.DB.prepare(
    "SELECT state,error,expires_at FROM actions_colab_dispatches WHERE id=?"
  )
    .bind(id)
    .first<{ state: ColabDispatchState; error: string | null; expires_at: number }>();
  return dataResponse({
    state: current?.state ?? "cancelled",
    error: current?.error ?? null,
    expiresAt: current?.expires_at ?? now,
  });
}

// Runner-credential routes for the host that wakes Colab sessions.
export async function colabWakerRequest(
  request: Request,
  env: RunnerEnv,
  runner: RunnerRow,
  pathname: string
): Promise<Response> {
  if (runner.hosted_job_id)
    return errorResponse(403, "forbidden", "Ephemeral runners cannot wake Colab sessions.");
  if (pathname === "/runner/colab/claim") return claimDispatch(env, runner);
  const report = /^\/runner\/colab\/dispatches\/([0-9a-f-]{36})$/.exec(pathname);
  if (report) return reportDispatch(request, env, runner, report[1]);
  return errorResponse(404, "not_found", "Colab endpoint was not found.");
}

export async function bootstrapColabRunner(request: Request, env: RunnerEnv): Promise<Response> {
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const input = bootstrapSchema.safeParse(await readJsonLimited(request, 8192));
  if (!input.success) return errorResponse(400, "bad_request", "Invalid Colab runner bootstrap.");
  const hash = await sha256Hex(input.data.bootstrapToken);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT d.*,p.namespace_id,p.slug AS repository,n.slug AS owner,
      CASE WHEN d.job_kind='gitedge' THEN (SELECT labels_json FROM actions_runner_runs WHERE run_id=d.job_id)
        ELSE (SELECT labels_json FROM actions_github_runner_jobs WHERE id=d.job_id) END AS labels_json
    FROM actions_colab_dispatches d JOIN repositories p ON p.id=d.repository_id JOIN namespaces n ON n.id=p.namespace_id
    JOIN users u ON u.id=d.owner_id AND u.disabled_at IS NULL
    WHERE d.bootstrap_token_hash=? AND d.state IN ('claimed','starting') AND d.claimed_at>? AND d.expires_at>?
      AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1`
  )
    .bind(hash, now - BOOTSTRAP_WINDOW_MS, now)
    .first<
      DispatchRow & { namespace_id: string; repository: string; owner: string; labels_json: string }
    >();
  if (!row) return errorResponse(401, "unauthorized", "Colab runner bootstrap is unavailable.");
  const required = jobLabels(row.labels_json);
  if (!required) return errorResponse(422, "invalid_job", "The job labels are invalid.");
  const claim = parseJobClaim(required);
  const host = input.data.labels.map((label) => label.toLowerCase());
  if (
    !host.includes("linux") ||
    !host.includes("x64") ||
    host.some((label) => ["windows", "macos", "arm64"].includes(label)) ||
    claim.labels.filter(isRunnerSystemLabel).some((label) => {
      const value = label.toLowerCase();
      if (["amd64", "x86_64"].includes(value)) return false;
      return !matchesLabels([label], input.data.labels);
    })
  )
    return errorResponse(422, "invalid_job", "The Colab runtime does not match the job platform.");
  const labels = RunnerLabelsSchema.safeParse([
    ...input.data.labels,
    ...claim.labels.filter((label) => !host.includes(label.toLowerCase())),
  ]);
  if (!claim.valid || !labels.success)
    return errorResponse(422, "invalid_job", "The job labels are invalid.");
  const id = crypto.randomUUID(),
    token = `${RUNNER_TOKEN_PREFIX}${randomHex(32)}`;
  const [insert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at,hosted_job_kind,hosted_job_id,hosted_type,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'colab',? WHERE EXISTS (SELECT 1 FROM actions_colab_dispatches d JOIN repositories p ON p.id=d.repository_id
        WHERE d.id=? AND d.bootstrap_token_hash=? AND d.state IN ('claimed','starting') AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
        AND ${colabEnabledFor("d.owner_id")} AND ((d.job_kind='gitedge' AND p.actions_runner_enabled=1 AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=d.job_id AND j.status='queued'))
          OR (d.job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id WHERE j.id=d.job_id AND j.status='queued' AND c.enabled=1 AND c.runner_enabled=1))))`
    ).bind(
      id,
      "Colab runner",
      row.namespace_id,
      row.repository_id,
      row.owner_id,
      JSON.stringify(labels.data),
      await sha256Hex(token),
      now,
      row.job_kind,
      row.job_id,
      row.expires_at,
      row.id,
      hash
    ),
    env.DB.prepare(
      "UPDATE actions_colab_dispatches SET state='running',runner_id=?,bootstrap_token_hash=NULL WHERE id=? AND bootstrap_token_hash=? AND EXISTS (SELECT 1 FROM actions_runners WHERE id=?)"
    ).bind(id, row.id, hash, id),
  ]);
  if (insert.meta.changes !== 1)
    return errorResponse(422, "invalid_job", "The queued job is no longer available.");
  return dataResponse({
    runner: {
      id,
      scope: { owner: row.owner, repository: row.repository },
      labels: labels.data,
      expiresAt: row.expires_at,
    },
    token,
  });
}

export async function readColabOverview(
  db: D1Database,
  userId: string,
  enabled: boolean
): Promise<RunnerOverviewColab> {
  const wakers = await db
    .prepare(
      `SELECT id AS runnerId,name,colab_waker_seen_at AS lastSeenAt FROM actions_runners
      WHERE created_by=? AND revoked_at IS NULL AND hosted_job_id IS NULL AND colab_waker_seen_at IS NOT NULL
      ORDER BY colab_waker_seen_at DESC LIMIT ${RECENT_LIMIT}`
    )
    .bind(userId)
    .all<ColabWaker>();
  const recent = await db
    .prepare(
      `SELECT job_id AS jobId,state,created_at AS createdAt,error FROM actions_colab_dispatches
      WHERE owner_id=? ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`
    )
    .bind(userId)
    .all<ColabDispatchSummary>();
  return { enabled, wakers: wakers.results, recent: recent.results };
}
