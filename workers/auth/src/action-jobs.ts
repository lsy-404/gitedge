import { z } from "zod";
import {
  ACTION_JOB_TOKEN_PREFIX,
  sha256Hex,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { randomHex } from "../../../src/worker/common/encoding";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";

interface JobAuthEnv {
  DB: D1Database;
}
interface JobRow {
  runId: string;
  repositoryId: string;
  commitOid: string;
  permission: "read" | "write";
  userId: string;
  identifier: string;
  groupKey: string;
  runnerOwner: string;
  namespaceId: string;
  runnerRepository: string | null;
}
const activeJob = `FROM actions_runner_runs j JOIN actions_runs a ON a.id = j.run_id
  JOIN actions_runners r ON r.id = j.runner_id JOIN repositories p ON p.id = a.repository_id
  JOIN users u ON u.id = a.created_by JOIN users owner ON owner.id = r.created_by
  WHERE j.status = 'running' AND j.cancel_requested = 0 AND j.lease_expires_at > ?
  AND r.revoked_at IS NULL AND u.disabled_at IS NULL AND owner.disabled_at IS NULL
  AND p.deleted_at IS NULL AND p.archived = 0 AND p.actions_enabled = 1 AND p.actions_runner_enabled = 1
  AND p.namespace_id = r.namespace_id AND (r.repository_id IS NULL OR r.repository_id = p.id)`;

export function isActionJobToken(token: string): boolean {
  return /^ge_job_[0-9a-f]{64}$/.test(token);
}

async function authorizedJob(env: JobAuthEnv, row: JobRow): Promise<boolean> {
  const role = await repositoryRole(env.DB, row.repositoryId, row.userId);
  if (!writableRole(role)) return false;
  if (row.runnerRepository !== null)
    return (await repositoryRole(env.DB, row.repositoryId, row.runnerOwner)) === "admin";
  return (
    (await env.DB.prepare(
      "SELECT 1 AS found FROM namespace_memberships WHERE namespace_id = ? AND user_id = ? AND role = 'owner'"
    )
      .bind(row.namespaceId, row.runnerOwner)
      .first()) !== null
  );
}

export async function authenticateActionJob(
  env: JobAuthEnv,
  token: string
): Promise<TrustedUser | null> {
  if (!isActionJobToken(token)) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT a.id AS runId, a.repository_id AS repositoryId,
    a.commit_oid AS commitOid, j.permission, u.id AS userId, u.identifier, u.group_key AS groupKey,
    r.created_by AS runnerOwner, r.namespace_id AS namespaceId, r.repository_id AS runnerRepository
    ${activeJob} AND EXISTS (SELECT 1 FROM actions_job_tokens t WHERE t.run_id = j.run_id AND t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?)`
  )
    .bind(now, await sha256Hex(token), now)
    .first<JobRow>();
  if (!row || !(await authorizedJob(env, row))) return null;
  return {
    id: row.userId,
    identifier: row.identifier,
    groupKey: row.groupKey,
    job: { runId: row.runId, repositoryId: row.repositoryId, commitOid: row.commitOid },
    token: {
      id: row.runId,
      scopes: [row.permission === "write" ? "repo:write" : "repo:read"],
      repositoryIds: [row.repositoryId],
    },
  };
}

export async function issueActionJobToken(request: Request, env: JobAuthEnv): Promise<Response> {
  if (new URL(request.url).hostname !== "auth.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = z
    .object({
      runId: z.string().uuid(),
      runnerId: z.string().uuid(),
      leaseToken: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .safeParse(await readJsonLimited(request, 8192));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid job lease.");
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT a.id AS runId, a.repository_id AS repositoryId,
    a.commit_oid AS commitOid, j.permission, u.id AS userId, u.identifier, u.group_key AS groupKey,
    r.created_by AS runnerOwner, r.namespace_id AS namespaceId, r.repository_id AS runnerRepository,
    j.started_at + j.timeout_minutes * 60000 AS expiresAt ${activeJob}
    AND j.run_id = ? AND j.runner_id = ? AND j.lease_hash = ?`
  )
    .bind(now, parsed.data.runId, parsed.data.runnerId, await sha256Hex(parsed.data.leaseToken))
    .first<JobRow & { expiresAt: number }>();
  if (!row || !(await authorizedJob(env, row)))
    return errorResponse(403, "forbidden", "The job lease is no longer authorized.");
  const token = `${ACTION_JOB_TOKEN_PREFIX}${randomHex(32)}`;
  const stored = await env.DB.prepare(
    `INSERT INTO actions_job_tokens (run_id, token_hash, expires_at)
    SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM actions_runner_runs WHERE run_id = ? AND status = 'running' AND lease_hash = ? AND lease_expires_at > ? AND cancel_requested = 0)
    ON CONFLICT(run_id) DO NOTHING`
  )
    .bind(
      row.runId,
      await sha256Hex(token),
      row.expiresAt,
      row.runId,
      await sha256Hex(parsed.data.leaseToken),
      now
    )
    .run();
  if (stored.meta.changes !== 1)
    return errorResponse(
      409,
      "conflict",
      "The job credential was already issued or the lease ended."
    );
  return dataResponse({ token, expiresAt: row.expiresAt }, 201);
}
