import {
  RunnerBudgetSchema,
  RunnerCapacitySchema,
  RUNNER_CLAIM_CANDIDATE_LIMIT,
  RUNNER_CAPACITY_STALE_MS,
  RUNNER_LEASE_MS,
  RUNNER_DEFERRAL_AGE_MS,
  RUNNER_FAILURE_HOLD_BASE_MS,
  RUNNER_FAILURE_HOLD_MAX_MS,
  RUNNER_FAILURE_HOLD_THRESHOLD,
  RUNNER_PEER_SCORE_MARGIN,
  RUNNER_SAMPLE_RETENTION_MS,
  RUNNER_SAMPLE_CLEANUP_LIMIT,
  type JobClaim,
  type RunnerBudget,
  type RunnerCapacity,
  type RunnerJobKind,
} from "../../../packages/contracts/src/runners";
import {
  eligibilityReasons,
  hasNeedLabels,
  matchesLabels,
  parseJobClaim,
  scoreRunner,
} from "../../../packages/contracts/runner-scheduling.mjs";
import type { RunnerEnv, RunnerRow } from "./runners";

export interface RunnerCandidate {
  kind: RunnerJobKind;
  execution_kind: "workflow" | "signing";
  id: string;
  repository_id: string;
  created_at: number;
  labels_json: string;
  default_minutes: number;
  request_id: string | null;
  stage: string | null;
  input_digest: string | null;
  workflow_oid: string | null;
  profile_revision: string | null;
  generation: number | null;
  nonce: string | null;
  platform: "macos" | "windows" | "ios" | null;
}

export interface RunnerPeer {
  id: string;
  repository_id: string | null;
  labels_json: string;
  capacity_json: string;
  budget_json: string | null;
  used_minutes_24h: number;
}

export interface EvaluatedRunnerCandidate {
  candidate: RunnerCandidate;
  labels: string[];
  claim: JobClaim;
  reasons: string[];
}

function parseLabels(json: string): string[] | null {
  try {
    const labels: unknown = JSON.parse(json);
    return Array.isArray(labels) && labels.every((label) => typeof label === "string")
      ? labels
      : null;
  } catch {
    return null;
  }
}

function parsedCapacity(json: string | null): RunnerCapacity | null {
  if (json === null) return null;
  try {
    const parsed = RunnerCapacitySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readRunnerCapacity(json: string | null): RunnerCapacity | null {
  return parsedCapacity(json);
}

function parsedBudget(json: string | null): RunnerBudget | null {
  if (json === null) return null;
  try {
    const parsed = RunnerBudgetSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readRunnerBudget(json: string | null): RunnerBudget | null {
  return parsedBudget(json);
}

const usageExpression = (alias: string, now: number, cutoff: number) => `
  COALESCE((SELECT SUM(MAX(0, MIN(COALESCE(j.completed_at, ${now}), ${now}) - MAX(j.started_at, ${cutoff})))
    FROM actions_runner_runs j WHERE j.runner_id=${alias}.id AND j.started_at IS NOT NULL
      AND j.status IN ('running','completed') AND COALESCE(j.completed_at, ${now})>${cutoff}), 0) / 60000.0
  + COALESCE((SELECT SUM(MAX(0, MIN(COALESCE(j.completed_at, ${now}), ${now}) - MAX(j.started_at, ${cutoff})))
    FROM actions_github_runner_jobs j WHERE j.runner_id=${alias}.id AND j.started_at IS NOT NULL
      AND j.status IN ('running','completed') AND COALESCE(j.completed_at, ${now})>${cutoff}), 0) / 60000.0`;

export async function runnerUsageMinutes24h(
  env: RunnerEnv,
  runnerId: string,
  now: number
): Promise<number> {
  const cutoff = now - RUNNER_SAMPLE_RETENTION_MS;
  const row = await env.DB.prepare(
    `SELECT ${usageExpression("r", now, cutoff)} AS used_minutes_24h
     FROM actions_runners r WHERE r.id=?`
  )
    .bind(runnerId)
    .first<{ used_minutes_24h: number }>();
  return row?.used_minutes_24h ?? 0;
}

export async function listRunnerCandidates(
  env: RunnerEnv,
  runner: RunnerRow
): Promise<RunnerCandidate[]> {
  const runnerLabels = JSON.stringify(parseLabels(runner.labels_json) ?? []);
  const rows = await env.DB.prepare(
    `SELECT * FROM (
      SELECT 'gitedge' AS kind,CASE WHEN s.run_id IS NULL THEN 'workflow' ELSE 'signing' END AS execution_kind,
        j.run_id AS id,p.id AS repository_id,a.created_at,j.labels_json,j.timeout_minutes AS default_minutes,
        s.request_id,s.stage,s.input_digest,s.workflow_oid,s.profile_revision,s.generation,s.nonce,s.platform
      FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
        JOIN repositories p ON p.id=a.repository_id JOIN users u ON u.id=a.created_by
        LEFT JOIN actions_signing_runs s ON s.run_id=j.run_id
      WHERE j.status='queued' AND p.namespace_id=? AND (? IS NULL OR p.id=?)
        AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
        AND p.actions_runner_enabled=1 AND u.disabled_at IS NULL
        AND (s.run_id IS NULL OR (s.owner_id=? AND s.repository_id=p.id))
        AND NOT EXISTS (SELECT 1 FROM json_each(j.labels_json) required
          WHERE lower(required.value) NOT LIKE 'need-%'
            AND lower(required.value) NOT IN (SELECT lower(value) FROM json_each(?)))
      UNION ALL
      SELECT 'github' AS kind,'workflow' AS execution_kind,j.id,p.id AS repository_id,j.created_at,
        j.labels_json,360 AS default_minutes,NULL AS request_id,NULL AS stage,
        NULL AS input_digest,NULL AS workflow_oid,NULL AS profile_revision,NULL AS generation,NULL AS nonce,NULL AS platform
      FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id
        JOIN repositories p ON p.id=c.repository_id JOIN users u ON u.id=c.created_by
      WHERE j.status='queued' AND c.enabled=1 AND c.runner_enabled=1
        AND p.namespace_id=? AND (? IS NULL OR p.id=?)
        AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1 AND u.disabled_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(j.labels_json) required
          WHERE lower(required.value) NOT LIKE 'need-%'
            AND lower(required.value) NOT IN (SELECT lower(value) FROM json_each(?)))
    ) ORDER BY created_at,id LIMIT ?`
  )
    .bind(
      runner.namespace_id,
      runner.repository_id,
      runner.repository_id,
      runner.created_by,
      runnerLabels,
      runner.namespace_id,
      runner.repository_id,
      runner.repository_id,
      runnerLabels,
      RUNNER_CLAIM_CANDIDATE_LIMIT
    )
    .all<RunnerCandidate>();
  return rows.results;
}

export function evaluateRunnerCandidate(
  runner: RunnerRow,
  capacity: RunnerCapacity | null,
  budget: RunnerBudget | null,
  usedMinutes24h: number,
  candidate: RunnerCandidate
): EvaluatedRunnerCandidate {
  const labels = parseLabels(candidate.labels_json);
  const claim = parseJobClaim(labels, candidate.default_minutes);
  const reasons = new Set<string>();
  if (!labels || !claim.valid) reasons.add("claim-invalid");
  if (runner.repository_id !== null && candidate.repository_id !== runner.repository_id)
    reasons.add("scope");
  if (candidate.execution_kind === "signing") {
    if (
      !candidate.request_id ||
      !candidate.stage ||
      !candidate.input_digest ||
      !candidate.workflow_oid ||
      !candidate.profile_revision ||
      candidate.generation === null ||
      !candidate.nonce ||
      candidate.platform === null
    )
      reasons.add("signing-job-invalid");
    if (
      !capacity ||
      (candidate.platform === "windows" && capacity.os !== "windows") ||
      (candidate.platform === "macos" && capacity.os !== "macos") ||
      (candidate.platform === "ios" && (capacity.os !== "macos" || capacity.arch !== "arm64"))
    )
      reasons.add("signing-platform");
  }
  if (labels) {
    const available = parseLabels(runner.labels_json) ?? [];
    for (const label of claim.labels) {
      if (!matchesLabels([label], available)) reasons.add(`label:${label}`);
    }
  }
  for (const reason of eligibilityReasons(capacity, budget, usedMinutes24h, claim, {
    allowUnknownLegacy: true,
    explicitNeeds: hasNeedLabels(labels),
  }))
    reasons.add(reason);
  return { candidate, labels: labels ?? [], claim, reasons: [...reasons] };
}

export async function runnerPeersForJob(
  env: RunnerEnv,
  runner: RunnerRow,
  repositoryId: string,
  now: number
): Promise<RunnerPeer[]> {
  const cutoff = now - RUNNER_CAPACITY_STALE_MS;
  const used = usageExpression("r", now, now - RUNNER_SAMPLE_RETENTION_MS);
  const rows = await env.DB.prepare(
    `SELECT r.id,r.repository_id,r.labels_json,r.capacity_json,r.budget_json,${used} AS used_minutes_24h
     FROM actions_runners r JOIN users u ON u.id=r.created_by
     WHERE r.id!=? AND r.namespace_id=? AND (r.repository_id IS NULL OR r.repository_id=?)
       AND r.revoked_at IS NULL AND u.disabled_at IS NULL
       AND (r.held_until IS NULL OR r.held_until<=?) AND r.capacity_reported_at>=?
       AND json_extract(r.capacity_json,'$.busy')=0
       AND NOT EXISTS (SELECT 1 FROM actions_runner_runs busy WHERE busy.runner_id=r.id AND busy.status='running')
       AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs busy WHERE busy.runner_id=r.id AND busy.status='running')
     ORDER BY r.last_seen_at DESC LIMIT 100`
  )
    .bind(runner.id, runner.namespace_id, repositoryId, now, cutoff)
    .all<RunnerPeer>();
  return rows.results;
}

export function betterPeerExists(
  peers: RunnerPeer[],
  requiredLabels: string[],
  claim: JobClaim,
  capacity: RunnerCapacity | null,
  budget: RunnerBudget | null,
  usedMinutes24h: number,
  createdAt: number,
  now: number
): boolean {
  if (now - createdAt >= RUNNER_DEFERRAL_AGE_MS || capacity === null) return false;
  const ownScore = scoreRunner(capacity, budget, usedMinutes24h, claim);
  for (const peer of peers) {
    const peerCapacity = parsedCapacity(peer.capacity_json);
    const peerBudget = parsedBudget(peer.budget_json);
    const peerLabels = parseLabels(peer.labels_json);
    if (!peerCapacity || !peerLabels || !matchesLabels(requiredLabels, peerLabels)) continue;
    if (eligibilityReasons(peerCapacity, peerBudget, peer.used_minutes_24h, claim).length > 0)
      continue;
    if (
      scoreRunner(peerCapacity, peerBudget, peer.used_minutes_24h, claim) <
      ownScore - RUNNER_PEER_SCORE_MARGIN
    )
      return true;
  }
  return false;
}

export async function saveRunnerDeferral(
  env: RunnerEnv,
  kind: RunnerJobKind,
  jobId: string,
  runnerId: string,
  reasons: string[],
  now: number
): Promise<void> {
  const json = JSON.stringify(reasons);
  await env.DB.prepare(
    `INSERT INTO actions_runner_deferrals (job_kind,job_id,reasons_json,updated_at) VALUES (?,?,json_object(?,json(?)),?)
     ON CONFLICT(job_kind,job_id) DO UPDATE SET
       reasons_json=json_set(actions_runner_deferrals.reasons_json, '$."' || ? || '"', json(?)),
       updated_at=excluded.updated_at`
  )
    .bind(kind, jobId, runnerId, json, now, runnerId, json)
    .run();
}

export async function clearRunnerDeferral(
  env: RunnerEnv,
  kind: RunnerJobKind,
  jobId: string
): Promise<void> {
  await env.DB.prepare("DELETE FROM actions_runner_deferrals WHERE job_kind=? AND job_id=?")
    .bind(kind, jobId)
    .run();
}

export async function cleanRunnerSchedulingData(env: RunnerEnv, now: number): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM actions_runner_samples WHERE (runner_id,minute) IN (
      SELECT runner_id,minute FROM actions_runner_samples WHERE minute<? ORDER BY minute LIMIT ?)`
  )
    .bind(Math.floor((now - RUNNER_SAMPLE_RETENTION_MS) / 60_000), RUNNER_SAMPLE_CLEANUP_LIMIT)
    .run();
  await env.DB.prepare(
    `DELETE FROM actions_runner_deferrals WHERE job_kind='gitedge' AND job_id IN (
      SELECT d.job_id FROM actions_runner_deferrals d WHERE d.job_kind='gitedge'
        AND NOT EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=d.job_id AND j.status='queued')
      ORDER BY d.updated_at LIMIT ?)`
  )
    .bind(RUNNER_SAMPLE_CLEANUP_LIMIT)
    .run();
  await env.DB.prepare(
    `DELETE FROM actions_runner_deferrals WHERE job_kind='github' AND job_id IN (
      SELECT d.job_id FROM actions_runner_deferrals d WHERE d.job_kind='github'
        AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=d.job_id AND j.status='queued')
      ORDER BY d.updated_at LIMIT ?)`
  )
    .bind(RUNNER_SAMPLE_CLEANUP_LIMIT)
    .run();
}

export function runnerCandidateLabels(candidate: RunnerCandidate): string[] {
  return parseLabels(candidate.labels_json) ?? [];
}

export async function claimRunnerCandidate(
  env: RunnerEnv,
  runner: RunnerRow,
  candidate: RunnerCandidate,
  minutes: number,
  leaseHash: string,
  now: number,
  capacityReportedAt: number | null
): Promise<boolean> {
  const cutoff = now - RUNNER_SAMPLE_RETENTION_MS;
  const usage = usageExpression("r", now, cutoff);
  const signingJobGuard = `AND ((?='workflow' AND NOT EXISTS (
      SELECT 1 FROM actions_signing_runs s WHERE s.run_id=actions_runner_runs.run_id
    )) OR (?='signing' AND EXISTS (
      SELECT 1 FROM actions_signing_runs s WHERE s.run_id=actions_runner_runs.run_id
        AND s.request_id=? AND s.stage=? AND s.input_digest=? AND s.owner_id=? AND s.repository_id=? AND s.workflow_oid=?
        AND s.profile_revision=? AND s.generation=? AND s.nonce=? AND s.platform=?
    )))`;
  const runnerGuard = `EXISTS (SELECT 1 FROM actions_runners r WHERE r.id=? AND r.revoked_at IS NULL
    AND r.namespace_id=? AND r.created_by=? AND r.repository_id IS ?
    AND r.labels_json IS ?
    AND (r.held_until IS NULL OR r.held_until<=?) AND r.capacity_reported_at IS ?
    AND r.capacity_json IS ? AND r.budget_json IS ?
    AND (json_extract(r.budget_json,'$.maxJobMinutes') IS NULL OR ?<=json_extract(r.budget_json,'$.maxJobMinutes'))
    AND (json_extract(r.budget_json,'$.dailyMinutes') IS NULL OR (${usage})+?<=json_extract(r.budget_json,'$.dailyMinutes'))) `;
  const runnerBindings = [
    runner.id,
    runner.namespace_id,
    runner.created_by,
    runner.repository_id,
    runner.labels_json,
    now,
    capacityReportedAt,
    runner.capacity_json,
    runner.budget_json,
    minutes,
    minutes,
  ];
  let claimed: { id: string } | null;
  if (candidate.kind === "gitedge") {
    claimed = await env.DB.prepare(
      `UPDATE actions_runner_runs SET status='running',runner_id=?,lease_hash=?,
        lease_expires_at=MIN(?,?+MIN(timeout_minutes,?)*60000),timeout_minutes=MIN(timeout_minutes,?),started_at=?
       WHERE run_id=? AND status='queued'
         ${signingJobGuard}
         AND NOT EXISTS (SELECT 1 FROM actions_runner_runs busy WHERE busy.runner_id=? AND busy.status='running')
         AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs busy WHERE busy.runner_id=? AND busy.status='running')
         AND ${runnerGuard}
       RETURNING run_id AS id`
    )
      .bind(
        runner.id,
        leaseHash,
        now + RUNNER_LEASE_MS,
        now,
        minutes,
        minutes,
        now,
        candidate.id,
        candidate.execution_kind,
        candidate.execution_kind,
        candidate.request_id,
        candidate.stage,
        candidate.input_digest,
        runner.created_by,
        candidate.repository_id,
        candidate.workflow_oid,
        candidate.profile_revision,
        candidate.generation,
        candidate.nonce,
        candidate.platform,
        runner.id,
        runner.id,
        ...runnerBindings
      )
      .first<{ id: string }>();
  } else {
    claimed = await env.DB.prepare(
      `UPDATE actions_github_runner_jobs SET status='running',runner_id=?,lease_hash=?,
        lease_expires_at=?,started_at=?,cleanup_pending=1
       WHERE id=? AND status='queued'
         AND NOT EXISTS (SELECT 1 FROM actions_runner_runs busy WHERE busy.runner_id=? AND busy.status='running')
         AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs busy WHERE busy.runner_id=? AND busy.status='running')
         AND ${runnerGuard}
       RETURNING id`
    )
      .bind(
        runner.id,
        leaseHash,
        now + RUNNER_LEASE_MS,
        now,
        candidate.id,
        runner.id,
        runner.id,
        ...runnerBindings
      )
      .first<{ id: string }>();
  }
  return claimed !== null;
}

export async function recordRunnerFailure(
  env: RunnerEnv,
  runnerId: string | null,
  now: number
): Promise<void> {
  if (runnerId === null) return;
  await env.DB.prepare(
    `UPDATE actions_runners SET consecutive_failures=consecutive_failures+1,
       held_until=CASE WHEN consecutive_failures+1>=? THEN
         ?+MIN(?,?*(1 << MIN(3,MAX(0,consecutive_failures+1-?)))) ELSE held_until END
     WHERE id=? AND revoked_at IS NULL`
  )
    .bind(
      RUNNER_FAILURE_HOLD_THRESHOLD,
      now,
      RUNNER_FAILURE_HOLD_MAX_MS,
      RUNNER_FAILURE_HOLD_BASE_MS,
      RUNNER_FAILURE_HOLD_THRESHOLD,
      runnerId
    )
    .run();
}

export async function clearRunnerFailures(env: RunnerEnv, runnerId: string | null): Promise<void> {
  if (runnerId === null) return;
  await env.DB.prepare(
    "UPDATE actions_runners SET consecutive_failures=0,held_until=NULL WHERE id=?"
  )
    .bind(runnerId)
    .run();
}
