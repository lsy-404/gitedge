import type { SigningPlatform } from "../../../packages/contracts/src/signing";
import { RUNNER_LEASE_MS } from "../../../packages/contracts/src/runners";
import {
  createSigningExecutionHooks,
  handleSigningMachineRoute,
  type SigningEnv,
  type SigningQueueInput,
} from "./signing";
import { sha256Hex } from "../../../packages/contracts/src/index";
import { parseJobClaim } from "../../../packages/contracts/runner-scheduling.mjs";
import { validateSingleSigningJob } from "./runner-workflow";

export interface SigningExecutionEnv
  extends
    Pick<SigningEnv, "DB" | "FORGE">,
    Partial<
      Pick<
        SigningEnv,
        "GIT" | "SIGNING_COORDINATORS" | "SIGNING_ARTIFACTS" | "SIGNING_ENCRYPTION_KEY"
      >
    > {}

function hasSigningBindings(env: SigningExecutionEnv): env is SigningEnv {
  return Boolean(
    env.GIT && env.SIGNING_COORDINATORS && env.SIGNING_ARTIFACTS && env.SIGNING_ENCRYPTION_KEY
  );
}

export async function handleSigningMachineCallback(
  request: Request,
  env: SigningExecutionEnv,
  runnerId: string
): Promise<Response> {
  const url = new URL(request.url);
  const match =
    /^\/runner\/signing\/requests\/([0-9a-f-]{36})\/(start|heartbeat|download|authorize-sign|output(?:\/parts\/\d+|\/complete)?|complete|fail)$/.exec(
      url.pathname
    );
  if (!match)
    return new Response(
      JSON.stringify({
        error: { code: "not_found", message: "Signing runner endpoint was not found." },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  const requestId = match[1]!;
  if (!hasSigningBindings(env))
    return new Response(
      JSON.stringify({
        error: { code: "internal_error", message: "Signing execution is unavailable." },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  const runId = request.headers.get("X-Runner-Run-Id") ?? "";
  const leaseToken = request.headers.get("X-Runner-Lease-Token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !/^[0-9a-f]{64}$/i.test(leaseToken))
    return new Response(
      JSON.stringify({
        error: { code: "bad_request", message: "Signing lease identity headers are required." },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  const leaseHash = await sha256Hex(leaseToken);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT a.id AS run_id,a.repository_id,a.created_by AS owner_id,
       j.status,j.conclusion,j.runner_id,j.lease_hash,j.lease_expires_at,j.started_at,j.timeout_minutes,j.cancel_requested,
       s.request_id,s.stage,s.input_digest,s.workflow_oid,s.profile_revision,s.platform,s.generation,s.nonce,
       r.repository_id AS runner_repository_id,r.created_by AS runner_owner_id,r.revoked_at AS runner_revoked_at,
       r.namespace_id AS runner_namespace_id,p.namespace_id AS repository_namespace_id,
       p.system_kind,p.visibility,p.archived,p.deleted_at,p.actions_enabled,p.actions_runner_enabled,
       n.kind AS namespace_kind,n.created_by AS namespace_owner,u.disabled_at
     FROM actions_runner_runs j JOIN actions_runs a ON a.id=j.run_id
       JOIN actions_signing_runs s ON s.run_id=j.run_id
       JOIN actions_runners r ON r.id=j.runner_id
       JOIN repositories p ON p.id=a.repository_id JOIN namespaces n ON n.id=p.namespace_id
       JOIN users u ON u.id=a.created_by
     WHERE a.id=? AND j.runner_id=? AND j.lease_hash=? AND s.request_id=?`
  )
    .bind(runId, runnerId, leaseHash, requestId)
    .first<{
      run_id: string;
      repository_id: string;
      owner_id: string;
      status: string;
      conclusion: string | null;
      runner_id: string;
      lease_hash: string;
      lease_expires_at: number | null;
      started_at: number | null;
      timeout_minutes: number;
      cancel_requested: number;
      request_id: string;
      stage: string;
      input_digest: string;
      workflow_oid: string;
      profile_revision: string;
      platform: SigningPlatform;
      generation: number;
      nonce: string;
      runner_revoked_at: number | null;
      runner_namespace_id: string;
      repository_namespace_id: string;
      runner_repository_id: string | null;
      runner_owner_id: string;
      system_kind: string | null;
      visibility: string;
      archived: number;
      deleted_at: number | null;
      actions_enabled: number;
      actions_runner_enabled: number;
      namespace_kind: string;
      namespace_owner: string;
      disabled_at: number | null;
    }>();
  const completedReplay =
    row?.status === "completed" &&
    ((match[2] === "complete" && row.conclusion === "success") ||
      (match[2] === "fail" && (row.conclusion === "failure" || row.conclusion === "cancelled")));
  if (
    !row ||
    row.run_id !== runId ||
    (row.status !== "running" && !completedReplay) ||
    row.runner_id !== runnerId ||
    row.lease_hash !== leaseHash ||
    row.lease_expires_at === null ||
    row.lease_expires_at <= now ||
    row.started_at === null ||
    row.started_at + row.timeout_minutes * 60_000 <= now ||
    row.cancel_requested !== 0 ||
    row.runner_revoked_at !== null ||
    row.runner_namespace_id !== row.repository_namespace_id ||
    row.runner_owner_id !== row.owner_id ||
    (row.runner_repository_id !== null && row.runner_repository_id !== row.repository_id) ||
    row.system_kind !== "account_runner" ||
    row.visibility !== "private" ||
    row.archived !== 0 ||
    row.deleted_at !== null ||
    row.actions_enabled !== 1 ||
    row.actions_runner_enabled !== 1 ||
    row.namespace_kind !== "personal" ||
    row.namespace_owner !== row.owner_id ||
    row.disabled_at !== null
  )
    return new Response(
      JSON.stringify({
        error: {
          code: "forbidden",
          message: "The active signing job lease is required.",
        },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );

  let leaseExpiresAt = row.lease_expires_at;
  if (match[2] === "heartbeat") {
    const refreshed = await env.DB.prepare(
      `UPDATE actions_runner_runs SET lease_expires_at=MIN(started_at+timeout_minutes*60000,?)
       WHERE run_id=? AND runner_id=? AND lease_hash=? AND status='running' AND cancel_requested=0
         AND lease_expires_at>? AND started_at+timeout_minutes*60000>?
       RETURNING lease_expires_at`
    )
      .bind(now + RUNNER_LEASE_MS, runId, runnerId, leaseHash, now, now)
      .first<{ lease_expires_at: number }>();
    if (!refreshed)
      return new Response(
        JSON.stringify({
          error: { code: "conflict", message: "Signing lease is no longer active." },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    leaseExpiresAt = refreshed.lease_expires_at;
  }
  const context = {
    ownerId: row.owner_id,
    runnerId,
    runId,
    requestId,
    leaseExpiresAt,
    repositoryId: row.repository_id,
    workflowOid: row.workflow_oid,
    profileRevision: row.profile_revision,
    stage: row.stage,
    platform: row.platform,
    generation: row.generation,
    nonce: row.nonce,
  };
  const hooks = createSigningExecutionHooks(env, {
    enqueue: (input) => enqueueNativeSigningRun(env, input),
  });
  return handleSigningMachineRoute(request, env, context, hooks);
}

export async function enqueueNativeSigningRun(
  env: SigningExecutionEnv,
  input: SigningQueueInput
): Promise<{ runId: string }> {
  if (
    !["sign", "finalize", "dmg_sign", "dmg_finalize", "windows_sign", "ios_sign"].includes(
      input.stage
    ) ||
    (input.platform !== "windows" && input.platform !== "macos" && input.platform !== "ios") ||
    !/^[0-9a-f]{40}$/.test(input.workflowOid) ||
    !/^[0-9a-f]{40}$/.test(input.profileRevision) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.inputDigest) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
    !Number.isInteger(input.timeoutMinutes) ||
    input.timeoutMinutes < 1 ||
    input.timeoutMinutes > 360
  )
    throw new Error("invalid_signing_queue_input");

  const workflow = validateSingleSigningJob(input.workflowPath, input.workflowSource);
  const labels = [
    "self-hosted",
    input.platform === "windows" ? "Windows" : "macOS",
    ...(input.platform === "ios" ? ["ARM64"] : []),
    "need-tool-node",
    "need-tool-python",
    ...workflow.labels.filter((label) => {
      const match = /^need-time-(\d+)m$/i.exec(label);
      if (!match) return true;
      const minutes = Number(match[1]);
      return !Number.isInteger(minutes) || minutes < 1 || minutes > 360;
    }),
    `need-time-${input.timeoutMinutes}m`,
  ];
  const requiredLabels = [...new Set(labels.map((label) => label.toLowerCase()))];
  if (!parseJobClaim(requiredLabels, input.timeoutMinutes).valid)
    throw new Error("invalid_signing_workflow_requirements");

  const now = Date.now();
  const repository = await env.DB.prepare(
    `SELECT r.id,r.namespace_id,r.slug,n.slug AS owner
     FROM repositories r JOIN namespaces n ON n.id=r.namespace_id
     WHERE r.id=? AND r.created_by=? AND r.system_kind='account_runner'
       AND r.visibility='private' AND r.archived=0 AND r.deleted_at IS NULL
       AND r.actions_enabled=1 AND r.actions_runner_enabled=1
       AND n.kind='personal' AND n.created_by=?`
  )
    .bind(input.repositoryId, input.ownerId, input.ownerId)
    .first<{ id: string; namespace_id: string; slug: string; owner: string }>();
  const initialStage = ["sign", "windows_sign", "ios_sign"].includes(input.stage);
  if (!repository) throw new Error("signing_runner_unavailable");
  const approvedProfile = await env.DB.prepare(
    `SELECT 1 AS active FROM actions_signing_profiles WHERE owner_id=? AND repository_id=?
     AND revision=? AND approved_by=? AND revoked_at IS NULL
     AND json_extract(profile_json,'$.workflowOid')=? AND json_extract(profile_json,'$.platform')=?`
  )
    .bind(
      input.ownerId,
      repository.id,
      input.profileRevision,
      input.ownerId,
      input.workflowOid,
      input.platform
    )
    .first<{ active: number }>();
  if (!approvedProfile) throw new Error("signing_profile_unavailable");
  if (!initialStage) {
    const admittedRequest = await env.DB.prepare(
      `SELECT 1 FROM actions_signing_runs WHERE request_id=? AND owner_id=? AND repository_id=?
       AND profile_revision=? AND workflow_oid=? AND platform=?
       AND stage IN ('sign','windows_sign','ios_sign') LIMIT 1`
    )
      .bind(
        input.requestId,
        input.ownerId,
        repository.id,
        input.profileRevision,
        input.workflowOid,
        input.platform
      )
      .first();
    if (!admittedRequest) throw new Error("signing_initial_stage_not_admitted");
  }

  const findExistingRun = async () => {
    const existing = await env.DB.prepare(
      `SELECT s.run_id,s.repository_id,s.profile_revision,s.workflow_oid,s.platform,s.stage,s.input_digest,
          s.generation,s.nonce,j.status
       FROM actions_signing_runs s JOIN actions_runner_runs j ON j.run_id=s.run_id
       WHERE s.request_id=? AND s.owner_id=? AND s.stage=? AND s.generation=?`
    )
      .bind(input.requestId, input.ownerId, input.stage, input.generation)
      .first<{
        run_id: string;
        repository_id: string;
        profile_revision: string;
        workflow_oid: string;
        platform: SigningPlatform;
        stage: string;
        input_digest: string;
        generation: number;
        nonce: string;
        status: string;
      }>();
    if (!existing) return null;
    if (
      existing.repository_id !== repository.id ||
      existing.profile_revision !== input.profileRevision ||
      existing.workflow_oid !== input.workflowOid ||
      existing.platform !== input.platform ||
      existing.stage !== input.stage ||
      existing.input_digest !== input.inputDigest ||
      existing.generation !== input.generation ||
      existing.nonce !== input.nonce ||
      existing.status === "completed"
    )
      throw new Error("signing_run_idempotency_conflict");
    return { runId: existing.run_id };
  };
  const existing = await findExistingRun();
  if (existing) return existing;

  const runId = crypto.randomUUID();

  const event = JSON.stringify({
    action: "native-signing",
    request_id: input.requestId,
    platform: input.platform,
    stage: input.stage,
    workflow_oid: input.workflowOid,
    profile_revision: input.profileRevision,
    input_digest: input.inputDigest,
  });
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO actions_runs
       (id,repository_id,commit_oid,workflow,path,source_ref,created_by,created_at,trigger_kind,executor)
       SELECT ?,?,?,?,?,?,?,?,?, 'runner'
       WHERE EXISTS (SELECT 1 FROM actions_signing_profiles WHERE owner_id=? AND repository_id=?
           AND revision=? AND approved_by=? AND revoked_at IS NULL
           AND json_extract(profile_json,'$.workflowOid')=? AND json_extract(profile_json,'$.platform')=?)`
      ).bind(
        runId,
        repository.id,
        input.workflowOid,
        "native-signing",
        input.workflowPath,
        "refs/heads/main",
        input.ownerId,
        now,
        "workflow_dispatch",
        input.ownerId,
        repository.id,
        input.profileRevision,
        input.ownerId,
        input.workflowOid,
        input.platform
      ),
      env.DB.prepare(
        `INSERT INTO actions_runner_runs(run_id,workflow_source,labels_json,permission,timeout_minutes,event_json)
       SELECT ?,?,?,'read',?,? WHERE EXISTS (SELECT 1 FROM actions_runs WHERE id=?)`
      ).bind(
        runId,
        input.workflowSource,
        JSON.stringify(requiredLabels),
        input.timeoutMinutes,
        event,
        runId
      ),
      env.DB.prepare(
        `INSERT INTO actions_signing_runs
       (run_id,request_id,owner_id,repository_id,profile_revision,workflow_oid,platform,stage,input_digest,
        generation,nonce,created_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM actions_runner_runs WHERE run_id=?)`
      ).bind(
        runId,
        input.requestId,
        input.ownerId,
        repository.id,
        input.profileRevision,
        input.workflowOid,
        input.platform,
        input.stage,
        input.inputDigest,
        input.generation,
        input.nonce,
        now,
        runId
      ),
    ]);
  } catch (error) {
    const raced = await findExistingRun();
    if (raced) return raced;
    throw error;
  }
  if (results.some((result) => result.meta.changes !== 1)) {
    await env.DB.prepare(
      "DELETE FROM actions_runs WHERE id=? AND NOT EXISTS (SELECT 1 FROM actions_signing_runs WHERE run_id=?)"
    )
      .bind(runId, runId)
      .run();
    throw new Error("signing_run_enqueue_failed");
  }
  return { runId };
}
