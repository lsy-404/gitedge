import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  RUNNER_TOKEN_PREFIX,
  RunnerLabelsSchema,
  sha256Hex,
  isRunnerSystemLabel,
} from "../../../packages/contracts/src/index";
import { matchesLabels, parseJobClaim } from "../../../packages/contracts/runner-scheduling.mjs";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import type { RunnerEnv } from "./runners";
import { createLogger } from "../../../src/worker/common/logger";

const issuer = "https://token.actions.githubusercontent.com";
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), { timeoutDuration: 5000 });
const inputSchema = z
  .object({
    bootstrapToken: z.string().regex(/^[a-f0-9]{64}$/),
    oidcToken: z.string().min(1).max(16384),
    labels: RunnerLabelsSchema,
  })
  .strict();
const identitySchema = z.object({
  repository_id: z.string(),
  repository: z.string(),
  run_id: z.string(),
  run_attempt: z.literal("1"),
  event_name: z.literal("workflow_dispatch"),
  workflow_ref: z.string(),
  workflow_sha: z.string(),
});

interface Dispatch {
  id: string;
  job_kind: "gitedge" | "github";
  job_id: string;
  repository_id: string;
  owner_id: string;
  expires_at: number;
  status: string;
  github_run_id: string | null;
  github_repository_id: string | null;
  github_repository: string | null;
  github_workflow_ref: string | null;
  github_workflow_sha: string | null;
  namespace_id: string;
  owner: string;
  repository: string;
  labels_json: string;
  platform: "macos" | "ios" | "windows" | null;
}

export async function bootstrapHostedRunner(request: Request, env: RunnerEnv): Promise<Response> {
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  const input = inputSchema.safeParse(await readJsonLimited(request, 32768));
  if (!input.success) return errorResponse(400, "bad_request", "Invalid hosted runner bootstrap.");
  const hash = await sha256Hex(input.data.bootstrapToken);
  const row = await env.DB.prepare(
    `SELECT h.*,p.namespace_id,p.slug AS repository,n.slug AS owner,
    CASE WHEN h.job_kind='gitedge' THEN (SELECT labels_json FROM actions_runner_runs WHERE run_id=h.job_id) ELSE (SELECT labels_json FROM actions_github_runner_jobs WHERE id=h.job_id) END AS labels_json,
    (SELECT platform FROM actions_signing_runs WHERE run_id=h.job_id AND h.job_kind='gitedge') AS platform
    FROM actions_hosted_runner_dispatches h JOIN repositories p ON p.id=h.repository_id
    JOIN namespaces n ON n.id=p.namespace_id JOIN forge_hosted_runner_settings s ON s.owner_id=h.owner_id AND s.connection_id=h.connection_id
    JOIN users u ON u.id=h.owner_id AND u.disabled_at IS NULL
    WHERE h.bootstrap_hash=? AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1`
  )
    .bind(hash)
    .first<Dispatch>();
  if (!row || row.expires_at <= Date.now())
    return errorResponse(401, "unauthorized", "Hosted runner bootstrap expired.");
  if (row.status === "dispatching")
    return errorResponse(409, "pending", "Hosted runner dispatch is pending.");
  if (row.status !== "dispatched")
    return errorResponse(401, "unauthorized", "Hosted runner bootstrap is unavailable.");
  try {
    const verified = await jwtVerify(input.data.oidcToken, keys, {
      issuer,
      audience: "gitedge-hosted-runner",
      algorithms: ["RS256"],
      clockTolerance: 30,
    });
    const identity = identitySchema.parse(verified.payload);
    if (
      identity.repository_id !== row.github_repository_id ||
      identity.repository.toLowerCase() !== row.github_repository?.toLowerCase() ||
      identity.run_id !== row.github_run_id ||
      identity.workflow_ref.toLowerCase() !== row.github_workflow_ref?.toLowerCase() ||
      identity.workflow_sha !== row.github_workflow_sha
    )
      return errorResponse(
        401,
        "unauthorized",
        "Hosted runner identity does not match its dispatch."
      );
  } catch {
    return errorResponse(401, "unauthorized", "Invalid hosted runner identity.");
  }
  let required: string[];
  try {
    required = RunnerLabelsSchema.parse(JSON.parse(row.labels_json));
  } catch {
    return errorResponse(422, "invalid_job", "The job labels are invalid.");
  }
  const host = input.data.labels.map((label) => label.toLowerCase());
  if (
    ["linux", "windows", "macos"].filter((label) => host.includes(label)).length !== 1 ||
    ["x64", "arm64"].filter((label) => host.includes(label)).length !== 1 ||
    (row.platform === "windows" && !host.includes("windows")) ||
    ((row.platform === "macos" || row.platform === "ios") && !host.includes("macos")) ||
    (row.platform === "ios" && !host.includes("arm64")) ||
    required.filter(isRunnerSystemLabel).some((label) => {
      const value = label.toLowerCase();
      if (["amd64", "x86_64"].includes(value)) return !host.includes("x64");
      if (value === "aarch64") return !host.includes("arm64");
      return !matchesLabels([label], input.data.labels);
    })
  )
    return errorResponse(422, "invalid_job", "The hosted runner does not match the job platform.");
  const claim = parseJobClaim(required);
  const labels = RunnerLabelsSchema.safeParse([
    ...input.data.labels,
    ...claim.labels.filter((label) => !host.includes(label.toLowerCase())),
  ]);
  if (!claim.valid || !labels.success)
    return errorResponse(422, "invalid_job", "The job labels are invalid.");
  const now = Date.now(),
    id = crypto.randomUUID(),
    token = `${RUNNER_TOKEN_PREFIX}${randomHex(32)}`,
    expiresAt = now + 7 * 60 * 60_000;
  const tokenHash = await sha256Hex(token);
  const [insert] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO actions_runners (id,name,namespace_id,repository_id,created_by,labels_json,token_hash,created_at,hosted_job_kind,hosted_job_id,expires_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM actions_hosted_runner_dispatches h JOIN repositories p ON p.id=h.repository_id JOIN users u ON u.id=h.owner_id JOIN forge_hosted_runner_settings s ON s.owner_id=h.owner_id AND s.connection_id=h.connection_id WHERE h.id=? AND h.status='dispatched' AND h.expires_at>? AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1 AND u.disabled_at IS NULL AND ((h.job_kind='gitedge' AND p.actions_runner_enabled=1 AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=h.job_id AND j.status='queued')) OR (h.job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id WHERE j.id=h.job_id AND j.status='queued' AND c.enabled=1 AND c.runner_enabled=1))))`
    ).bind(
      id,
      "Hosted runner",
      row.namespace_id,
      row.repository_id,
      row.owner_id,
      JSON.stringify(labels.data),
      tokenHash,
      now,
      row.job_kind,
      row.job_id,
      expiresAt,
      row.id,
      now
    ),
    env.DB.prepare(
      "UPDATE actions_hosted_runner_dispatches SET status='consumed',runner_id=? WHERE id=? AND status='dispatched' AND EXISTS (SELECT 1 FROM actions_runners WHERE id=?)"
    ).bind(id, row.id, id),
  ]);
  if (insert.meta.changes !== 1)
    return errorResponse(422, "invalid_job", "The queued job is no longer available.");
  return dataResponse({
    runner: {
      id,
      scope: { owner: row.owner, repository: row.repository },
      labels: labels.data,
      expiresAt,
    },
    token,
  });
}

const dispatchResult = z.object({
  data: z.object({
    runId: z.union([z.string(), z.number()]),
    repositoryId: z.union([z.string(), z.number()]),
    repository: z.string(),
    workflowRef: z.string(),
    workflowSha: z.string().regex(/^[a-f0-9]{40}$/),
  }),
});
interface QueuedJob {
  kind: "gitedge" | "github";
  id: string;
  repository_id: string;
  owner_id: string;
  connection_id: string;
}

export async function reconcileHostedRunners(env: RunnerEnv): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "DELETE FROM actions_hosted_runner_dispatches WHERE status='failed' AND error_code='hosted_runner_unavailable' AND created_at<?"
  )
    .bind(now - 15 * 60_000)
    .run();
  const stale = await env.DB.prepare(
    `SELECT h.id,h.runner_id,h.github_run_id FROM actions_hosted_runner_dispatches h
    WHERE h.status IN ('dispatching','dispatched','consumed','cancel_pending') AND (
      h.status='cancel_pending' OR
      (h.expires_at<=? AND (h.status!='consumed' OR NOT EXISTS (SELECT 1 FROM actions_runner_runs j WHERE h.job_kind='gitedge' AND j.run_id=h.job_id AND j.status='running' AND j.runner_id=h.runner_id) AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE h.job_kind='github' AND j.id=h.job_id AND j.status='running' AND j.runner_id=h.runner_id))) OR
      (h.status='consumed' AND EXISTS (SELECT 1 FROM actions_runners r WHERE r.id=h.runner_id AND r.expires_at<=?)) OR
      NOT EXISTS (SELECT 1 FROM forge_hosted_runner_settings s JOIN users u ON u.id=s.owner_id JOIN repositories p ON p.id=h.repository_id WHERE s.owner_id=h.owner_id AND s.connection_id=h.connection_id AND u.disabled_at IS NULL AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1) OR
      (h.job_kind='gitedge' AND NOT EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=h.job_id AND (j.status='queued' OR (j.status='running' AND j.runner_id=h.runner_id)))) OR
      (h.job_kind='github' AND NOT EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=h.job_id AND (j.status='queued' OR (j.status='running' AND j.runner_id=h.runner_id))))) LIMIT 20`
  )
    .bind(now, now)
    .all<{ id: string; runner_id: string | null; github_run_id: string | null }>();
  for (const row of stale.results) {
    if (row.runner_id)
      await env.DB.prepare(
        "UPDATE actions_runners SET revoked_at=COALESCE(revoked_at,?) WHERE id=?"
      )
        .bind(now, row.runner_id)
        .run();
    if (row.github_run_id) {
      const cancelled = await env.FORGE.fetch("https://forge.internal/internal/hosted-runner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "cancel", reservationId: row.id }),
      });
      if (!cancelled.ok) continue;
    }
    await env.DB.prepare(
      `UPDATE actions_hosted_runner_dispatches SET
        status=CASE WHEN github_run_id IS NOT NULL AND expires_at<=? AND
          ((job_kind='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs j WHERE j.run_id=job_id AND j.status='queued')) OR
           (job_kind='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs j WHERE j.id=job_id AND j.status='queued')))
          THEN 'failed' ELSE 'cancelled' END,
        error_code=CASE WHEN github_run_id IS NOT NULL AND expires_at<=? THEN 'hosted_runner_unavailable' ELSE error_code END,
        created_at=CASE WHEN github_run_id IS NOT NULL AND expires_at<=? THEN ? ELSE created_at END
       WHERE id=? AND status IN ('dispatching','dispatched','consumed','cancel_pending')`
    )
      .bind(now, now, now, now, row.id)
      .run();
  }
  const jobs = await env.DB.prepare(
    `SELECT * FROM (
    SELECT 'gitedge' AS kind,j.run_id AS id,p.id AS repository_id,COALESCE(s.owner_id,a.created_by) AS owner_id,
      (SELECT h.connection_id FROM forge_hosted_runner_settings h WHERE h.owner_id=COALESCE(s.owner_id,a.created_by)) AS connection_id,a.created_at
      FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id JOIN repositories p ON p.id=a.repository_id LEFT JOIN actions_signing_runs s ON s.run_id=j.run_id
      WHERE j.status='queued' AND a.created_at<=? AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1 AND p.actions_runner_enabled=1
    UNION ALL
    SELECT 'github',j.id,p.id,c.created_by,(SELECT h.connection_id FROM forge_hosted_runner_settings h WHERE h.owner_id=c.created_by),j.created_at FROM actions_github_runner_jobs j JOIN forge_github_connections c ON c.id=j.connection_id JOIN repositories p ON p.id=c.repository_id
      WHERE j.status='queued' AND j.created_at<=? AND c.enabled=1 AND c.runner_enabled=1 AND p.deleted_at IS NULL AND p.archived=0 AND p.actions_enabled=1
    ) q WHERE connection_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actions_hosted_runner_dispatches h WHERE h.job_kind=q.kind AND h.job_id=q.id)
    ORDER BY created_at,id LIMIT 10`
  )
    .bind(now - 15 * 60_000, now - 15 * 60_000)
    .all<QueuedJob>();
  for (const job of jobs.results) {
    const id = crypto.randomUUID(),
      token = randomHex(32);
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO actions_hosted_runner_dispatches (id,job_kind,job_id,repository_id,owner_id,connection_id,bootstrap_hash,created_at,expires_at,status)
      SELECT ?,?,?,?,?,?,?,?,?,'dispatching' WHERE (?='gitedge' AND EXISTS (SELECT 1 FROM actions_runner_runs WHERE run_id=? AND status='queued')) OR (?='github' AND EXISTS (SELECT 1 FROM actions_github_runner_jobs WHERE id=? AND status='queued'))`
    )
      .bind(
        id,
        job.kind,
        job.id,
        job.repository_id,
        job.owner_id,
        job.connection_id,
        await sha256Hex(token),
        now,
        now + 15 * 60_000,
        job.kind,
        job.id,
        job.kind,
        job.id
      )
      .run();
    if (inserted.meta.changes !== 1) continue;
    try {
      const response = await env.FORGE.fetch("https://forge.internal/internal/hosted-runner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "dispatch", reservationId: id, bootstrapToken: token }),
      });
      if (!response.ok) {
        const body = z
          .object({ error: z.object({ code: z.string() }) })
          .safeParse(await readJsonLimited(response, 16384));
        const code =
          body.success && body.data.error.code === "hosted_runner_unavailable"
            ? "hosted_runner_unavailable"
            : "hosted_runner_dispatch_outcome_unknown";
        await env.DB.prepare(
          "UPDATE actions_hosted_runner_dispatches SET status='failed',error_code=? WHERE id=? AND status='dispatching'"
        )
          .bind(code, id)
          .run();
        continue;
      }
      const result = dispatchResult.parse(await readJsonLimited(response, 16384)).data;
      await env.DB.prepare(
        `UPDATE actions_hosted_runner_dispatches SET status=CASE WHEN status='dispatching' THEN 'dispatched' ELSE 'cancel_pending' END,github_run_id=?,github_repository_id=?,github_repository=?,github_workflow_ref=?,github_workflow_sha=? WHERE id=?`
      )
        .bind(
          String(result.runId),
          String(result.repositoryId),
          result.repository,
          result.workflowRef,
          result.workflowSha,
          id
        )
        .run();
      const current = await env.DB.prepare(
        "SELECT status FROM actions_hosted_runner_dispatches WHERE id=?"
      )
        .bind(id)
        .first<{ status: string }>();
      if (current?.status === "cancel_pending")
        await env.FORGE.fetch("https://forge.internal/internal/hosted-runner", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation: "cancel", reservationId: id }),
        });
    } catch {
      await env.DB.prepare(
        "UPDATE actions_hosted_runner_dispatches SET status='failed',error_code='hosted_runner_dispatch_outcome_unknown' WHERE id=? AND status='dispatching'"
      )
        .bind(id)
        .run();
      createLogger(env.LOG_LEVEL, { service: "hosted-runner" }).warn(
        "hosted-runner:dispatch-failed",
        { id }
      );
    }
  }
}
