import {
  SigningPublishDispatchInputSchema,
  type SigningProfile,
  type SigningPublishDispatchInput,
  type SigningSubmission,
} from "../../../../packages/contracts/src/signing";
import { createLogger } from "../../../../src/worker/common/logger";
import type { SigningEnv } from "./types";

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 60_000;
const CLAIM_LEASE_MS = 120_000;
const DISPATCH_TIMEOUT_MS = 15_000;
const CRON_BATCH = 10;

type PublishEnv = Pick<SigningEnv, "DB" | "FORGE" | "LOG_LEVEL">;

/** Builds the Forge dispatch for the submission's source repository, or null when it declares no publish. */
export function resolvePublishDispatch(
  profile: SigningProfile,
  submission: SigningSubmission,
  ownerId: string,
  requestId: string
): SigningPublishDispatchInput | null {
  const repository = profile.policy.sourceRepositories.find(
    (item) => item.id === submission.sourceRepositoryId
  );
  if (!repository?.publish) return null;
  const values = {
    sourceRunId: submission.sourceRunId,
    sourceCommitOid: submission.sourceCommitOid,
    version: submission.version,
    requestId,
  };
  return SigningPublishDispatchInputSchema.parse({
    ownerId,
    githubRepositoryId: repository.id,
    fullName: repository.fullName,
    workflow: repository.publish.workflow,
    ref: repository.publish.ref,
    inputs: Object.fromEntries(
      Object.entries(repository.publish.inputs ?? {}).map(([name, template]) => [
        name,
        values[template],
      ])
    ),
  });
}

/** Records the outbox row once per request; a storage failure surfaces so the completion is retried. */
export async function recordPublishDispatch(
  env: PublishEnv,
  profile: SigningProfile,
  submission: SigningSubmission,
  ownerId: string,
  requestId: string
): Promise<boolean> {
  try {
    const dispatch = resolvePublishDispatch(profile, submission, ownerId, requestId);
    if (!dispatch) return false;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO actions_signing_publish_dispatches
       (request_id,owner_id,payload_json,state,attempts,next_attempt_at,created_at)
       VALUES (?,?,?,'pending',0,?,?)`
    )
      .bind(requestId, ownerId, JSON.stringify(dispatch), now, now)
      .run();
    return true;
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "signing-publish" }).error(
      "signing-publish:record-failed",
      { requestId, reason: cause instanceof Error ? cause.message : "unknown" }
    );
    throw new Error("signing_publish_record_failed");
  }
}

async function callForge(
  env: PublishEnv,
  payload: string
): Promise<{ ok: true } | { ok: false; code: string; retryable: boolean }> {
  let response: Response;
  try {
    response = await env.FORGE.fetch(
      new Request("https://forge.internal/internal/github-dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      })
    );
  } catch {
    return { ok: false, code: "forge_unreachable", retryable: true };
  }
  if (response.ok) {
    await response.body?.cancel();
    return { ok: true };
  }
  let code = `forge_http_${response.status}`;
  try {
    const body: unknown = await response.json();
    const error = typeof body === "object" && body !== null ? Reflect.get(body, "error") : null;
    const reported =
      typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    if (typeof reported === "string") code = reported.slice(0, 100);
  } catch {
    await response.body?.cancel();
  }
  return { ok: false, code, retryable: response.status >= 500 || response.status === 429 };
}

/** Claims the row for one attempt, calls Forge and records the outcome. */
export async function attemptPublishDispatch(env: PublishEnv, requestId: string): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "signing-publish" });
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE actions_signing_publish_dispatches SET attempts=attempts+1,next_attempt_at=?
     WHERE request_id=? AND state='pending' AND next_attempt_at<=? AND attempts<?
     RETURNING payload_json,attempts`
  )
    .bind(now + CLAIM_LEASE_MS, requestId, now, MAX_ATTEMPTS)
    .first<{ payload_json: string; attempts: number }>();
  if (!claimed) return;
  const result = await callForge(env, claimed.payload_json);
  if (result.ok) {
    await env.DB.prepare(
      "UPDATE actions_signing_publish_dispatches SET state='dispatched',dispatched_at=?,last_error=NULL WHERE request_id=?"
    )
      .bind(Date.now(), requestId)
      .run();
    logger.info("signing-publish:dispatched", { requestId, attempts: claimed.attempts });
    return;
  }
  const exhausted = !result.retryable || claimed.attempts >= MAX_ATTEMPTS;
  await env.DB.prepare(
    "UPDATE actions_signing_publish_dispatches SET state=?,next_attempt_at=?,last_error=? WHERE request_id=?"
  )
    .bind(
      exhausted ? "failed" : "pending",
      Date.now() + BASE_BACKOFF_MS * 2 ** (claimed.attempts - 1),
      result.code,
      requestId
    )
    .run();
  logger.warn(exhausted ? "signing-publish:dispatch-failed" : "signing-publish:dispatch-retry", {
    requestId,
    attempts: claimed.attempts,
    code: result.code,
  });
}

/** Retries due rows and closes rows whose attempts were consumed without an outcome. */
export async function retryPublishDispatches(env: PublishEnv): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE actions_signing_publish_dispatches SET state='failed',last_error=COALESCE(last_error,'dispatch_attempts_exhausted')
     WHERE state='pending' AND attempts>=? AND next_attempt_at<=?`
  )
    .bind(MAX_ATTEMPTS, now)
    .run();
  const due = await env.DB.prepare(
    `SELECT request_id FROM actions_signing_publish_dispatches
     WHERE state='pending' AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at LIMIT ?`
  )
    .bind(now, MAX_ATTEMPTS, CRON_BATCH)
    .all<{ request_id: string }>();
  for (const row of due.results) await attemptPublishDispatch(env, row.request_id);
}
