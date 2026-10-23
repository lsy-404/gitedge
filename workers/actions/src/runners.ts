import { z } from "zod";
import {
  RegisterRunnerInputSchema,
  RunnerCustomLabelsSchema,
  RunnerLabelsSchema,
  RunnerClaimLabelSnapshotSchema,
  RunnerCompleteInputSchema,
  RunnerLeaseInputSchema,
  type RunnerBudget,
  type RunnerCapacity,
  RUNNER_TOKEN_PREFIX,
  RUNNER_LEASE_MS,
  RUNNER_LOG_BYTES,
  sha256Hex,
  accessTokenAllows,
  accessTokenAllowsRepository,
  isRunnerSystemLabel,
  type RegisteredRunner,
  type RunnerScope,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type {
  ActionEventType,
  ActionRun,
  ActionRunSummary,
} from "../../../packages/contracts/src/actions";
import { readJsonLimited, readTextLimited } from "../../../src/worker/common/readText";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { randomHex } from "../../../src/worker/common/encoding";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { createLogger } from "../../../src/worker/common/logger";
import { publishCheck } from "./check-delivery";
import type { RunnerWorkflow } from "./runner-workflow";
import { claimGithubRunner, githubRunnerLease } from "./github-runners";
import { notifyRunnerDispatch, type RunnerDispatch } from "./runner-dispatch";
import { handleSigningMachineCallback } from "./signing-execution";
import {
  claimRunnerCandidate,
  clearRunnerDeferral,
  clearRunnerFailures,
  type EvaluatedRunnerCandidate,
  type RunnerCandidate,
  recordRunnerFailure,
} from "./runner-scheduler";

export interface RunnerEnv {
  DB: D1Database;
  AUTH?: Pick<Fetcher, "fetch">;
  FORGE: Pick<Fetcher, "fetch">;
  GIT?: Pick<Fetcher, "fetch">;
  RUNNER_DISPATCH?: DurableObjectNamespace<RunnerDispatch>;
  LOG_LEVEL?: string;
}
export interface RunnerRow {
  id: string;
  name: string;
  namespace_id: string;
  repository_id: string | null;
  created_by: string;
  labels_json: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  owner: string;
  repository: string | null;
  capacity_json: string | null;
  budget_json: string | null;
  capacity_reported_at: number | null;
  consecutive_failures: number;
  held_until: number | null;
  connected: number;
}
interface RunRow {
  id: string;
  repository_id: string;
  commit_oid: string;
  workflow: string;
  path: string;
  source_ref: string;
  created_by: string;
  created_at: number;
  trigger_kind: ActionEventType;
  status: "queued" | "running" | "completed";
  conclusion: "success" | "failure" | "cancelled" | null;
  workflow_source: string;
  labels_json: string;
  permission: "read" | "write";
  timeout_minutes: number;
  event_json: string;
  started_at: number | null;
  completed_at: number | null;
  runner_id: string | null;
  lease_hash: string | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  log: string;
  log_truncated: number;
  owner: string;
  repository: string;
  namespace_id: string;
}
export const runnersSelect = `SELECT r.*, n.slug AS owner, p.slug AS repository FROM actions_runners r
  JOIN namespaces n ON n.id = r.namespace_id LEFT JOIN repositories p ON p.id = r.repository_id`;
const runsSelect = `SELECT a.*, j.*, n.slug AS owner, p.slug AS repository, p.namespace_id FROM actions_runs a
  JOIN actions_runner_runs j ON j.run_id = a.id JOIN repositories p ON p.id = a.repository_id
  JOIN namespaces n ON n.id = p.namespace_id`;
const tokenPattern = /^Bearer (ge_runner_[0-9a-f]{64})$/i;

function labels(json: string): string[] {
  return z.array(z.string()).parse(JSON.parse(json));
}
function scope(row: RunnerRow): RunnerScope {
  return { owner: row.owner, ...(row.repository === null ? {} : { repository: row.repository }) };
}
function presentedRunner(row: RunnerRow): RegisteredRunner {
  return {
    id: row.id,
    name: row.name,
    scope: scope(row),
    labels: labels(row.labels_json),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}
async function ownsScope(
  env: RunnerEnv,
  userId: string,
  namespaceId: string,
  repositoryId: string | null
): Promise<boolean> {
  if (repositoryId !== null)
    return (await repositoryRole(env.DB, repositoryId, userId)) === "admin";
  return (
    (await env.DB.prepare(
      "SELECT 1 AS found FROM namespace_memberships WHERE namespace_id = ? AND user_id = ? AND role = 'owner'"
    )
      .bind(namespaceId, userId)
      .first()) !== null
  );
}
function registrationScopeAllowed(user: TrustedUser, repositoryId: string | null): boolean {
  return (
    !user.agentSession &&
    !user.job &&
    (!user.token ||
      (accessTokenAllows(user.token, "admin") &&
        (repositoryId === null
          ? !user.token.repositoryIds
          : accessTokenAllowsRepository(user.token, repositoryId))))
  );
}

export async function authenticateRunner(
  request: Request,
  env: RunnerEnv
): Promise<RunnerRow | null> {
  const token = tokenPattern.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) return null;
  const row = await env.DB.prepare(
    `${runnersSelect} JOIN users u ON u.id = r.created_by
    WHERE r.token_hash = ? AND r.revoked_at IS NULL AND u.disabled_at IS NULL
    AND (r.repository_id IS NULL OR (p.deleted_at IS NULL AND p.namespace_id = r.namespace_id))`
  )
    .bind(await sha256Hex(token))
    .first<RunnerRow>();
  return row && (await ownsScope(env, row.created_by, row.namespace_id, row.repository_id))
    ? row
    : null;
}

async function authenticateSigningJob(request: Request, env: RunnerEnv): Promise<string | null> {
  const token = /^Bearer (ge_job_[0-9a-f]{64})$/.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1];
  if (!token) return null;
  const match =
    /^\/runner\/signing\/requests\/([0-9a-f-]{36})\/(start|heartbeat|download|authorize-sign|output(?:\/parts\/\d+|\/complete)?|complete|fail)$/i.exec(
      new URL(request.url).pathname
    );
  const runId = request.headers.get("X-Runner-Run-Id") ?? "";
  const leaseToken = request.headers.get("X-Runner-Lease-Token") ?? "";
  if (!match || !/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f]{64}$/i.test(leaseToken)) return null;

  const operation = match[2];
  const requestId = match[1];
  const now = Date.now();
  const [tokenHash, leaseHash] = await Promise.all([sha256Hex(token), sha256Hex(leaseToken)]);
  let authJob: { runId: string; repositoryId: string; ownerId: string } | null = null;
  if (env.AUTH) {
    try {
      const response = await env.AUTH.fetch(
        new Request("https://auth.internal/session", {
          headers: { Authorization: `Bearer ${token}` },
        })
      );
      const body: unknown = JSON.parse((await readTextLimited(response.body, 8192)) ?? "null");
      const session = z
        .object({
          data: z.object({
            id: z.string().uuid(),
            job: z.object({ runId: z.string().uuid(), repositoryId: z.string().uuid() }),
          }),
        })
        .safeParse(body);
      if (response.ok && session.success)
        authJob = {
          runId: session.data.data.job.runId,
          repositoryId: session.data.data.job.repositoryId,
          ownerId: session.data.data.id,
        };
    } catch {
      authJob = null;
    }
  }
  if (authJob?.runId === runId) {
    const active = await env.DB.prepare(
      `SELECT j.runner_id FROM actions_runner_runs j
       JOIN actions_runs a ON a.id=j.run_id JOIN actions_signing_runs s ON s.run_id=j.run_id
       JOIN actions_job_tokens t ON t.run_id=j.run_id
       WHERE j.run_id=? AND a.repository_id=? AND a.created_by=? AND s.request_id=?
         AND j.lease_hash=? AND j.status='running' AND j.cancel_requested=0
         AND j.lease_expires_at>? AND j.started_at+j.timeout_minutes*60000>?
         AND t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`
    )
      .bind(
        runId,
        authJob.repositoryId,
        authJob.ownerId,
        requestId,
        leaseHash,
        now,
        now,
        tokenHash,
        now
      )
      .first<{ runner_id: string }>();
    if (active) return active.runner_id;
  }

  const replayConclusion =
    operation === "complete" ? "success" : operation === "fail" ? "failure" : null;
  if (request.method !== "POST" || !replayConclusion) return null;
  const replay = await env.DB.prepare(
    `SELECT j.runner_id FROM actions_runner_runs j
     JOIN actions_runs a ON a.id=j.run_id JOIN actions_signing_runs s ON s.run_id=j.run_id
     JOIN actions_job_tokens t ON t.run_id=j.run_id
     WHERE j.run_id=? AND s.request_id=? AND j.lease_hash=? AND j.status='completed'
       AND j.conclusion=? AND j.cancel_requested=0 AND j.lease_expires_at>?
       AND j.started_at+j.timeout_minutes*60000>? AND t.token_hash=?
       AND t.revoked_at IS NULL AND t.expires_at>?`
  )
    .bind(runId, requestId, leaseHash, replayConclusion, now, now, tokenHash, now)
    .first<{ runner_id: string }>();
  return replay?.runner_id ?? null;
}

export async function runnerManagement(
  request: Request,
  env: RunnerEnv,
  user: TrustedUser | null
): Promise<Response> {
  if (
    !user ||
    user.job ||
    user.agentSession ||
    (user.token && !accessTokenAllows(user.token, "admin"))
  )
    return errorResponse(
      403,
      "forbidden",
      "A human repository administrator is required to manage runners."
    );
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length === 1 && request.method === "GET") {
    const rows = await env.DB.prepare(
      `${runnersSelect} WHERE r.created_by = ? ORDER BY r.created_at DESC LIMIT 101`
    )
      .bind(user.id)
      .all<RunnerRow>();
    const result = rows.results.filter((row) => registrationScopeAllowed(user, row.repository_id));
    return Response.json({
      data: result.slice(0, 100).map(presentedRunner),
      truncated: rows.results.length > 100,
    });
  }
  if (parts.length === 1 && request.method === "POST") {
    const parsed = RegisterRunnerInputSchema.safeParse(await readJsonLimited(request, 16_384));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid runner registration.");
    const namespace = await env.DB.prepare("SELECT id FROM namespaces WHERE slug = ?")
      .bind(parsed.data.scope.owner)
      .first<{ id: string }>();
    if (!namespace) return errorResponse(404, "not_found", "Runner scope was not found.");
    let repositoryId: string | null = null;
    if (parsed.data.scope.repository) {
      const repo = await env.DB.prepare(
        "SELECT id FROM repositories WHERE namespace_id = ? AND slug = ? AND deleted_at IS NULL"
      )
        .bind(namespace.id, parsed.data.scope.repository)
        .first<{ id: string }>();
      if (!repo) return errorResponse(404, "not_found", "Runner scope was not found.");
      repositoryId = repo.id;
    }
    if (
      !registrationScopeAllowed(user, repositoryId) ||
      !(await ownsScope(env, user.id, namespace.id, repositoryId))
    )
      return errorResponse(404, "not_found", "Runner scope was not found.");
    const id = crypto.randomUUID(),
      now = Date.now(),
      token = `${RUNNER_TOKEN_PREFIX}${randomHex(32)}`;
    const stored = await env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM actions_runners WHERE created_by = ? AND revoked_at IS NULL) < 50`
    )
      .bind(
        id,
        parsed.data.name,
        namespace.id,
        repositoryId,
        user.id,
        JSON.stringify(parsed.data.labels),
        await sha256Hex(token),
        now,
        user.id
      )
      .run();
    if (stored.meta.changes !== 1)
      return errorResponse(
        409,
        "conflict",
        "This account already has 50 active runner registrations."
      );
    await recordAudit(env, {
      action: "actions.runner_created",
      actor: auditActor(user),
      target: { type: "runner", id, label: parsed.data.name },
      repositoryId,
      namespaceId: namespace.id,
    });
    return dataResponse(
      {
        runner: {
          id,
          name: parsed.data.name,
          scope: parsed.data.scope,
          labels: parsed.data.labels,
          createdAt: now,
          lastSeenAt: null,
          revokedAt: null,
        },
        token,
      },
      201
    );
  }
  if (parts.length === 2 && request.method === "DELETE") {
    const row = await env.DB.prepare(`${runnersSelect} WHERE r.id = ?`)
      .bind(parts[1])
      .first<RunnerRow>();
    if (
      !row ||
      !registrationScopeAllowed(user, row.repository_id) ||
      (user.id !== row.created_by &&
        !(await ownsScope(env, user.id, row.namespace_id, row.repository_id)))
    )
      return errorResponse(404, "not_found", "Runner registration was not found.");
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE actions_runners SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?"
      ).bind(now, row.id),
      env.DB.prepare(
        "UPDATE actions_runner_runs SET status='completed', conclusion='cancelled', cancel_requested=1, completed_at=? WHERE runner_id=? AND status='running'"
      ).bind(now, row.id),
      env.DB.prepare(
        "UPDATE actions_job_tokens SET revoked_at=? WHERE run_id IN (SELECT run_id FROM actions_runner_runs WHERE runner_id=?)"
      ).bind(now, row.id),
      env.DB.prepare(
        "UPDATE actions_github_runner_jobs SET status='completed',conclusion='cancelled',completed_at=? WHERE runner_id=? AND status='running'"
      ).bind(now, row.id),
    ]);
    await disconnectRunner(env, row.namespace_id, row.id);
    await recordAudit(env, {
      action: "actions.runner_revoked",
      actor: auditActor(user),
      target: { type: "runner", id: row.id, label: row.name },
      repositoryId: row.repository_id,
      namespaceId: row.namespace_id,
    });
    return dataResponse({ revoked: true });
  }
  if (parts.length === 3 && parts[2] === "labels" && request.method === "PUT") {
    const row = await env.DB.prepare(`${runnersSelect} WHERE r.id = ?`)
      .bind(parts[1])
      .first<RunnerRow>();
    if (
      !row ||
      row.revoked_at !== null ||
      !registrationScopeAllowed(user, row.repository_id) ||
      (user.id !== row.created_by &&
        !(await ownsScope(env, user.id, row.namespace_id, row.repository_id)))
    )
      return errorResponse(404, "not_found", "Runner registration was not found.");
    const body = z
      .object({ labels: RunnerCustomLabelsSchema })
      .strict()
      .safeParse(await readJsonLimited(request, 16_384));
    if (!body.success) return errorResponse(400, "bad_request", "Invalid runner custom labels.");
    const systemLabels = labels(row.labels_json).filter(isRunnerSystemLabel);
    const nextLabels = [...systemLabels, ...body.data.labels];
    if (!RunnerLabelsSchema.safeParse(nextLabels).success)
      return errorResponse(400, "bad_request", "Runner label limit exceeded.");
    const updated = await env.DB.prepare(
      "UPDATE actions_runners SET labels_json=? WHERE id=? AND revoked_at IS NULL"
    )
      .bind(JSON.stringify(nextLabels), row.id)
      .run();
    if (updated.meta.changes !== 1)
      return errorResponse(404, "not_found", "Runner registration was not found.");
    await recordAudit(env, {
      action: "actions.runner_labels_updated",
      actor: auditActor(user),
      target: { type: "runner", id: row.id, label: row.name },
      repositoryId: row.repository_id,
      namespaceId: row.namespace_id,
    });
    return dataResponse({ labels: nextLabels });
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed for runner management.");
}

function runDetails(row: RunRow): ActionRun {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    commitOid: row.commit_oid,
    workflowName: row.workflow,
    workflowPath: row.path,
    ref: row.source_ref,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    status: row.status,
    conclusion: row.conclusion,
    eventType: row.trigger_kind,
    executor: "runner",
    outputTruncated: row.log_truncated === 1,
    cacheOutcome: "disabled",
    artifacts: [],
    artifactOutcomes: [],
    jobs: [
      {
        id: "runner",
        name: "Workflow execution",
        status: row.status,
        conclusion: row.conclusion,
        steps: [
          {
            name: "Runner output",
            status: row.status,
            conclusion: row.conclusion,
            exitCode: null,
            log: row.log,
            outputTruncated: row.log_truncated === 1,
          },
        ],
      },
    ],
  };
}
export async function getRunnerRun(env: RunnerEnv, id: string): Promise<ActionRun | null> {
  const row = await env.DB.prepare(`${runsSelect} WHERE a.id = ?`).bind(id).first<RunRow>();
  return row ? runDetails(row) : null;
}
export async function cancelRunnerRun(env: RunnerEnv, id: string): Promise<ActionRun | null> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE actions_runner_runs SET cancel_requested=1, status='completed', conclusion='cancelled', completed_at=? WHERE run_id=? AND status!='completed'"
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE actions_job_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE run_id=?"
    ).bind(now, id),
  ]);
  const run = await getRunnerRun(env, id);
  if (run) await publishCheck(env, run);
  return run;
}

async function cancelUnauthorizedLease(
  env: RunnerEnv,
  runId: string,
  runnerId: string,
  hash: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT a.created_by,a.repository_id,u.disabled_at,p.deleted_at,p.archived,p.actions_enabled,p.actions_runner_enabled
    FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id JOIN users u ON u.id=a.created_by
    JOIN repositories p ON p.id=a.repository_id
    WHERE j.run_id=? AND j.runner_id=? AND j.lease_hash=? AND j.status='running'`
  )
    .bind(runId, runnerId, hash)
    .first<{
      created_by: string;
      repository_id: string;
      disabled_at: number | null;
      deleted_at: number | null;
      archived: number;
      actions_enabled: number;
      actions_runner_enabled: number;
    }>();
  if (!row) return false;
  if (
    row.disabled_at === null &&
    row.deleted_at === null &&
    row.archived === 0 &&
    row.actions_enabled === 1 &&
    row.actions_runner_enabled === 1 &&
    writableRole(await repositoryRole(env.DB, row.repository_id, row.created_by))
  )
    return false;
  await cancelRunnerRun(env, runId);
  return true;
}

export async function expireRunnerRuns(env: RunnerEnv): Promise<void> {
  const now = Date.now();
  const stale = await env.DB.prepare(
    `SELECT j.run_id,j.runner_id,j.status AS prior_status,
      (j.status='running' AND (j.lease_expires_at<=? OR j.started_at+j.timeout_minutes*60000<=? OR r.id IS NULL OR r.revoked_at IS NOT NULL)) AS infrastructure_failure
    FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
    JOIN repositories p ON p.id=a.repository_id LEFT JOIN actions_runners r ON r.id=j.runner_id
    WHERE j.status!='completed' AND ((j.status='running' AND (j.lease_expires_at<=? OR j.started_at+j.timeout_minutes*60000<=? OR r.id IS NULL OR r.revoked_at IS NOT NULL))
      OR (j.status='queued' AND a.created_at<?) OR p.deleted_at IS NOT NULL OR p.archived=1 OR p.actions_enabled=0 OR p.actions_runner_enabled=0)
    ORDER BY a.created_at LIMIT 20`
  )
    .bind(now, now, now, now, now - 86_400_000)
    .all<{
      run_id: string;
      runner_id: string | null;
      prior_status: "queued" | "running" | "completed";
      infrastructure_failure: number;
    }>();
  for (const row of stale.results) {
    const expired = await env.DB.prepare(
      `UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,log='Runner lease expired, execution timed out, or repository execution was disabled. This run will not be retried automatically.'
      WHERE run_id=? AND run_id IN (SELECT j.run_id FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
        JOIN repositories p ON p.id=a.repository_id LEFT JOIN actions_runners r ON r.id=j.runner_id
        WHERE j.status!='completed' AND ((j.status='running' AND (j.lease_expires_at<=? OR j.started_at+j.timeout_minutes*60000<=? OR r.id IS NULL OR r.revoked_at IS NOT NULL))
          OR (j.status='queued' AND a.created_at<?) OR p.deleted_at IS NOT NULL OR p.archived=1 OR p.actions_enabled=0 OR p.actions_runner_enabled=0))
      RETURNING run_id`
    )
      .bind(now, row.run_id, now, now, now - 86_400_000)
      .first();
    if (!expired) continue;
    if (row.prior_status === "running" && row.infrastructure_failure === 1)
      await recordRunnerFailure(env, row.runner_id, now);
    await env.DB.prepare(
      "UPDATE actions_job_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE run_id=?"
    )
      .bind(now, row.run_id)
      .run();
    const run = await getRunnerRun(env, row.run_id);
    if (run) await publishCheck(env, run);
  }
}

export async function queueRunnerRun(
  env: RunnerEnv,
  repositoryId: string,
  user: TrustedUser,
  ref: string,
  oid: string,
  definition: RunnerWorkflow,
  event: "push" | "workflow_dispatch" | "schedule",
  inputs: Record<string, string | number | boolean> = {},
  schedule?: { at: number; cron: string }
): Promise<ActionRunSummary | null> {
  const id = crypto.randomUUID(),
    now = Date.now();
  const repo = await env.DB.prepare(
    "SELECT n.slug AS owner,p.namespace_id,p.slug,p.visibility,p.default_branch FROM repositories p JOIN namespaces n ON n.id=p.namespace_id WHERE p.id=? AND p.deleted_at IS NULL"
  )
    .bind(repositoryId)
    .first<{
      owner: string;
      namespace_id: string;
      slug: string;
      visibility: string;
      default_branch: string;
    }>();
  if (!repo) throw new Error("Repository disappeared before queueing.");
  const sourceRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  const payload = {
    ref: sourceRef,
    after: oid,
    inputs,
    ...(schedule ? { schedule: schedule.cron } : {}),
    repository: {
      name: repo.slug,
      full_name: `${repo.owner}/${repo.slug}`,
      owner: { login: repo.owner, name: repo.owner },
      private: repo.visibility === "private",
      default_branch: repo.default_branch,
    },
    sender: { login: user.identifier },
    pusher: { name: user.identifier },
    head_commit: { id: oid },
  };
  const insertRun = env.DB.prepare(
    `INSERT OR IGNORE INTO actions_runs (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor,scheduled_at)
    VALUES(?,?,?,?,?,?,?, ?,?,'runner',?)`
  ).bind(
    id,
    repositoryId,
    oid,
    definition.workflow.name,
    definition.workflow.path,
    ref.replace(/^refs\/heads\//, ""),
    user.id,
    now,
    event,
    schedule?.at ?? null
  );
  const insertJob = env.DB.prepare(
    "INSERT INTO actions_runner_runs (run_id,workflow_source,labels_json,permission,timeout_minutes,event_json) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM actions_runs WHERE id=?)"
  ).bind(
    id,
    definition.source,
    JSON.stringify(definition.labels),
    definition.permission,
    definition.timeoutMinutes,
    JSON.stringify(payload),
    id
  );
  const [created] = await env.DB.batch([insertRun, insertJob]);
  if (created.meta.changes !== 1) return null;
  const run = await getRunnerRun(env, id);
  if (!run) throw new Error("Runner run could not be initialized.");
  await publishCheck(env, run);
  await notifyRunnerDispatch(env, repo.namespace_id);
  return {
    id,
    commitOid: oid,
    workflowPath: run.workflowPath,
    workflowName: run.workflowName,
    ref: run.ref,
    createdBy: user.id,
    createdAt: now,
    status: "queued",
    conclusion: null,
    cacheOutcome: "disabled",
    artifactCount: 0,
    executor: "runner",
  };
}

export async function storeRunnerReport(
  env: RunnerEnv,
  runner: RunnerRow,
  capacity: RunnerCapacity,
  budget: RunnerBudget | null,
  now: number
): Promise<void> {
  await env.DB.prepare(
    `UPDATE actions_runners SET capacity_json=?,budget_json=COALESCE(?,budget_json),
      capacity_reported_at=?,last_seen_at=?,connected=1 WHERE id=? AND revoked_at IS NULL`
  )
    .bind(JSON.stringify(capacity), budget ? JSON.stringify(budget) : null, now, now, runner.id)
    .run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO actions_runner_samples (runner_id,minute,load1,mem_free_mb,busy)
     VALUES (?,?,?,?,?)`
  )
    .bind(runner.id, Math.floor(now / 60_000), capacity.load1, capacity.memFreeMb, capacity.busy)
    .run();
}

export interface ClaimedJob {
  run: Record<string, unknown>;
  runnerId?: string;
  runnerLabels: string[];
  leaseToken: string;
  leaseExpiresAt: number | null;
}

export type ClaimOutcome =
  { kind: "claimed"; claim: ClaimedJob } | { kind: "skipped" } | { kind: "failed"; reason: string };

async function issueJobToken(
  env: RunnerEnv,
  runId: string,
  runnerId: string,
  leaseToken: string
): Promise<string> {
  if (!env.AUTH) throw new Error("auth_unavailable");
  const response = await env.AUTH.fetch(
    new Request("https://auth.internal/internal/actions-job-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId, runnerId, leaseToken }),
    })
  );
  const body: unknown = JSON.parse((await readTextLimited(response.body, 8192)) ?? "null");
  const credential = z
    .object({ data: z.object({ token: z.string().regex(/^ge_job_[0-9a-f]{64}$/) }) })
    .safeParse(body);
  if (!response.ok || !credential.success) throw new Error("invalid_job_token");
  return credential.data.data.token;
}

async function failUnissuedJob(
  env: RunnerEnv,
  runId: string,
  runnerId: string,
  leaseHash: string
): Promise<void> {
  const failedAt = Date.now();
  const failed = await env.DB.prepare(
    "UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,log='The job credential could not be issued.' WHERE run_id=? AND lease_hash=? AND status='running' RETURNING run_id"
  )
    .bind(failedAt, runId, leaseHash)
    .first();
  if (failed) await recordRunnerFailure(env, runnerId, failedAt);
  await env.DB.prepare("UPDATE actions_job_tokens SET revoked_at=? WHERE run_id=?")
    .bind(failedAt, runId)
    .run();
  const completed = await getRunnerRun(env, runId);
  if (completed) await publishCheck(env, completed);
}

const eventRef = (ref: string): string => (ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);

export async function claimSpecificCandidate(
  env: RunnerEnv,
  runner: RunnerRow,
  candidate: RunnerCandidate,
  evaluated: EvaluatedRunnerCandidate,
  now: number
): Promise<ClaimOutcome> {
  const leaseToken = randomHex(32);
  const leaseHash = await sha256Hex(leaseToken);
  const claimed = await claimRunnerCandidate(
    env,
    runner,
    candidate,
    evaluated.claim.minutes,
    leaseHash,
    now,
    runner.capacity_reported_at
  );
  if (!claimed) return { kind: "skipped" };
  const runnerLabels = RunnerClaimLabelSnapshotSchema.parse({
    runnerLabels: labels(runner.labels_json),
  }).runnerLabels;
  await clearRunnerDeferral(env, candidate.kind, candidate.id);
  if (candidate.kind === "github") {
    try {
      const github = await claimGithubRunner(
        env,
        runner,
        candidate.id,
        evaluated.claim,
        leaseHash,
        now
      );
      return github
        ? { kind: "claimed", claim: { ...github, runnerLabels, leaseToken } }
        : { kind: "skipped" };
    } catch {
      return { kind: "failed", reason: "github-runner-start-failed" };
    }
  }
  const row = await env.DB.prepare(`${runsSelect} WHERE a.id=?`).bind(candidate.id).first<RunRow>();
  if (!row) return { kind: "skipped" };
  try {
    const token = await issueJobToken(env, row.id, runner.id, leaseToken);
    await publishCheck(env, runDetails(row));
    const repository = `${row.owner}/${row.repository}`;
    const ref = eventRef(row.source_ref);
    const eventPayload: unknown = JSON.parse(row.event_json);
    if (candidate.execution_kind === "signing")
      return {
        kind: "claimed",
        claim: {
          run: {
            id: row.id,
            kind: "signing",
            token,
            labels: evaluated.labels,
            requestId: candidate.request_id,
            stage: candidate.stage,
            inputDigest: candidate.input_digest,
            ownerId: row.created_by,
            repositoryId: row.repository_id,
            repository,
            workflowPath: row.path,
            workflowSource: row.workflow_source,
            workflowOid: candidate.workflow_oid,
            profileRevision: candidate.profile_revision,
            generation: candidate.generation,
            nonce: candidate.nonce,
            platform: candidate.platform,
            sha: row.commit_oid,
            ref,
            event: row.trigger_kind,
            eventPayload,
            permission: row.permission,
            timeoutMinutes: row.timeout_minutes,
          },
          runnerId: runner.id,
          runnerLabels,
          leaseToken,
          leaseExpiresAt: row.lease_expires_at,
        },
      };
    return {
      kind: "claimed",
      claim: {
        run: {
          id: row.id,
          kind: "workflow",
          repositoryId: row.repository_id,
          repository,
          workflowPath: row.path,
          workflowSource: row.workflow_source,
          sha: row.commit_oid,
          ref,
          event: row.trigger_kind,
          eventPayload,
          token,
          permission: row.permission,
          timeoutMinutes: row.timeout_minutes,
        },
        runnerLabels,
        leaseToken,
        leaseExpiresAt: row.lease_expires_at,
      },
    };
  } catch {
    await failUnissuedJob(env, row.id, runner.id, leaseHash);
    createLogger(env.LOG_LEVEL, { service: "runner-dispatch" }).error(
      "runner-dispatch:job-credential-failed",
      { runId: row.id }
    );
    return { kind: "failed", reason: "job-credential-failed" };
  }
}

async function isSigningRun(env: RunnerEnv, runId: string): Promise<boolean> {
  return (
    (await env.DB.prepare("SELECT 1 AS found FROM actions_signing_runs WHERE run_id=?")
      .bind(runId)
      .first()) !== null
  );
}

async function disconnectRunner(
  env: RunnerEnv,
  namespaceId: string,
  runnerId: string
): Promise<void> {
  if (!env.RUNNER_DISPATCH) return;
  try {
    await env.RUNNER_DISPATCH.get(env.RUNNER_DISPATCH.idFromName(namespaceId)).disconnect(runnerId);
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "runner-dispatch" }).warn(
      "runner-dispatch:disconnect-failed",
      { runnerId, reason: cause instanceof Error ? cause.message : "unknown" }
    );
  }
}

async function connectRunner(request: Request, env: RunnerEnv): Promise<Response> {
  if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return errorResponse(
      426,
      "upgrade_required",
      "Runner connections require a WebSocket upgrade."
    );
  const runner = await authenticateRunner(request, env);
  if (!runner) return errorResponse(401, "unauthorized", "Invalid or revoked runner registration.");
  if (!env.RUNNER_DISPATCH)
    return errorResponse(503, "internal_error", "Runner dispatch is unavailable.");
  const headers = new Headers(request.headers);
  headers.delete("Authorization");
  headers.set("X-Runner-Id", runner.id);
  return env.RUNNER_DISPATCH.get(env.RUNNER_DISPATCH.idFromName(runner.namespace_id)).fetch(
    new Request(request, { headers })
  );
}

export async function runnerMachineRequest(request: Request, env: RunnerEnv): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/runner/connect") return connectRunner(request, env);
  const signingMachineRoute = pathname.startsWith("/runner/signing/requests/");
  if (signingMachineRoute && !["POST", "GET", "PUT"].includes(request.method))
    return errorResponse(
      405,
      "method_not_allowed",
      "Signing runner operation method is not supported."
    );
  if (!signingMachineRoute && request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Runner operations require POST.");
  const runner = await authenticateRunner(request, env);
  const signingJobRunnerId =
    !runner && signingMachineRoute ? await authenticateSigningJob(request, env) : null;
  const runnerId = runner?.id ?? signingJobRunnerId;
  if (!runnerId)
    return errorResponse(401, "unauthorized", "Invalid or revoked runner registration.");
  const now = Date.now();
  if (runner)
    await env.DB.prepare(
      "UPDATE actions_runners SET last_seen_at=? WHERE id=? AND (last_seen_at IS NULL OR last_seen_at<?)"
    )
      .bind(now, runnerId, now - 30_000)
      .run();
  if (signingMachineRoute) {
    const response = await handleSigningMachineCallback(request, env, runnerId);
    const signingOperation =
      request.method === "POST" &&
      /\/runner\/signing\/requests\/[0-9a-f-]{36}\/complete$/i.test(pathname);
    const signingFailure =
      request.method === "POST" &&
      /\/runner\/signing\/requests\/[0-9a-f-]{36}\/fail$/i.test(pathname);
    const conclusion =
      signingOperation && response.status === 202
        ? "success"
        : signingFailure && response.status === 200
          ? "failure"
          : null;
    if (conclusion) {
      const runId = request.headers.get("X-Runner-Run-Id") ?? "";
      const leaseToken = request.headers.get("X-Runner-Lease-Token") ?? "";
      const hash = await sha256Hex(leaseToken);
      const now = Date.now();
      const updated = await env.DB.prepare(
        `UPDATE actions_runner_runs SET status='completed',conclusion=?,completed_at=?,
          log=?,log_truncated=0
         WHERE run_id=? AND runner_id=? AND lease_hash=? AND status='running' AND cancel_requested=0
           AND lease_expires_at>? AND started_at+timeout_minutes*60000>? RETURNING run_id`
      )
        .bind(
          conclusion,
          now,
          conclusion === "success"
            ? "Signing stage output verified by coordinator."
            : "Signing stage reported an execution failure.",
          runId,
          runnerId,
          hash,
          now,
          now
        )
        .first();
      if (!updated) {
        const prior = await env.DB.prepare(
          `SELECT 1 FROM actions_runner_runs WHERE run_id=? AND runner_id=? AND lease_hash=?
           AND status='completed' AND conclusion=?`
        )
          .bind(runId, runnerId, hash, conclusion)
          .first();
        if (!prior)
          return errorResponse(409, "conflict", "The signing runner lease is no longer active.");
      } else if (conclusion === "success") {
        await clearRunnerFailures(env, runnerId);
      }
      const run = await getRunnerRun(env, runId);
      if (run) await publishCheck(env, run);
    }
    return response;
  }
  if (!runner) return errorResponse(401, "unauthorized", "Invalid or revoked runner registration.");
  const operation = new URL(request.url).pathname.split("/")[2];
  if (operation === "github") return githubRunnerLease(request, env, runner);
  const body = await readJsonLimited(
    request,
    operation === "complete" ? RUNNER_LOG_BYTES * 6 + 4096 : 8192
  );
  if (operation === "heartbeat") {
    const parsed = RunnerLeaseInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid lease heartbeat.");
    if (await isSigningRun(env, parsed.data.runId))
      return errorResponse(409, "conflict", "Signing leases require the signing operation route.");
    const hash = await sha256Hex(parsed.data.leaseToken);
    if (await cancelUnauthorizedLease(env, parsed.data.runId, runner.id, hash))
      return dataResponse({ cancelRequested: true, leaseExpiresAt: now });
    const refreshed = await env.DB.prepare(
      `UPDATE actions_runner_runs SET lease_expires_at=MIN(started_at+timeout_minutes*60000,?)
      WHERE run_id=? AND runner_id=? AND lease_hash=? AND status='running' AND cancel_requested=0 AND lease_expires_at>?
      AND started_at+timeout_minutes*60000>? AND EXISTS (SELECT 1 FROM repositories p JOIN actions_runs a ON a.repository_id=p.id WHERE a.id=run_id AND p.archived=0 AND p.deleted_at IS NULL AND p.actions_enabled=1 AND p.actions_runner_enabled=1)
      RETURNING lease_expires_at`
    )
      .bind(now + RUNNER_LEASE_MS, parsed.data.runId, runner.id, hash, now, now)
      .first<{ lease_expires_at: number }>();
    if (!refreshed) return dataResponse({ cancelRequested: true, leaseExpiresAt: now });
    return dataResponse({ cancelRequested: false, leaseExpiresAt: refreshed.lease_expires_at });
  }
  if (operation === "complete") {
    const parsed = RunnerCompleteInputSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid runner result.");
    if (await isSigningRun(env, parsed.data.runId))
      return errorResponse(409, "conflict", "Signing leases require the signing operation route.");
    const log = parsed.data.log.replace(
      /(?:ge_job_|ge_runner_|gep_|ge_token_|ge_session_(?:git_)?)[0-9a-f]{16,}/g,
      "[redacted]"
    );
    const bytes = new TextEncoder().encode(log),
      bounded = new TextDecoder().decode(bytes.slice(0, RUNNER_LOG_BYTES));
    const hash = await sha256Hex(parsed.data.leaseToken);
    if (await cancelUnauthorizedLease(env, parsed.data.runId, runner.id, hash))
      return errorResponse(409, "conflict", "The job is no longer authorized.");
    const changed = await env.DB.prepare(
      `UPDATE actions_runner_runs SET status='completed',conclusion=?,completed_at=?,log=?,log_truncated=?
      WHERE run_id=? AND runner_id=? AND lease_hash=? AND status='running' AND cancel_requested=0 AND lease_expires_at>?
      AND started_at+timeout_minutes*60000>?
      RETURNING run_id`
    )
      .bind(
        parsed.data.conclusion,
        now,
        bounded,
        bytes.length > RUNNER_LOG_BYTES ? 1 : 0,
        parsed.data.runId,
        runner.id,
        hash,
        now,
        now
      )
      .first();
    if (!changed) {
      const prior = await env.DB.prepare(
        "SELECT 1 FROM actions_runner_runs WHERE run_id=? AND runner_id=? AND lease_hash=? AND status='completed' AND conclusion=?"
      )
        .bind(parsed.data.runId, runner.id, hash, parsed.data.conclusion)
        .first();
      if (!prior)
        return errorResponse(409, "conflict", "The runner no longer owns this job lease.");
    } else {
      await clearRunnerFailures(env, runner.id);
    }
    await env.DB.prepare(
      "UPDATE actions_job_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE run_id=?"
    )
      .bind(now, parsed.data.runId)
      .run();
    const run = await getRunnerRun(env, parsed.data.runId);
    if (run) await publishCheck(env, run);
    return dataResponse({ completed: true });
  }
  return errorResponse(404, "not_found", "Runner operation was not found.");
}
