import {
  gitedgeNetworkRetryKey,
  isNetworkFailure,
  permitsNetworkRetry,
} from "../../../src/worker/common/runner-network";
import type { RunnerEnv, RunnerRow } from "./runners";
import { z } from "zod";
import { createLogger } from "../../../src/worker/common/logger";

export async function retryRunnerNetworkFailure(
  env: RunnerEnv,
  runner: RunnerRow,
  runId: string,
  leaseHash: string,
  log: string,
  now: number
): Promise<boolean> {
  const failed = [...log.matchAll(/^\[[^\n]+\] Failed: [^\n]+/gm)].at(-1);
  if (!failed || failed.index === undefined) return false;
  const beforeFailure = log.slice(0, failed.index);
  const previous = [...beforeFailure.matchAll(/^\[[^\n]+\] Succeeded: [^\n]+/gm)].at(-1);
  if (!isNetworkFailure(beforeFailure.slice(previous?.index ?? 0))) return false;
  const run = await env.DB.prepare(
    `SELECT a.repository_id,j.labels_json,j.started_at,j.completed_at
    FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
    WHERE j.run_id=? AND j.runner_id=? AND j.lease_hash=? AND j.status='completed'
      AND j.conclusion='failure' AND j.cancel_requested=0
      AND NOT EXISTS (SELECT 1 FROM actions_signing_runs s WHERE s.run_id=j.run_id)`
  )
    .bind(runId, runner.id, leaseHash)
    .first<{
      repository_id: string;
      labels_json: string;
      started_at: number;
      completed_at: number;
    }>();
  if (
    !run ||
    !permitsNetworkRetry(
      z.array(z.string()).parse(JSON.parse(run.labels_json)),
      z.array(z.string()).parse(JSON.parse(runner.labels_json))
    )
  )
    return false;
  const key = gitedgeNetworkRetryKey(runId);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO actions_runner_network_retries
      (retry_key,kind,repository_id,source_job_id,source_runner_id,source_lease_hash,failure_log,
       started_at,completed_at,state,created_at)
      SELECT ?,'gitedge',?,?,?,?,?,?,?,'pending',? FROM actions_runner_runs j
      WHERE j.run_id=? AND j.status='completed' AND j.conclusion='failure'
        AND j.runner_id=? AND j.lease_hash=? AND j.cancel_requested=0`
    ).bind(
      key,
      run.repository_id,
      runId,
      runner.id,
      leaseHash,
      log,
      run.started_at,
      run.completed_at,
      now,
      runId,
      runner.id,
      leaseHash
    ),
    env.DB.prepare(
      `UPDATE actions_job_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE run_id=?`
    ).bind(now, runId),
    env.DB.prepare(
      `UPDATE actions_runner_runs SET status='queued',conclusion=NULL,runner_id=NULL,
      lease_hash=NULL,lease_expires_at=NULL,started_at=NULL,completed_at=NULL,
      log='A network failure was recorded. Waiting to retry on another unrestricted runner.'
      WHERE run_id=? AND status='completed' AND conclusion='failure' AND cancel_requested=0
        AND runner_id=? AND lease_hash=? AND EXISTS (
          SELECT 1 FROM actions_runner_network_retries r WHERE r.retry_key=?
            AND r.source_lease_hash=? AND r.state='pending' AND r.requested_at IS NULL)`
    ).bind(runId, runner.id, leaseHash, key, leaseHash),
    env.DB.prepare(
      `UPDATE actions_runner_network_retries SET state='requested',requested_at=?
      WHERE retry_key=? AND state='pending' AND changes()=1`
    ).bind(now, key),
    env.DB.prepare(
      `DELETE FROM actions_job_tokens WHERE run_id=? AND revoked_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM actions_runner_runs WHERE run_id=? AND status='queued')`
    ).bind(runId, runId),
  ]);
  if (results[2].meta.changes !== 1) return false;
  createLogger(env.LOG_LEVEL, { service: "runner" }).info("runner:network-retry-queued", {
    runId,
    runnerId: runner.id,
  });
  return true;
}
