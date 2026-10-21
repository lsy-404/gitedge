import { z } from "zod";
import {
  accessTokenAllows,
  accessTokenAllowsRepository,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import {
  RunnerBudgetSchema,
  RunnerCapacitySchema,
  RUNNER_CAPACITY_STALE_MS,
  RUNNER_DEFERRAL_AGE_MS,
  type JobClaim,
  type RegisteredRunner,
  type RunnerHistory,
  type RunnerHistoryItem,
  type RunnerOverview,
  type RunnerOverviewQueueItem,
  type RunnerOverviewRunner,
} from "../../../packages/contracts/src/runners";
import {
  eligibilityReasons,
  hasNeedLabels,
  matchesLabels,
  parseJobClaim,
} from "../../../packages/contracts/runner-scheduling.mjs";
import { errorResponse } from "../../../src/worker/common/http";

interface RunnerOverviewEnv {
  DB: D1Database;
}

interface RunnerDbRow {
  id: string;
  name: string;
  namespace_id: string;
  repository_id: string | null;
  created_by: string;
  labels_json: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  capacity_json: string | null;
  capacity_reported_at: number | null;
  budget_json: string | null;
  held_until: number | null;
  consecutive_failures: number;
  owner: string;
  repository: string | null;
}

interface RunningDbRow {
  runner_id: string;
  kind: "gitedge" | "github";
  id: string;
  repository: string;
  started_at: number;
}

interface StatsDbRow {
  runner_id: string;
  success: number;
  failure: number;
  cancelled: number;
  busy_ms: number;
}

interface SampleDbRow {
  runner_id: string;
  minute: number;
  load1: number | null;
  mem_free_mb: number | null;
  busy: number;
}

interface QueueDbRow {
  kind: "gitedge" | "github";
  id: string;
  repository: string;
  namespace_id: string;
  repository_id: string;
  labels_json: string;
  created_at: number;
  minutes: number;
}

interface DeferralDbRow {
  job_kind: "gitedge" | "github";
  job_id: string;
  runner_id: string;
  reasons_json: string;
  updated_at: number;
}

const MAX_RUNNERS = 100;
const MAX_CONNECTIONS = 50;
const MAX_QUEUE = 50;
const MAX_SAMPLES = 96;
const MAX_HISTORY = 50;
const OFFLINE_MS = 60_000;
const HistoryCursorSchema = z
  .object({
    startedAt: z.number().int().nonnegative(),
    kind: z.enum(["gitedge", "github"]),
    id: z.string().min(1),
  })
  .strict();

function humanAdmin(user: TrustedUser | null): user is TrustedUser {
  return (
    !!user &&
    !user.job &&
    !user.agentSession &&
    (!user.token || accessTokenAllows(user.token, "admin"))
  );
}

function parseJson<T>(json: string | null, parse: (value: unknown) => T): T | null {
  if (json === null) return null;
  try {
    return parse(JSON.parse(json));
  } catch {
    return null;
  }
}

function parseRunner(row: RunnerDbRow): RegisteredRunner {
  return {
    id: row.id,
    name: row.name,
    scope: { owner: row.owner, ...(row.repository === null ? {} : { repository: row.repository }) },
    labels: safeLabels(row.labels_json),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

const runnerSelect = `SELECT r.id,r.name,r.namespace_id,r.repository_id,r.created_by,r.labels_json,r.created_at,
  r.last_seen_at,r.revoked_at,r.capacity_json,r.capacity_reported_at,r.budget_json,r.held_until,
  r.consecutive_failures,n.slug AS owner,p.slug AS repository
  FROM actions_runners r JOIN namespaces n ON n.id=r.namespace_id
  LEFT JOIN repositories p ON p.id=r.repository_id`;

async function visibleRunners(
  env: RunnerOverviewEnv,
  user: TrustedUser
): Promise<{ rows: RunnerDbRow[]; truncated: boolean }> {
  const repositoryFilter = user.token?.repositoryIds
    ? "AND r.repository_id IN (SELECT value FROM json_each(?))"
    : "";
  const repositoryArgs = user.token?.repositoryIds
    ? [JSON.stringify(user.token.repositoryIds)]
    : [];
  const rows = await env.DB.prepare(
    `${runnerSelect}
    LEFT JOIN namespace_memberships m ON m.namespace_id=r.namespace_id AND m.user_id=?
    LEFT JOIN repository_collaborators c ON c.repository_id=r.repository_id AND c.user_id=?
    WHERE (r.created_by=? OR m.role='owner' OR c.role='admin') AND (p.id IS NULL OR p.deleted_at IS NULL)
    ${repositoryFilter}
    ORDER BY r.created_at DESC,r.id LIMIT ?`
  )
    .bind(user.id, user.id, user.id, ...repositoryArgs, MAX_RUNNERS + 1)
    .all<RunnerDbRow>();
  const permitted = rows.results.filter((row) => {
    if (user.token && row.repository_id === null && user.token.repositoryIds) return false;
    return (
      !user.token ||
      row.repository_id === null ||
      accessTokenAllowsRepository(user.token, row.repository_id)
    );
  });
  return {
    rows: permitted.slice(0, MAX_RUNNERS),
    truncated: rows.results.length > MAX_RUNNERS || permitted.length > MAX_RUNNERS,
  };
}

function displayState(row: RunnerDbRow, busy: boolean, now: number): RunnerOverviewRunner["state"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.held_until !== null && row.held_until > now) return "held";
  if (row.last_seen_at === null || row.last_seen_at < now - OFFLINE_MS) return "offline";
  return busy ? "busy" : "idle";
}

function safeLabels(json: string): string[] {
  try {
    const values: unknown = JSON.parse(json);
    return Array.isArray(values) && values.every((value) => typeof value === "string")
      ? values
      : [];
  } catch {
    return [];
  }
}

async function authorizedRunner(
  env: RunnerOverviewEnv,
  user: TrustedUser,
  runnerId: string
): Promise<RunnerDbRow | null> {
  const row = await env.DB.prepare(
    `${runnerSelect}
    LEFT JOIN namespace_memberships m ON m.namespace_id=r.namespace_id AND m.user_id=?
    LEFT JOIN repository_collaborators c ON c.repository_id=r.repository_id AND c.user_id=?
    WHERE r.id=? AND (r.created_by=? OR m.role='owner' OR c.role='admin') AND (p.id IS NULL OR p.deleted_at IS NULL)`
  )
    .bind(user.id, user.id, runnerId, user.id)
    .first<RunnerDbRow>();
  if (!row || (user.token && row.repository_id === null && user.token.repositoryIds)) return null;
  if (
    user.token &&
    row.repository_id !== null &&
    !accessTokenAllowsRepository(user.token, row.repository_id)
  )
    return null;
  return row;
}

function runnerUsageReasons(
  row: RunnerDbRow,
  labels: string[],
  claim: JobClaim,
  usedMinutes: number,
  now: number,
  busy: boolean
): string[] {
  const reasons: string[] = [];
  const runnerLabels = safeLabels(row.labels_json);
  if (!matchesLabels(claim.labels, runnerLabels)) {
    for (const label of claim.labels)
      if (!runnerLabels.some((available) => available.toLowerCase() === label.toLowerCase()))
        reasons.push(`label:${label}`);
  }
  if (busy) reasons.push("busy");
  if (row.held_until !== null && row.held_until > now) reasons.push("held");
  if (row.last_seen_at === null || row.last_seen_at < now - OFFLINE_MS) reasons.push("offline");
  const capacity =
    row.capacity_reported_at !== null && row.capacity_reported_at >= now - RUNNER_CAPACITY_STALE_MS
      ? parseJson(row.capacity_json, (value) => RunnerCapacitySchema.parse(value))
      : null;
  const budget = parseJson(row.budget_json, (value) => RunnerBudgetSchema.parse(value));
  reasons.push(
    ...eligibilityReasons(capacity, budget, usedMinutes, claim, {
      allowUnknownLegacy: !hasNeedLabels(labels),
      explicitNeeds: hasNeedLabels(labels),
    })
  );
  return [...new Set(reasons)];
}

async function queueRows(
  env: RunnerOverviewEnv,
  user: TrustedUser
): Promise<{ rows: QueueDbRow[]; truncated: boolean }> {
  const repositoryFilter = user.token?.repositoryIds
    ? "AND p.id IN (SELECT value FROM json_each(?))"
    : "";
  const visibilityArgs = user.token?.repositoryIds
    ? [JSON.stringify(user.token.repositoryIds)]
    : [];
  const [gitedge, github] = await Promise.all([
    env.DB.prepare(
      `SELECT 'gitedge' AS kind,a.id,n.slug||'/'||p.slug AS repository,p.namespace_id,p.id AS repository_id,
      j.labels_json,a.created_at,j.timeout_minutes AS minutes FROM actions_runner_runs j
      JOIN actions_runs a ON a.id=j.run_id JOIN repositories p ON p.id=a.repository_id JOIN namespaces n ON n.id=p.namespace_id
      WHERE j.status='queued' AND p.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
        EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id=p.id AND c.user_id=? AND c.role='admin'))
      ${repositoryFilter}
        ORDER BY a.created_at,a.id LIMIT 51`
    )
      .bind(user.id, user.id, ...visibilityArgs)
      .all<QueueDbRow>(),
    env.DB.prepare(
      `SELECT 'github' AS kind,j.id,n.slug||'/'||p.slug AS repository,p.namespace_id,p.id AS repository_id,
      j.labels_json,j.created_at,360 AS minutes FROM actions_github_runner_jobs j
      JOIN forge_github_connections c ON c.id=j.connection_id JOIN repositories p ON p.id=c.repository_id
      JOIN namespaces n ON n.id=p.namespace_id WHERE j.status='queued' AND p.deleted_at IS NULL AND (
        EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
        EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id=p.id AND c.user_id=? AND c.role='admin'))
      ${repositoryFilter}
        ORDER BY j.created_at,j.id LIMIT 51`
    )
      .bind(user.id, user.id, ...visibilityArgs)
      .all<QueueDbRow>(),
  ]);
  const rows = [...gitedge.results, ...github.results].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)
  );
  return { rows: rows.slice(0, MAX_QUEUE), truncated: rows.length > MAX_QUEUE };
}

export async function handleRunnerOverview(
  user: TrustedUser | null,
  env: RunnerOverviewEnv,
  _request: Request
): Promise<Response> {
  if (!humanAdmin(user))
    return errorResponse(403, "forbidden", "A human administrator is required to view runners.");
  const now = Date.now();
  const visible = await visibleRunners(env, user);
  const runnerRows = visible.rows;
  const ids = runnerRows.map((row) => row.id);
  const names = new Map(runnerRows.map((row) => [row.id, parseRunner(row)]));
  const stats = new Map<string, StatsDbRow>();
  const running = new Map<string, RunningDbRow>();
  const samples = new Map<string, RunnerOverviewRunner["samples"]>();
  let truncated = visible.truncated;

  if (ids.length) {
    const connectionRepositoryFilter = user.token?.repositoryIds
      ? "AND p.id IN (SELECT value FROM json_each(?))"
      : "";
    const connectionRepositoryArgs = user.token?.repositoryIds
      ? [JSON.stringify(user.token.repositoryIds)]
      : [];
    const cutoff = now - 86_400_000;
    const [statsResult, currentEdge, currentGithub, sampleResult, connections, queue] =
      await Promise.all([
        env.DB.prepare(
          `WITH selected_runner_ids AS (SELECT value AS id FROM json_each(?))
        SELECT runner_id,SUM(conclusion='success') AS success,SUM(conclusion='failure') AS failure,
        SUM(conclusion='cancelled') AS cancelled,SUM(CASE WHEN started_at IS NULL THEN 0 ELSE
          MAX(0,MIN(COALESCE(completed_at,?),?)-MAX(started_at,?)) END) AS busy_ms FROM (
          SELECT j.runner_id,j.conclusion,j.started_at,j.completed_at FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id JOIN repositories p ON p.id=a.repository_id
          WHERE j.runner_id IN (SELECT id FROM selected_runner_ids) AND COALESCE(j.completed_at,?)>=? AND j.started_at<=? AND (
            EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
            EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id=p.id AND c.user_id=? AND c.role='admin'))
          UNION ALL SELECT j.runner_id,j.conclusion,j.started_at,j.completed_at FROM actions_github_runner_jobs j
          JOIN forge_github_connections c ON c.id=j.connection_id JOIN repositories p ON p.id=c.repository_id
          WHERE j.runner_id IN (SELECT id FROM selected_runner_ids) AND COALESCE(j.completed_at,?)>=? AND j.started_at<=? AND (
            EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
            EXISTS (SELECT 1 FROM repository_collaborators c2 WHERE c2.repository_id=p.id AND c2.user_id=? AND c2.role='admin'))
        ) GROUP BY runner_id`
        )
          .bind(
            JSON.stringify(ids),
            now,
            now,
            cutoff,
            now,
            cutoff,
            now,
            user.id,
            user.id,
            now,
            cutoff,
            now,
            user.id,
            user.id
          )
          .all<StatsDbRow>(),
        env.DB.prepare(
          `SELECT j.runner_id,'gitedge' AS kind,a.id,n.slug||'/'||p.slug AS repository,j.started_at
        FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id JOIN repositories p ON p.id=a.repository_id JOIN namespaces n ON n.id=p.namespace_id
        WHERE j.status='running' AND j.runner_id IN (SELECT value FROM json_each(?)) AND (
          EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
          EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id=p.id AND c.user_id=? AND c.role='admin'))`
        )
          .bind(JSON.stringify(ids), user.id, user.id)
          .all<RunningDbRow>(),
        env.DB.prepare(
          `SELECT j.runner_id,'github' AS kind,j.id,n.slug||'/'||p.slug AS repository,j.started_at
        FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id
        JOIN repositories p ON p.id=c.repository_id JOIN namespaces n ON n.id=p.namespace_id
        WHERE j.status='running' AND j.runner_id IN (SELECT value FROM json_each(?)) AND (
          EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
          EXISTS (SELECT 1 FROM repository_collaborators c2 WHERE c2.repository_id=p.id AND c2.user_id=? AND c2.role='admin'))`
        )
          .bind(JSON.stringify(ids), user.id, user.id)
          .all<RunningDbRow>(),
        env.DB.prepare(
          `SELECT runner_id,(minute/15)*15 AS minute,AVG(load1) AS load1,MIN(mem_free_mb) AS mem_free_mb,MAX(busy) AS busy
        FROM actions_runner_samples WHERE runner_id IN (SELECT value FROM json_each(?)) AND minute>=?
        GROUP BY runner_id,(minute/15) ORDER BY minute DESC LIMIT ?`
        )
          .bind(
            JSON.stringify(ids),
            Math.floor(now / 900_000) * 15 - (MAX_SAMPLES - 1) * 15,
            ids.length * MAX_SAMPLES + 1
          )
          .all<SampleDbRow>(),
        env.DB.prepare(
          `SELECT c.id AS connection_id,p.id AS repository_id,n.slug||'/'||p.slug AS repository,c.owner||'/'||c.name AS remote,c.enabled,c.runner_enabled,
        c.error_code,c.failure_count,c.last_synced_at,COALESCE(q.queued,0) AS queued,q.oldest_queued_at,
        COALESCE(cl.pending_cleanup,0) AS pending_cleanup,j.last_job_at
        FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id JOIN namespaces n ON n.id=p.namespace_id
        LEFT JOIN namespace_memberships m ON m.namespace_id=p.namespace_id AND m.user_id=?
        LEFT JOIN repository_collaborators collab ON collab.repository_id=p.id AND collab.user_id=?
        LEFT JOIN (SELECT connection_id,COUNT(*) AS queued,MIN(created_at) AS oldest_queued_at FROM actions_github_runner_jobs WHERE status='queued' GROUP BY connection_id) q ON q.connection_id=c.id
        LEFT JOIN (SELECT connection_id,SUM(cleanup_pending) AS pending_cleanup,MAX(created_at) AS last_job_at FROM actions_github_runner_jobs GROUP BY connection_id) cl ON cl.connection_id=c.id
        LEFT JOIN (SELECT connection_id,MAX(created_at) AS last_job_at FROM actions_github_runner_jobs GROUP BY connection_id) j ON j.connection_id=c.id
        WHERE c.runner_enabled=1 AND (m.role='owner' OR collab.role='admin') ${connectionRepositoryFilter}
        ORDER BY c.created_at DESC,c.id LIMIT ?`
        )
          .bind(user.id, user.id, ...connectionRepositoryArgs, MAX_CONNECTIONS + 1)
          .all<{
            connection_id: string;
            repository_id: string;
            repository: string;
            remote: string;
            enabled: number;
            runner_enabled: number;
            error_code: string | null;
            failure_count: number;
            last_synced_at: number | null;
            queued: number;
            oldest_queued_at: number | null;
            pending_cleanup: number;
            last_job_at: number | null;
          }>(),
        queueRows(env, user),
      ]);
    const deferrals = queue.rows.length
      ? await env.DB.prepare(
          `SELECT d.job_kind,d.job_id,reason.key AS runner_id,reason.value AS reasons_json,d.updated_at
          FROM actions_runner_deferrals d,json_each(d.reasons_json) reason
          WHERE d.job_kind||':'||d.job_id IN (SELECT value FROM json_each(?))
            AND reason.key IN (SELECT value FROM json_each(?)) AND d.updated_at>=? AND d.updated_at<=?`
        )
          .bind(
            JSON.stringify(queue.rows.map((job) => `${job.kind}:${job.id}`)),
            JSON.stringify(ids),
            now - RUNNER_CAPACITY_STALE_MS,
            now
          )
          .all<DeferralDbRow>()
      : { results: [] as DeferralDbRow[] };
    const recentPeerDeferrals = new Set(
      deferrals.results
        .filter((row) => safeLabels(row.reasons_json).includes("peer-preferred"))
        .map((row) => `${row.job_kind}:${row.job_id}:${row.runner_id}`)
    );
    truncated ||=
      statsResult.results.length > ids.length ||
      sampleResult.results.length > ids.length * MAX_SAMPLES ||
      connections.results.length > MAX_CONNECTIONS ||
      queue.truncated;
    for (const row of statsResult.results) stats.set(row.runner_id, row);
    for (const row of [...currentEdge.results, ...currentGithub.results])
      running.set(row.runner_id, row);
    for (const row of sampleResult.results) {
      if (!samples.has(row.runner_id)) samples.set(row.runner_id, []);
      const points = samples.get(row.runner_id)!;
      if (points.length < MAX_SAMPLES)
        points.push({
          minute: row.minute,
          load1: row.load1,
          memFreeMb: row.mem_free_mb,
          busy: row.busy === 1,
        });
    }
    for (const points of samples.values()) points.reverse();
    const permittedConnections = connections.results.filter(
      (row) =>
        !user.token ||
        !user.token.repositoryIds ||
        user.token.repositoryIds.includes(row.repository_id)
    );
    const github = permittedConnections.slice(0, MAX_CONNECTIONS).map((row) => ({
      connectionId: row.connection_id,
      repository: row.repository,
      remote: row.remote,
      enabled: row.enabled === 1,
      runnerEnabled: row.runner_enabled === 1,
      errorCode: row.error_code,
      failureCount: row.failure_count,
      lastSyncedAt: row.last_synced_at,
      queued: row.queued,
      oldestQueuedAt: row.oldest_queued_at,
      pendingCleanup: row.pending_cleanup,
      lastJobAt: row.last_job_at,
    }));
    const queueItems: RunnerOverviewQueueItem[] = queue.rows.map((job) => {
      const labels = safeLabels(job.labels_json);
      const claim = parseJobClaim(labels, job.minutes);
      const blockedBy: Record<string, string[]> = {};
      for (const runner of runnerRows) {
        const runnerView = names.get(runner.id)!;
        const namespaceMatches = runner.owner === job.repository.split("/")[0];
        const repositoryMatches =
          runner.repository === null || runner.repository === job.repository.split("/")[1];
        let reasons =
          namespaceMatches && repositoryMatches
            ? runnerUsageReasons(
                runner,
                labels,
                claim,
                (stats.get(runner.id)?.busy_ms ?? 0) / 60_000,
                now,
                running.has(runner.id)
              )
            : ["scope"];
        if (
          reasons.length === 0 &&
          now - job.created_at < RUNNER_DEFERRAL_AGE_MS &&
          now >= job.created_at &&
          recentPeerDeferrals.has(`${job.kind}:${job.id}:${runnerView.id}`)
        ) {
          reasons = ["peer-preferred"];
        }
        if (reasons.length) blockedBy[runnerView.id] = reasons;
      }
      return {
        kind: job.kind,
        id: job.id,
        repository: job.repository,
        labels,
        claim,
        createdAt: job.created_at,
        blockedBy,
      };
    });
    truncated ||= permittedConnections.length > MAX_CONNECTIONS;
    const result: RunnerOverview = {
      generatedAt: now,
      runners: runnerRows.map((row) => {
        const current = running.get(row.id) ?? null;
        const stat = stats.get(row.id);
        const capacity = parseJson(row.capacity_json, (value) => RunnerCapacitySchema.parse(value));
        const budget = parseJson(row.budget_json, (value) => RunnerBudgetSchema.parse(value));
        return {
          ...names.get(row.id)!,
          state: displayState(row, current !== null, now),
          capacity,
          capacityReportedAt: row.capacity_reported_at,
          budget,
          usedMinutes24h: Math.round((stat?.busy_ms ?? 0) / 60_000),
          heldUntil: row.held_until,
          consecutiveFailures: row.consecutive_failures,
          current: current
            ? {
                kind: current.kind,
                id: current.id,
                repository: current.repository,
                startedAt: current.started_at,
              }
            : null,
          stats24h: {
            success: stat?.success ?? 0,
            failure: stat?.failure ?? 0,
            cancelled: stat?.cancelled ?? 0,
            busyMinutes: Math.round((stat?.busy_ms ?? 0) / 60_000),
          },
          samples: samples.get(row.id) ?? [],
        };
      }),
      github,
      queue: queueItems,
      truncated,
    };
    return Response.json({ data: result });
  }

  const connectionRepositoryFilter = user.token?.repositoryIds
    ? "AND p.id IN (SELECT value FROM json_each(?))"
    : "";
  const connectionRepositoryArgs = user.token?.repositoryIds
    ? [JSON.stringify(user.token.repositoryIds)]
    : [];
  const connections = await env.DB.prepare(
    `SELECT c.id AS connection_id,p.id AS repository_id,n.slug||'/'||p.slug AS repository,
    c.owner||'/'||c.name AS remote,c.enabled,c.runner_enabled,c.error_code,c.failure_count,c.last_synced_at,
    COALESCE(q.queued,0) AS queued,q.oldest_queued_at,COALESCE(cl.pending_cleanup,0) AS pending_cleanup,j.last_job_at
    FROM forge_github_connections c JOIN repositories p ON p.id=c.repository_id JOIN namespaces n ON n.id=p.namespace_id
    LEFT JOIN namespace_memberships m ON m.namespace_id=p.namespace_id AND m.user_id=?
    LEFT JOIN repository_collaborators collab ON collab.repository_id=p.id AND collab.user_id=?
    LEFT JOIN (SELECT connection_id,COUNT(*) AS queued,MIN(created_at) AS oldest_queued_at FROM actions_github_runner_jobs WHERE status='queued' GROUP BY connection_id) q ON q.connection_id=c.id
    LEFT JOIN (SELECT connection_id,SUM(cleanup_pending) AS pending_cleanup FROM actions_github_runner_jobs GROUP BY connection_id) cl ON cl.connection_id=c.id
    LEFT JOIN (SELECT connection_id,MAX(created_at) AS last_job_at FROM actions_github_runner_jobs GROUP BY connection_id) j ON j.connection_id=c.id
    WHERE c.runner_enabled=1 AND (m.role='owner' OR collab.role='admin') ${connectionRepositoryFilter}
    ORDER BY c.created_at DESC,c.id LIMIT ?`
  )
    .bind(user.id, user.id, ...connectionRepositoryArgs, MAX_CONNECTIONS + 1)
    .all<{
      connection_id: string;
      repository_id: string;
      repository: string;
      remote: string;
      enabled: number;
      runner_enabled: number;
      error_code: string | null;
      failure_count: number;
      last_synced_at: number | null;
      queued: number;
      oldest_queued_at: number | null;
      pending_cleanup: number;
      last_job_at: number | null;
    }>();
  const github = connections.results
    .filter(
      (row) =>
        !user.token ||
        !user.token.repositoryIds ||
        user.token.repositoryIds.includes(row.repository_id)
    )
    .slice(0, MAX_CONNECTIONS)
    .map((row) => ({
      connectionId: row.connection_id,
      repository: row.repository,
      remote: row.remote,
      enabled: row.enabled === 1,
      runnerEnabled: row.runner_enabled === 1,
      errorCode: row.error_code,
      failureCount: row.failure_count,
      lastSyncedAt: row.last_synced_at,
      queued: row.queued,
      oldestQueuedAt: row.oldest_queued_at,
      pendingCleanup: row.pending_cleanup,
      lastJobAt: row.last_job_at,
    }));
  const queued = await queueRows(env, user);
  const result: RunnerOverview = {
    generatedAt: now,
    runners: [],
    github,
    queue: queued.rows.map((job) => {
      const labels = safeLabels(job.labels_json);
      return {
        kind: job.kind,
        id: job.id,
        repository: job.repository,
        labels,
        claim: parseJobClaim(labels, job.minutes),
        createdAt: job.created_at,
        blockedBy: {},
      };
    }),
    truncated: truncated || connections.results.length > MAX_CONNECTIONS || queued.truncated,
  };
  return Response.json({ data: result });
}

interface Cursor {
  startedAt: number;
  kind: "gitedge" | "github";
  id: string;
}
function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeCursor(value: string): Cursor | null {
  try {
    const cursor = HistoryCursorSchema.safeParse(
      JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/")))
    );
    return cursor.success ? cursor.data : null;
  } catch {
    return null;
  }
}

export async function handleRunnerHistory(
  user: TrustedUser | null,
  env: RunnerOverviewEnv,
  request: Request
): Promise<Response> {
  if (!humanAdmin(user))
    return errorResponse(
      403,
      "forbidden",
      "A human administrator is required to view runner history."
    );
  const params = new URL(request.url).searchParams;
  const runnerId = params.get("runner");
  if (!runnerId) return errorResponse(400, "bad_request", "A runner is required.");
  const runner = await authorizedRunner(env, user, runnerId);
  if (!runner) return errorResponse(404, "not_found", "Runner registration was not found.");
  const requested = Number(params.get("limit") ?? MAX_HISTORY);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_HISTORY)
    return errorResponse(400, "bad_request", "History limit is invalid.");
  const beforeParam = params.get("before");
  let cursor: Cursor | null = null;
  let before: number | null = null;
  if (beforeParam !== null) {
    const numeric = Number(beforeParam);
    if (Number.isSafeInteger(numeric) && numeric >= 0) before = numeric;
    else {
      cursor = decodeCursor(beforeParam);
      if (!cursor) return errorResponse(400, "bad_request", "History cursor is invalid.");
    }
  }
  const makeFilter = (
    kind: Cursor["kind"],
    idColumn: string
  ): { sql: string; args: Array<string | number> } => {
    if (cursor) {
      const kindAfter = kind === "github" && cursor.kind === "gitedge";
      const kindBefore = kind === "gitedge" && cursor.kind === "github";
      if (kindAfter) return { sql: "j.started_at<=?", args: [cursor.startedAt] };
      if (kindBefore) return { sql: "j.started_at<?", args: [cursor.startedAt] };
      return {
        sql: `(j.started_at<? OR (j.started_at=? AND ${idColumn}>?))`,
        args: [cursor.startedAt, cursor.startedAt, cursor.id],
      };
    }
    return before === null ? { sql: "1=1", args: [] } : { sql: "j.started_at<?", args: [before] };
  };
  const edgeFilter = makeFilter("gitedge", "a.id");
  const githubFilter = makeFilter("github", "j.id");
  const [edge, github] = await Promise.all([
    env.DB.prepare(
      `SELECT 'gitedge' AS kind,a.id,j.runner_id,n.slug||'/'||p.slug AS repository,j.labels_json,
      j.started_at,j.completed_at,j.conclusion FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
      JOIN repositories p ON p.id=a.repository_id JOIN namespaces n ON n.id=p.namespace_id
      WHERE j.runner_id=? AND j.started_at IS NOT NULL AND ${edgeFilter.sql} AND (
        EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
        EXISTS (SELECT 1 FROM repository_collaborators c WHERE c.repository_id=p.id AND c.user_id=? AND c.role='admin'))
      ORDER BY j.started_at DESC,a.id LIMIT ?`
    )
      .bind(runnerId, ...edgeFilter.args, user.id, user.id, requested + 1)
      .all<{
        kind: "gitedge";
        id: string;
        runner_id: string | null;
        repository: string;
        labels_json: string;
        started_at: number | null;
        completed_at: number | null;
        conclusion: RunnerHistoryItem["conclusion"];
      }>(),
    env.DB.prepare(
      `SELECT 'github' AS kind,j.id,j.runner_id,n.slug||'/'||p.slug AS repository,j.labels_json,
      j.started_at,j.completed_at,j.conclusion FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id
      JOIN repositories p ON p.id=c.repository_id JOIN namespaces n ON n.id=p.namespace_id
      WHERE j.runner_id=? AND j.started_at IS NOT NULL AND ${githubFilter.sql} AND (
        EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=p.namespace_id AND m.user_id=? AND m.role='owner') OR
        EXISTS (SELECT 1 FROM repository_collaborators c2 WHERE c2.repository_id=p.id AND c2.user_id=? AND c2.role='admin'))
      ORDER BY j.started_at DESC,j.id LIMIT ?`
    )
      .bind(runnerId, ...githubFilter.args, user.id, user.id, requested + 1)
      .all<{
        kind: "github";
        id: string;
        runner_id: string | null;
        repository: string;
        labels_json: string;
        started_at: number | null;
        completed_at: number | null;
        conclusion: RunnerHistoryItem["conclusion"];
      }>(),
  ]);
  const items = [...edge.results, ...github.results]
    .map((row): RunnerHistoryItem => ({
      kind: row.kind,
      id: row.id,
      runnerId: row.runner_id,
      repository: row.repository,
      labels: safeLabels(row.labels_json),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      conclusion: row.conclusion,
      durationMs:
        row.started_at === null
          ? null
          : Math.max(0, (row.completed_at ?? Date.now()) - row.started_at),
    }))
    .sort(
      (a, b) =>
        (b.startedAt ?? 0) - (a.startedAt ?? 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  const page = items.slice(0, requested);
  const nextBefore =
    items.length > requested && page.length
      ? encodeCursor({
          startedAt: page[page.length - 1]!.startedAt!,
          kind: page[page.length - 1]!.kind,
          id: page[page.length - 1]!.id,
        })
      : null;
  const result: RunnerHistory = { items: page, nextBefore };
  return Response.json({ data: result });
}
