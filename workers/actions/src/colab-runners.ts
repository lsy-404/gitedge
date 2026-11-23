import { z } from "zod";
import {
  COLAB_SESSION_MAX_MS,
  RUNNER_TOKEN_PREFIX,
  RunnerLabelsSchema,
  isRunnerSystemLabel,
  runnerTypeRank,
  sha256Hex,
  type ColabDispatchState,
  type ColabDispatchSummary,
  type RunnerJobKind,
  type RunnerOverviewColab,
} from "../../../packages/contracts/src/index";
import { matchesLabels, parseJobClaim } from "../../../packages/contracts/runner-scheduling.mjs";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import {
  ColabAccountUnavailableError,
  colabAccessToken,
  readColabAccount,
  recordComputeUnits,
} from "./colab/account";
import { runCell } from "./colab/kernel";
import { STARTED_MARKER, currentLauncher, launchCell } from "./colab/launch";
import {
  TooManyAssignmentsError,
  assignRuntime,
  findAssignment,
  listAssignmentEndpoints,
  unassignRuntime,
} from "./colab/session-backend";
import { accountScope, readRunnerSettings } from "./github-quota";
import { recentlySeenPrivateRunner } from "./hosted-runners";
import type { RunnerEnv } from "./runners";

const CLAIM_WINDOW_MS = 10 * 60_000;
const BOOTSTRAP_WINDOW_MS = 15 * 60_000;
// Node, the official runner and the runner kit are installed in the fresh runtime first.
const SETUP_ALLOWANCE_MS = 30 * 60_000;
const RETRY_AFTER_MS = 15 * 60_000;
const RETRYABLE_ERRORS = [
  "colab_account_unavailable",
  "colab_assignment_failed",
  "colab_too_many_assignments",
];
const ACTIVE_STATES = "('pending','starting','running')";
const TERMINAL_STATES = "('finished','failed','cancelled')";
const RECENT_LIMIT = 10;
const START_LIMIT = 5;
const RELEASE_LIMIT = 10;
const LAUNCH_TIMEOUT_MS = 120_000;

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

// Dispatches allocate the DEFAULT variant: a Linux x64 CPU runtime.
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
const accountReadyFor = (owner: string): string =>
  `EXISTS (SELECT 1 FROM actions_colab_accounts ca JOIN users cu ON cu.id=ca.owner_id
    WHERE ca.owner_id=${owner} AND ca.error IS NULL AND cu.disabled_at IS NULL)`;

function logger(env: RunnerEnv) {
  return createLogger(env.LOG_LEVEL, { service: "colab-runner" });
}

function reasonOf(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "unknown").slice(0, 300);
}

// Embedded in the launch cell's shell script, so only a plain https origin is accepted.
function colabOrigin(env: RunnerEnv): string | null {
  const value = env.PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin === value.replace(/\/$/, "") && origin.startsWith("https://") ? origin : null;
  } catch {
    return null;
  }
}

async function revokeRunner(env: RunnerEnv, runnerId: string | null, now: number): Promise<void> {
  if (!runnerId) return;
  await env.DB.prepare("UPDATE actions_runners SET revoked_at=COALESCE(revoked_at,?) WHERE id=?")
    .bind(now, runnerId)
    .run();
}

async function settleDispatches(env: RunnerEnv, now: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM actions_colab_dispatches WHERE state='failed' AND error IN (${RETRYABLE_ERRORS.map(() => "?").join(",")}) AND created_at<?
      AND (claimed_at IS NULL OR released_at IS NOT NULL)`
  )
    .bind(...RETRYABLE_ERRORS, now - RETRY_AFTER_MS)
    .run();
  const rows = await env.DB.prepare(
    `SELECT d.id,d.runner_id,
      CASE
        WHEN d.state='running' AND ${jobCompletedOnRunner} THEN 'finished'
        WHEN d.state='pending' AND d.expires_at<=? THEN 'failed:colab_account_unavailable'
        WHEN d.state='starting' AND d.claimed_at<=? THEN 'failed:colab_bootstrap_timeout'
        WHEN d.expires_at<=? THEN 'failed:colab_session_expired'
        WHEN d.state IN ('pending','starting') AND NOT (${colabEnabledFor("d.owner_id")} AND ${accountReadyFor("d.owner_id")}) THEN 'cancelled'
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

interface ReleaseRow {
  id: string;
  owner_id: string;
  colab_endpoint: string | null;
}

/** Unassigns the dispatch's runtime and marks it released; throws while Colab still holds it. */
async function releaseDispatch(env: RunnerEnv, row: ReleaseRow): Promise<void> {
  const accessToken = await colabAccessToken(env, row.owner_id);
  // Without a stored endpoint, the dispatch id as notebook hash finds an allocation that raced the failure.
  const endpoint =
    row.colab_endpoint ?? (await findAssignment(accessToken, row.id))?.endpoint ?? null;
  if (endpoint) {
    try {
      await unassignRuntime(accessToken, endpoint);
    } catch (cause) {
      if ((await listAssignmentEndpoints(accessToken)).includes(endpoint)) throw cause;
    }
  }
  await env.DB.prepare(
    "UPDATE actions_colab_dispatches SET released_at=? WHERE id=? AND released_at IS NULL"
  )
    .bind(Date.now(), row.id)
    .run();
  logger(env).info("colab-runner:runtime-released", { id: row.id, endpoint });
}

async function releaseDispatches(env: RunnerEnv): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT d.id,d.owner_id,d.colab_endpoint FROM actions_colab_dispatches d
    WHERE d.released_at IS NULL AND d.claimed_at IS NOT NULL AND d.state IN ${TERMINAL_STATES}
      AND ${accountReadyFor("d.owner_id")}
    ORDER BY d.claimed_at LIMIT ${RELEASE_LIMIT}`
  ).all<ReleaseRow>();
  for (const row of rows.results)
    await releaseDispatch(env, row).catch((cause: unknown) =>
      logger(env).warn("colab-runner:release-failed", { id: row.id, reason: reasonOf(cause) })
    );
}

/** Cancels the owner's active dispatches and releases their runtimes, for a disconnecting account. */
export async function stopOwnerDispatches(env: RunnerEnv, ownerId: string): Promise<void> {
  const now = Date.now();
  const active = await env.DB.prepare(
    `UPDATE actions_colab_dispatches SET state='cancelled',bootstrap_token_hash=NULL
    WHERE owner_id=? AND state IN ${ACTIVE_STATES} RETURNING runner_id`
  )
    .bind(ownerId)
    .all<{ runner_id: string | null }>();
  for (const row of active.results) await revokeRunner(env, row.runner_id, now);
  const rows = await env.DB.prepare(
    `SELECT id,owner_id,colab_endpoint FROM actions_colab_dispatches
    WHERE owner_id=? AND released_at IS NULL AND claimed_at IS NOT NULL`
  )
    .bind(ownerId)
    .all<ReleaseRow>();
  for (const row of rows.results)
    await releaseDispatch(env, row).catch((cause: unknown) =>
      logger(env).warn("colab-runner:release-failed", { id: row.id, reason: reasonOf(cause) })
    );
}

interface StartingDispatch {
  id: string;
  owner_id: string;
  expires_at: number;
}

async function launchDispatch(
  env: RunnerEnv,
  dispatch: StartingDispatch,
  bootstrapToken: string,
  origin: string
): Promise<void> {
  let reason = "colab_account_unavailable";
  try {
    const accessToken = await colabAccessToken(env, dispatch.owner_id);
    await recordComputeUnits(env, dispatch.owner_id, accessToken);
    reason = "colab_assignment_failed";
    const runtime = await assignRuntime(accessToken, dispatch.id).catch((cause: unknown) => {
      if (cause instanceof TooManyAssignmentsError) reason = "colab_too_many_assignments";
      throw cause;
    });
    const stored = await env.DB.prepare(
      "UPDATE actions_colab_dispatches SET colab_endpoint=? WHERE id=? AND state='starting' RETURNING id"
    )
      .bind(runtime.endpoint, dispatch.id)
      .first<{ id: string }>();
    if (!stored) {
      // The dispatch ended while Colab allocated, so its release may already have run without this endpoint.
      await env.DB.prepare(
        "UPDATE actions_colab_dispatches SET colab_endpoint=?,released_at=NULL WHERE id=?"
      )
        .bind(runtime.endpoint, dispatch.id)
        .run();
      await releaseDispatch(env, {
        id: dispatch.id,
        owner_id: dispatch.owner_id,
        colab_endpoint: runtime.endpoint,
      }).catch((error: unknown) =>
        logger(env).warn("colab-runner:release-failed", {
          id: dispatch.id,
          reason: reasonOf(error),
        })
      );
      return;
    }
    reason = "colab_launch_failed";
    const launcher = await currentLauncher(env);
    const result = await runCell(
      runtime,
      launchCell({ origin, bootstrapToken, launcher }),
      STARTED_MARKER,
      LAUNCH_TIMEOUT_MS
    );
    if (result.status !== "matched") throw new Error(result.output || "The launch cell failed.");
    logger(env).info("colab-runner:runner-starting", {
      id: dispatch.id,
      endpoint: runtime.endpoint,
    });
  } catch (cause) {
    if (cause instanceof ColabAccountUnavailableError) reason = "colab_account_unavailable";
    logger(env).warn("colab-runner:start-failed", {
      id: dispatch.id,
      reason,
      detail: reasonOf(cause),
    });
    await env.DB.prepare(
      "UPDATE actions_colab_dispatches SET state='failed',error=?,bootstrap_token_hash=NULL WHERE id=? AND state='starting'"
    )
      .bind(reason, dispatch.id)
      .run();
    const row = await env.DB.prepare(
      "SELECT id,owner_id,colab_endpoint FROM actions_colab_dispatches WHERE id=? AND released_at IS NULL"
    )
      .bind(dispatch.id)
      .first<ReleaseRow>();
    if (row)
      await releaseDispatch(env, row).catch((error: unknown) =>
        logger(env).warn("colab-runner:release-failed", {
          id: dispatch.id,
          reason: reasonOf(error),
        })
      );
  }
}

async function startPendingDispatches(
  env: RunnerEnv,
  ctx: ExecutionContext,
  now: number
): Promise<void> {
  const candidates = await env.DB.prepare(
    `SELECT d.id FROM actions_colab_dispatches d WHERE d.state='pending' AND d.expires_at>?
      AND ${colabEnabledFor("d.owner_id")} AND ${accountReadyFor("d.owner_id")} AND ${jobStillQueued}
    ORDER BY d.created_at LIMIT ${START_LIMIT}`
  )
    .bind(now)
    .all<{ id: string }>();
  if (candidates.results.length === 0) return;
  const origin = colabOrigin(env);
  if (!origin) {
    logger(env).warn("colab-runner:origin-missing");
    return;
  }
  for (const candidate of candidates.results) {
    const token = randomHex(32);
    const claimed = await env.DB.prepare(
      `UPDATE actions_colab_dispatches SET state='starting',claimed_at=?,bootstrap_token_hash=?,expires_at=?+session_ms
      WHERE id=? AND state='pending' RETURNING id,owner_id,expires_at`
    )
      .bind(now, await sha256Hex(token), now, candidate.id)
      .first<StartingDispatch>();
    if (!claimed) continue;
    logger(env).info("colab-runner:dispatch-starting", { id: claimed.id });
    ctx.waitUntil(
      launchDispatch(env, claimed, token, origin).catch((cause: unknown) =>
        logger(env).error("colab-runner:start-crashed", {
          id: claimed.id,
          reason: reasonOf(cause),
        })
      )
    );
  }
}

export async function reconcileColabRunners(env: RunnerEnv, ctx: ExecutionContext): Promise<void> {
  const now = Date.now();
  await settleDispatches(env, now);
  await releaseDispatches(env);
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const ownerReady = `${colabEnabledFor("q.owner_id")} AND ${accountReadyFor("q.owner_id")}`;
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
    .bind(monthStart, now - 15 * 60_000, now - 5 * 60_000, now - 15 * 60_000, now - 5 * 60_000)
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
        ? (await readRunnerSettings(env.DB, scope.namespaceId)).onDemandPriority
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
      logger(env).info("colab-runner:dispatch-created", { jobKind: job.kind, jobId: job.id });
  }
  await startPendingDispatches(env, ctx, now);
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
    WHERE d.bootstrap_token_hash=? AND d.state='starting' AND d.claimed_at>? AND d.expires_at>?
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
        WHERE d.id=? AND d.bootstrap_token_hash=? AND d.state='starting' AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
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
  const recent = await db
    .prepare(
      `SELECT job_id AS jobId,state,created_at AS createdAt,error FROM actions_colab_dispatches
      WHERE owner_id=? ORDER BY created_at DESC LIMIT ${RECENT_LIMIT}`
    )
    .bind(userId)
    .all<ColabDispatchSummary>();
  return { enabled, account: await readColabAccount(db, userId), recent: recent.results };
}
