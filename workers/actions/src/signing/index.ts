import {
  SigningMachineContextSchema,
  SigningPlatformSchema,
  SigningCredentialPlatformSchema,
  SigningProfileMetadataSchema,
  SigningProfileSchema,
  SigningReconcileDispatchSchema,
  SigningRequestSchema,
  SigningStageSchema,
  SigningSubmissionSchema,
} from "../../../../packages/contracts/src/signing";
import { z } from "zod";
import type { TrustedUser } from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../../src/worker/common/http";
import { createLogger } from "../../../../src/worker/common/logger";
import { SigningCoordinator, coordinator } from "./coordinator";
import type { SigningEnv, SigningExecutionHooks } from "./types";
import {
  installSigningCredentials,
  listApprovedProfiles,
  removeSigningCredentials,
  saveApprovedProfile,
  signingCredentialStatus,
} from "./services";
import {
  accessTokenAllows,
  accessTokenAllowsRepository,
} from "../../../../packages/contracts/src/access-tokens";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import { manifestSchema } from "../../../../packages/contracts/signing-native.mjs";
export {
  createSigningExecutionHooks,
  installSigningCredentials,
  listApprovedProfiles,
  removeSigningCredentials,
  saveApprovedProfile,
} from "./services";

export { SigningCoordinator };
export type { SigningEnv, SigningExecutionHooks, SigningQueueInput } from "./types";

const createdResponseSchema = z
  .object({
    request: SigningRequestSchema,
    created: z.boolean(),
    dispatch: z
      .object({
        profile: SigningProfileSchema,
        submission: SigningSubmissionSchema,
        generation: z.number().int().positive(),
        nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        operatorApproval: z
          .object({
            operatorApproved: z.literal(true),
            approvedBy: z.string().min(1),
            approvedAt: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const boundResponseSchema = z.object({ bound: z.boolean() }).strict();

export async function reconcileSigningRequests(
  env: SigningEnv,
  hooks: SigningExecutionHooks
): Promise<{ queued: number; skipped: number; failed: number }> {
  const candidates = await env.DB.prepare(
    `SELECT s.request_id AS requestId,s.owner_id AS ownerId,s.repository_id AS repositoryId,s.run_id AS runId,
    s.profile_revision AS profileRevision,s.platform,s.last_reconciled_at AS lastReconciledAt,
    r.status,r.conclusion,r.lease_expires_at AS leaseExpiresAt
    FROM actions_signing_runs s JOIN actions_runner_runs r ON r.run_id=s.run_id
    JOIN actions_signing_profiles p ON p.owner_id=s.owner_id AND p.repository_id=s.repository_id AND p.revision=s.profile_revision
    WHERE s.reconcile_state='pending' AND p.revoked_at IS NULL AND (
        (r.status='completed' AND COALESCE(r.conclusion,'')!='success')
        OR (r.status IN ('queued','running') AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at<=${Date.now()})
        OR (s.platform='macos' AND (
          (s.stage='sign' AND r.status='completed' AND r.conclusion='success')
          OR (s.stage='finalize' AND (r.status IN ('queued','running') OR (r.status='completed' AND r.conclusion='success' AND json_extract(p.profile_json,'$.policy.project.macos.output_format')='dmg')))
          OR (s.stage='dmg_sign' AND (r.status IN ('queued','running') OR (r.status='completed' AND r.conclusion='success')))
          OR (s.stage='dmg_finalize' AND r.status IN ('queued','running'))
        ))
      )
      AND NOT EXISTS (SELECT 1 FROM actions_signing_runs newer WHERE newer.request_id=s.request_id AND newer.owner_id=s.owner_id
        AND (newer.generation>s.generation OR (newer.generation=s.generation AND newer.created_at>s.created_at)))
  ORDER BY COALESCE(s.last_reconciled_at,0),s.created_at DESC LIMIT 20`
  ).all<{
    requestId: string;
    ownerId: string;
    repositoryId: string;
    runId: string;
    profileRevision: string;
    platform: string;
    lastReconciledAt: number | null;
    status: string;
    conclusion: string | null;
    leaseExpiresAt: number | null;
  }>();
  const seen = new Set<string>();
  let queued = 0,
    skipped = 0,
    failed = 0;
  for (const candidate of candidates.results ?? []) {
    const key = `${candidate.ownerId}:${candidate.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const touched = await env.DB.prepare(
        `UPDATE actions_signing_runs SET last_reconciled_at=?
        WHERE request_id=? AND owner_id=? AND last_reconciled_at IS ? AND reconcile_state='pending'`
      )
        .bind(
          Date.now(),
          candidate.requestId,
          candidate.ownerId,
          candidate.lastReconciledAt ?? null
        )
        .run();
      if (touched.meta.changes === 0) {
        skipped++;
        continue;
      }
      const stub = coordinator(env, candidate.ownerId);
      const leaseExpired =
        candidate.status !== "completed" &&
        candidate.leaseExpiresAt !== null &&
        candidate.leaseExpiresAt <= Date.now();
      if (
        (candidate.status === "completed" && candidate.conclusion !== "success") ||
        leaseExpired
      ) {
        const failureResponse = await stub.fetch(
          new Request(
            `https://signing.internal/fail-run/${encodeURIComponent(candidate.requestId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ownerId: candidate.ownerId,
                repositoryId: candidate.repositoryId,
                runId: candidate.runId,
                conclusion: leaseExpired ? "lease_expired" : (candidate.conclusion ?? "failed"),
              }),
            }
          )
        );
        const failure = z.object({ failed: z.boolean() }).parse(await failureResponse.json());
        if (!failureResponse.ok || !failure.failed)
          throw new Error("signing_run_failure_state_failed");
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,log='Signing runner lease expired' WHERE run_id=? AND status IN ('queued','running')"
          ).bind(Date.now(), candidate.runId),
          env.DB.prepare(
            "UPDATE actions_signing_runs SET reconcile_state='failed' WHERE request_id=? AND owner_id=? AND run_id=?"
          ).bind(candidate.requestId, candidate.ownerId, candidate.runId),
        ]);
        failed++;
        continue;
      }
      const profileRow = await env.DB.prepare(
        `SELECT 1 AS active FROM actions_signing_profiles
        WHERE owner_id=? AND repository_id=? AND revision=? AND revoked_at IS NULL`
      )
        .bind(candidate.ownerId, candidate.repositoryId, candidate.profileRevision)
        .first<{ active: number }>();
      const platform = SigningPlatformSchema.parse(candidate.platform);
      const approval = await hooks.verifySigningHost(
        candidate.ownerId,
        candidate.repositoryId,
        platform
      );
      if (!profileRow || !approval?.operatorApproved || approval.approvedBy !== candidate.ownerId) {
        skipped++;
        continue;
      }
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const preparedResponse = await stub.fetch(
        new Request(
          `https://signing.internal/prepare-next-stage/${encodeURIComponent(candidate.requestId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ownerId: candidate.ownerId,
              repositoryId: candidate.repositoryId,
              nonce,
            }),
          }
        )
      );
      const preparedBody = z
        .object({
          data: z
            .object({
              request: SigningRequestSchema,
              dispatch: SigningReconcileDispatchSchema.nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict()
        .parse(await readJsonLimited(preparedResponse, 131_072));
      if (!preparedResponse.ok) throw new Error("signing_stage_prepare_failed");
      if (preparedBody.data?.request.state === "failed") {
        const uploadResponse = await stub.fetch(
          new Request(
            `https://signing.internal/expired-upload/${encodeURIComponent(candidate.requestId)}`,
            {
              headers: {
                "X-Signing-Owner": candidate.ownerId,
                "X-Signing-Repository": candidate.repositoryId,
              },
            }
          )
        );
        const uploadBody = z
          .object({ upload: z.object({ key: z.string(), uploadId: z.string() }).nullable() })
          .strict()
          .parse(await readJsonLimited(uploadResponse, 4096));
        if (uploadBody.upload) {
          try {
            await env.SIGNING_ARTIFACTS.resumeMultipartUpload(
              uploadBody.upload.key,
              uploadBody.upload.uploadId
            ).abort();
          } catch (error) {
            console.warn(
              JSON.stringify({
                event: "signing_expired_multipart_abort_failed",
                requestId: candidate.requestId,
                errorType: error instanceof Error ? error.name : "unknown",
              })
            );
          }
        }
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,log='Signing request expired' WHERE run_id=? AND status IN ('queued','running')"
          ).bind(Date.now(), candidate.runId),
          env.DB.prepare(
            "UPDATE actions_signing_runs SET reconcile_state='failed' WHERE request_id=? AND owner_id=? AND run_id=?"
          ).bind(candidate.requestId, candidate.ownerId, candidate.runId),
        ]);
        failed++;
        continue;
      }
      const dispatch = preparedBody.data?.dispatch;
      if (!dispatch) {
        skipped++;
        continue;
      }
      if (
        !(await hooks.verifySourceCurrent(
          candidate.ownerId,
          candidate.repositoryId,
          dispatch.profile,
          dispatch.submission
        ))
      ) {
        const failedResponse = await stub.fetch(
          new Request(
            `https://signing.internal/fail-source/${encodeURIComponent(candidate.requestId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ownerId: candidate.ownerId,
                repositoryId: candidate.repositoryId,
              }),
            }
          )
        );
        const failureResult = z.object({ failed: z.boolean() }).parse(await failedResponse.json());
        if (!failedResponse.ok || !failureResult.failed)
          throw new Error("signing_source_failure_state_failed");
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE actions_runner_runs SET status='completed',conclusion='failure',completed_at=?,log='Signing source changed' WHERE run_id=? AND status IN ('queued','running')"
          ).bind(Date.now(), candidate.runId),
          env.DB.prepare(
            "UPDATE actions_signing_runs SET reconcile_state='failed' WHERE request_id=? AND owner_id=? AND run_id=?"
          ).bind(candidate.requestId, candidate.ownerId, candidate.runId),
        ]);
        failed++;
        continue;
      }
      if (dispatch.operatorApproval.approvedAt !== approval.approvedAt) {
        skipped++;
        continue;
      }
      if (dispatch.stage === "finalize" || dispatch.stage === "dmg_finalize") {
        const status = await hooks.verifyNotarization(
          candidate.ownerId,
          candidate.repositoryId,
          dispatch.profile,
          dispatch.previousVerification
        );
        if (status !== "Accepted") {
          if (status === "Invalid" || status === "Rejected") {
            const failedResponse = await stub.fetch(
              new Request(
                `https://signing.internal/fail-notarization/${encodeURIComponent(candidate.requestId)}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ownerId: candidate.ownerId,
                    repositoryId: candidate.repositoryId,
                  }),
                }
              )
            );
            const failedBody = z.object({ failed: z.boolean() }).parse(await failedResponse.json());
            if (!failedResponse.ok || !failedBody.failed)
              throw new Error("signing_notary_rejection_state_failed");
            await env.DB.prepare(
              `UPDATE actions_signing_runs SET reconcile_state='failed' WHERE request_id=? AND owner_id=? AND run_id=(
              SELECT run_id FROM actions_signing_runs WHERE request_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 1)`
            )
              .bind(candidate.requestId, candidate.ownerId, candidate.requestId, candidate.ownerId)
              .run();
          }
          skipped++;
          continue;
        }
      }
      const run = await hooks.enqueue({
        requestId: candidate.requestId,
        ownerId: candidate.ownerId,
        repositoryId: candidate.repositoryId,
        workflowOid: dispatch.profile.workflowOid,
        workflowPath: dispatch.profile.workflowPath,
        workflowSource: dispatch.profile.workflowSource,
        stage: dispatch.stage,
        inputDigest: dispatch.inputDigest,
        platform: dispatch.profile.platform,
        generation: dispatch.generation,
        nonce: dispatch.nonce,
        timeoutMinutes: dispatch.profile.timeoutMinutes,
        sourceDigest: dispatch.submission.sourceDigest,
        profileRevision: dispatch.profile.revision,
        operatorApproval: dispatch.operatorApproval,
      });
      const boundResponse = await stub.fetch(
        new Request(
          `https://signing.internal/bind-run/${encodeURIComponent(candidate.requestId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...candidate, runId: run.runId }),
          }
        )
      );
      const bound = z.object({ bound: z.boolean() }).parse(await boundResponse.json());
      if (!bound.bound) throw new Error("signing_stage_bind_failed");
      queued++;
    } catch (error) {
      failed++;
      console.warn(
        JSON.stringify({
          event: "signing_reconcile_failed",
          requestId: candidate.requestId,
          errorType: error instanceof Error ? error.name : "unknown",
        })
      );
    }
  }
  return { queued, skipped, failed };
}

async function ownedRunnerRepository(env: SigningEnv, userId: string, repositoryId?: string) {
  const sql = `SELECT r.id,r.namespace_id,r.created_by,r.visibility,r.archived,r.deleted_at,
      r.actions_enabled,r.actions_runner_enabled,n.kind,n.created_by AS namespace_owner
    FROM repositories r JOIN namespaces n ON n.id=r.namespace_id
    WHERE r.system_kind='account_runner' AND n.kind='personal' AND n.created_by=? AND r.created_by=n.created_by
      AND r.visibility='private' AND r.archived=0 AND r.deleted_at IS NULL AND r.actions_enabled=1 AND r.actions_runner_enabled=1
      ${repositoryId ? "AND r.id=?" : ""} LIMIT 1`;
  return repositoryId
    ? env.DB.prepare(sql).bind(userId, repositoryId).first<{ id: string; namespace_id: string }>()
    : env.DB.prepare(sql).bind(userId).first<{ id: string; namespace_id: string }>();
}

async function bodyResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) throw new Error("signing_state_unavailable");
  return schema.parse(await readJsonLimited(response, 131_072));
}

function signingObjectKey(
  ownerId: string,
  repositoryId: string,
  requestId: string,
  object: string
) {
  return `signing/${ownerId}/${repositoryId}/${requestId}/${object}.zip`;
}

function recentHuman(user: TrustedUser): boolean {
  return (
    !user.job &&
    !user.agentSession &&
    !user.token &&
    Number.isSafeInteger(user.recentAuthAt) &&
    user.recentAuthAt! <= Date.now() &&
    Date.now() - user.recentAuthAt! <= 10 * 60_000
  );
}

function runnerAccess(user: TrustedUser, repositoryId: string, write: boolean): boolean {
  if (user.agentSession) return false;
  if (!user.token) return !user.job;
  if (user.job && user.job.repositoryId !== repositoryId) return false;
  const needed = write ? "repo:write" : "repo:read";
  return (
    accessTokenAllows(user.token, needed) && accessTokenAllowsRepository(user.token, repositoryId)
  );
}

async function verifiedObject(
  env: SigningEnv,
  key: string,
  digest: string,
  size: number
): Promise<boolean> {
  const object = await env.SIGNING_ARTIFACTS.get(key);
  if (!object || object.size !== size) {
    await object?.body.cancel();
    return false;
  }
  const sink = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(sink);
  const actual = Array.from(new Uint8Array(await sink.digest), (value) =>
    value.toString(16).padStart(2, "0")
  ).join("");
  return `sha256:${actual}` === digest;
}

export async function handleSigningRoute(
  request: Request,
  env: SigningEnv,
  user: TrustedUser | null,
  executionHooks: SigningExecutionHooks
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.split("/").filter(Boolean);
  if (path[0] !== "signing")
    return errorResponse(404, "not_found", "Signing endpoint was not found.");
  if (!user || user.agentSession)
    return errorResponse(403, "forbidden", "An account owner session is required.");
  try {
    if (path[1] === "profiles") {
      const repositoryId = url.searchParams.get("repositoryId") ?? "";
      if (request.method === "POST" && path.length === 2 && !recentHuman(user))
        return errorResponse(403, "forbidden", "Recent owner authentication is required.");
      const repository = repositoryId
        ? await ownedRunnerRepository(env, user.id, repositoryId)
        : null;
      if (!repository || !runnerAccess(user, repository.id, false))
        return errorResponse(404, "not_found", "Signing profile was not found.");
      if (request.method === "GET" && path.length === 2)
        return dataResponse({ profiles: await listApprovedProfiles(env, user.id, repository.id) });
      if (request.method === "POST" && path.length === 2) {
        const body = z
          .object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) })
          .strict()
          .parse(await readJsonLimited(request, 4096));
        const profile = await saveApprovedProfile(env, user, repository.id, body.name);
        return dataResponse(
          SigningProfileMetadataSchema.parse({
            name: profile.name,
            revision: profile.revision,
            platform: profile.platform,
            workflowOid: profile.workflowOid,
            workflowPath: profile.workflowPath,
            enabled: profile.enabled,
            approvedAt: profile.approvedAt,
          }),
          201
        );
      }
      if (
        path.length === 4 &&
        path[3] === "credentials" &&
        (request.method === "GET" || request.method === "POST" || request.method === "DELETE")
      ) {
        const profileName = path[2]!;
        if (request.method === "GET") {
          const platformParam = url.searchParams.get("platform");
          const platform = platformParam
            ? SigningCredentialPlatformSchema.parse(platformParam)
            : undefined;
          const status = await signingCredentialStatus(
            env,
            user.id,
            repository.id,
            profileName,
            platform
          );
          return status
            ? dataResponse(status)
            : errorResponse(404, "not_found", "Signing profile was not found.");
        }
        if (!recentHuman(user))
          return errorResponse(403, "forbidden", "Recent owner authentication is required.");
        let platform;
        if (request.method === "POST") {
          const body = z
            .object({ platform: SigningCredentialPlatformSchema, credentials: z.unknown() })
            .strict()
            .parse(await readJsonLimited(request, 1_048_576));
          platform = body.platform;
          await installSigningCredentials(
            env,
            user.id,
            repository.id,
            profileName,
            body.platform,
            body.credentials
          );
        } else {
          const body = z
            .object({ platform: SigningCredentialPlatformSchema })
            .strict()
            .parse(await readJsonLimited(request, 4096));
          platform = body.platform;
          await removeSigningCredentials(env, user.id, repository.id, profileName, body.platform);
        }
        const status = await signingCredentialStatus(
          env,
          user.id,
          repository.id,
          profileName,
          platform
        );
        return status
          ? dataResponse(status)
          : errorResponse(404, "not_found", "Signing profile was not found.");
      }
      return errorResponse(
        405,
        "method_not_allowed",
        "Signing profile operation is not supported."
      );
    }
    if (path[1] !== "requests")
      return errorResponse(404, "not_found", "Signing endpoint was not found.");
    if (request.method === "POST" && path.length === 2) {
      const repositoryId = url.searchParams.get("repositoryId") ?? user.job?.repositoryId;
      if ((user.job || user.token) && !repositoryId)
        return errorResponse(400, "bad_request", "repositoryId is required.");
      const repository = await ownedRunnerRepository(env, user.id, repositoryId);
      if (!repository || !runnerAccess(user, repository.id, true))
        return errorResponse(
          503,
          "signing_runner_unavailable",
          "The private account Runner is unavailable."
        );
      const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
      if (!/^[A-Za-z0-9_.-]{16,128}$/.test(idempotencyKey))
        return errorResponse(400, "bad_request", "A valid idempotency key is required.");
      const submission = SigningSubmissionSchema.parse(await readJsonLimited(request, 16_384));
      const profile = await executionHooks.loadApprovedProfile(
        user,
        repository.id,
        submission.profile
      );
      if (!profile || !profile.enabled || profile.platform !== submission.platform)
        return errorResponse(
          503,
          "signing_profile_unavailable",
          "No approved signing profile is available."
        );
      if (submission.sourceSize > profile.policy.project.max_artifact_bytes)
        return errorResponse(
          413,
          "signing_source_too_large",
          "The source artifact exceeds the approved profile limit."
        );
      const operatorApproval = await executionHooks.verifySigningHost(
        user.id,
        repository.id,
        profile.platform
      );
      if (
        !operatorApproval?.operatorApproved ||
        operatorApproval.approvedBy !== user.id ||
        !Number.isSafeInteger(operatorApproval.approvedAt)
      )
        return errorResponse(
          503,
          "signing_host_unverified",
          "No owner-approved dedicated signing host is available."
        );
      const source = await executionHooks.verifySource(
        user,
        repository.id,
        profile,
        submission,
        request.headers.get("X-Run-Identity"),
        new URL(request.url).origin
      );
      if (!source)
        return errorResponse(
          422,
          "signing_source_not_allowed",
          "The source run is not authorized by the approved profile."
        );
      const generation = 1;
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
      const stub = coordinator(env, user.id);
      const created = await bodyResponse(
        await stub.fetch(
          new Request("https://signing.internal/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requestId: crypto.randomUUID(),
              ownerId: user.id,
              repositoryId: repository.id,
              idempotencyKey,
              profile,
              submission,
              generation,
              nonce,
              operatorApproval,
            }),
          })
        ),
        createdResponseSchema
      );
      if (!created.created && created.request.state !== "accepted") {
        await source.body.cancel();
        return dataResponse({ request: created.request }, 200);
      }
      const accepted = created.dispatch;
      if (
        created.request.profileRevision !== profile.revision ||
        accepted.profile.revision !== profile.revision
      )
        return errorResponse(
          409,
          "conflict",
          "The approved profile changed after this request was accepted."
        );
      const sourceKey = signingObjectKey(user.id, repository.id, created.request.id, "source");
      try {
        const existing = await env.SIGNING_ARTIFACTS.head(sourceKey);
        if (!existing) {
          const { readable, writable } = new FixedLengthStream(submission.sourceSize);
          const storage = env.SIGNING_ARTIFACTS.put(sourceKey, readable, {
            customMetadata: {
              ownerId: user.id,
              repositoryId: repository.id,
              requestId: created.request.id,
              sha256: submission.sourceDigest,
              size: String(submission.sourceSize),
            },
          });
          await Promise.all([storage, source.body.pipeTo(writable)]);
        } else await source.body.cancel();
        if (
          !(await verifiedObject(env, sourceKey, submission.sourceDigest, submission.sourceSize))
        ) {
          await env.SIGNING_ARTIFACTS.delete(sourceKey);
          return errorResponse(
            422,
            "signing_source_digest_mismatch",
            "The source artifact did not match its validated digest and size."
          );
        }
      } catch {
        return errorResponse(
          503,
          "signing_source_storage_unavailable",
          "The source artifact could not be stored and verified."
        );
      }
      const queued = await executionHooks.enqueue({
        requestId: created.request.id,
        ownerId: user.id,
        repositoryId: repository.id,
        workflowOid: accepted.profile.workflowOid,
        workflowPath: accepted.profile.workflowPath,
        workflowSource: accepted.profile.workflowSource,
        stage: SigningStageSchema.parse(accepted.profile.policy.stage),
        inputDigest: accepted.submission.sourceDigest,
        platform: accepted.profile.platform,
        generation: accepted.generation,
        nonce: accepted.nonce,
        timeoutMinutes: accepted.profile.timeoutMinutes,
        sourceDigest: accepted.submission.sourceDigest,
        profileRevision: accepted.profile.revision,
        operatorApproval: accepted.operatorApproval,
      });
      const bound = await bodyResponse(
        await stub.fetch(
          new Request(`https://signing.internal/bind-run/${created.request.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ownerId: user.id,
              repositoryId: repository.id,
              runId: queued.runId,
            }),
          })
        ),
        boundResponseSchema
      );
      if (!bound.bound) return errorResponse(404, "not_found", "Signing request was not found.");
      return dataResponse(
        { request: { ...created.request, runId: queued.runId, state: "queued" } },
        created.created ? 202 : 200
      );
    }
    if (request.method === "GET" && path.length === 3) {
      const repoParam = url.searchParams.get("repositoryId");
      if (!repoParam) return errorResponse(400, "bad_request", "repositoryId is required.");
      const repository = await ownedRunnerRepository(env, user.id, repoParam);
      if (!repository || !runnerAccess(user, repository.id, false))
        return errorResponse(404, "not_found", "Signing request was not found.");
      const response = await coordinator(env, user.id).fetch(
        new Request(`https://signing.internal/requests/${encodeURIComponent(path[2]!)}`, {
          headers: { "X-Signing-Owner": user.id, "X-Signing-Repository": repository.id },
        })
      );
      const value = z
        .object({ request: SigningRequestSchema.optional() })
        .parse(await readJsonLimited(response, 16_384));
      return response.ok && value.request
        ? dataResponse(value.request)
        : errorResponse(404, "not_found", "Signing request was not found.");
    }
    if (request.method === "GET" && path.length === 4 && path[3] === "download") {
      const repoParam = url.searchParams.get("repositoryId");
      if (!repoParam) return errorResponse(400, "bad_request", "repositoryId is required.");
      const repository = await ownedRunnerRepository(env, user.id, repoParam);
      if (!repository || !runnerAccess(user, repository.id, false))
        return errorResponse(404, "not_found", "Signing request was not found.");
      const response = await coordinator(env, user.id).fetch(
        new Request(`https://signing.internal/requests/${encodeURIComponent(path[2]!)}`, {
          headers: { "X-Signing-Owner": user.id, "X-Signing-Repository": repository.id },
        })
      );
      const value = z
        .object({ request: SigningRequestSchema.optional() })
        .parse(await readJsonLimited(response, 16_384));
      const state = value.request;
      if (
        !response.ok ||
        !state ||
        state.state !== "succeeded" ||
        !state.outputDigest ||
        !state.outputSize
      )
        return errorResponse(404, "not_found", "Signing output was not found.");
      const key = signingObjectKey(user.id, repository.id, state.id, state.stage);
      const object = await env.SIGNING_ARTIFACTS.get(key);
      if (!object || object.size !== state.outputSize)
        return errorResponse(410, "gone", "Signing output is no longer available.");
      return new Response(object.body, { headers: objectHeaders(state.outputDigest, object.size) });
    }
    return errorResponse(405, "method_not_allowed", "Signing operation is not supported.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "signing_idempotency_conflict")
      return errorResponse(
        409,
        "conflict",
        "The idempotency key is already bound to another request."
      );
    if (message === "signing_profile_not_approved")
      return errorResponse(
        503,
        "signing_profile_unavailable",
        "No approved signing profile is available."
      );
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return errorResponse(400, "bad_request", "Invalid signing request.");
    return errorResponse(503, "signing_unavailable", "Signing service is unavailable.");
  }
}

async function machineRpc<T>(
  env: SigningEnv,
  ownerId: string,
  id: string,
  operation: string,
  context: unknown,
  schema: z.ZodType<T>,
  payload?: unknown
): Promise<T> {
  const response = await coordinator(env, ownerId).fetch(
    new Request(`https://signing.internal/machine/${encodeURIComponent(id)}/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context, payload }),
    })
  );
  const envelope = z
    .object({ data: z.unknown().optional(), error: z.string().optional() })
    .parse(await readJsonLimited(response, 131_072));
  if (!response.ok || envelope.data === undefined)
    throw new Error(envelope.error ?? "signing_state_unavailable");
  return schema.parse(envelope.data);
}

const profileRpcSchema = z.object({
  profile: SigningProfileSchema,
  submission: SigningSubmissionSchema,
});
const profileContextRpcSchema = profileRpcSchema.extend({
  sourceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceCommitOid: z.string().regex(/^[a-f0-9]{40}$/),
  version: z.string(),
});
const objectTargetSchema = z.object({
  key: z.string().min(1),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().positive(),
});
const outputUploadBindingSchema = z.object({ key: z.string(), uploadId: z.string() });

const outputPartTargetSchema = z.object({
  key: z.string().min(1),
  uploadId: z.string().min(1),
  expected: z.number().int().positive(),
  total: z.number().int().positive(),
});

async function authorizeMachine(
  raw: unknown,
  id: string,
  env: SigningEnv,
  hooks: SigningExecutionHooks
) {
  const parsed = SigningMachineContextSchema.safeParse(raw);
  if (!parsed.success || parsed.data.requestId !== id || parsed.data.leaseExpiresAt <= Date.now())
    return null;
  try {
    await machineRpc(env, parsed.data.ownerId, id, "profile", parsed.data, profileRpcSchema);
  } catch {
    return null;
  }
  const current = await hooks.verifySigningHost(
    parsed.data.ownerId,
    parsed.data.repositoryId,
    parsed.data.platform
  );
  if (
    !current?.operatorApproved ||
    current.approvedBy !== parsed.data.ownerId ||
    current.approvedBy !== parsed.data.operatorApproval.approvedBy ||
    current.approvedAt !== parsed.data.operatorApproval.approvedAt
  )
    return null;
  return parsed.data;
}

function objectHeaders(digest: string, size: number, start = 0): Headers {
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Length": String(size - start),
    "Accept-Ranges": "bytes",
    "X-Signing-Digest": digest,
    "Cache-Control": "no-store",
  });
  if (start) headers.set("Content-Range", `bytes ${start}-${size - 1}/${size}`);
  return headers;
}

function parseRange(header: string | null, size: number): number {
  if (!header) return 0;
  const match = /^bytes=(\d{1,15})-$/.exec(header);
  if (!match || Number(match[1]) >= size) throw new Error("invalid_range");
  return Number(match[1]);
}

export async function handleSigningMachineRoute(
  request: Request,
  env: SigningEnv,
  trustedContext: unknown,
  hooks: SigningExecutionHooks
): Promise<Response> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "runner" ||
    parts[1] !== "signing" ||
    parts[2] !== "requests" ||
    !parts[3] ||
    !parts[4]
  )
    return errorResponse(404, "not_found", "Signing runner endpoint was not found.");
  const id = parts[3];
  const operation = parts[4];
  const logger = createLogger(env.LOG_LEVEL, {
    service: "actions-signing",
    requestId: id,
  });
  const context = await authorizeMachine(trustedContext, id, env, hooks);
  if (!context)
    return errorResponse(403, "forbidden", "The active owner-approved signing lease is required.");
  try {
    if (operation === "start" && request.method === "POST") {
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "start",
          context,
          z.object({ state: z.literal("running"), manifest: manifestSchema }).strict()
        )
      );
    }
    if (operation === "heartbeat" && request.method === "POST") {
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "heartbeat",
          context,
          z.object({ leaseExpiresAt: z.number().int().positive() })
        )
      );
    }
    if (operation === "download" && request.method === "GET") {
      const objectName = new URL(request.url).searchParams.get("object") ?? "input";
      if (objectName !== "input" && objectName !== "template")
        return errorResponse(400, "bad_request", "Requested signing input object is invalid.");
      const target = await machineRpc(
        env,
        context.ownerId,
        id,
        "download",
        context,
        objectTargetSchema,
        { object: objectName }
      );
      const start = parseRange(request.headers.get("Range"), target.size);
      const object = await env.SIGNING_ARTIFACTS.get(
        target.key,
        start ? { range: { offset: start } } : undefined
      );
      if (!object || object.size !== target.size)
        return errorResponse(
          409,
          "signing_object_unavailable",
          "The validated source archive is unavailable."
        );
      return new Response(object.body, {
        status: start ? 206 : 200,
        headers: objectHeaders(target.digest, target.size, start),
      });
    }
    if (operation === "authorize-sign" && request.method === "POST") {
      const { profile, submission } = await machineRpc(
        env,
        context.ownerId,
        id,
        "profile",
        context,
        profileRpcSchema
      );
      if (
        !(await hooks.verifySourceCurrent(
          context.ownerId,
          context.repositoryId,
          profile,
          submission
        ))
      )
        return errorResponse(
          409,
          "signing_source_changed",
          "The approved source run or release tag is no longer valid."
        );
      await machineRpc(
        env,
        context.ownerId,
        id,
        "authorize-sign",
        context,
        z.object({ authorized: z.literal(true) })
      );
      const grant = await hooks.authorizeCredentials(context, profile);
      if (
        !grant ||
        grant.expiresAt <= Date.now() ||
        grant.expiresAt > context.leaseExpiresAt ||
        grant.expiresAt > Date.now() + 10 * 60_000
      )
        return errorResponse(
          503,
          "signing_credentials_unavailable",
          "A request-scoped signing credential grant is unavailable."
        );
      return dataResponse({ credentials: grant.credentials, expiresAt: grant.expiresAt });
    }
    if (operation === "output" && parts.length === 5 && request.method === "POST") {
      if (request.headers.get("Content-Type") !== "application/json")
        return errorResponse(400, "bad_request", "Output metadata must be JSON.");
      const body = z
        .object({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          size: z.number().int().positive().max(2_000_000_000),
        })
        .strict()
        .parse(await readJsonLimited(request, 4096));
      const { digest, size } = body;
      const transfer = await machineRpc(
        env,
        context.ownerId,
        id,
        "output-begin",
        context,
        z.object({
          key: z.string(),
          uploadId: z.string(),
          partSize: z.number().int().positive(),
          partCount: z.number().int().positive(),
          receivedParts: z.array(z.number().int().positive()),
          verified: z.boolean(),
        }),
        { digest, size }
      );
      if (transfer.uploadId === "pending" && !transfer.verified) {
        const upload = await env.SIGNING_ARTIFACTS.createMultipartUpload(transfer.key, {
          customMetadata: {
            ownerId: context.ownerId,
            repositoryId: context.repositoryId,
            requestId: id,
            sha256: digest,
            size: String(size),
          },
        });
        let bound: z.infer<typeof outputUploadBindingSchema>;
        try {
          bound = await machineRpc(
            env,
            context.ownerId,
            id,
            "output-bind",
            context,
            outputUploadBindingSchema,
            { uploadId: upload.uploadId }
          );
        } catch (error) {
          await upload.abort();
          throw error;
        }
        if (bound.uploadId !== upload.uploadId) await upload.abort();
        return dataResponse({ ...transfer, key: bound.key, uploadId: bound.uploadId });
      }
      return dataResponse(transfer);
    }
    if (operation === "output" && parts[5] === "parts" && parts[6] && request.method === "PUT") {
      if (request.headers.get("Content-Type") !== "application/octet-stream")
        return errorResponse(400, "bad_request", "Output must be an octet stream.");
      const sizeHeader = request.headers.get("Content-Length") ?? "";
      if (!/^\d{1,10}$/.test(sizeHeader) || !request.body)
        return errorResponse(411, "length_required", "Output content length is required.");
      const size = Number(sizeHeader);
      const part = Number(parts[6]);
      const target = await machineRpc(
        env,
        context.ownerId,
        id,
        "output-part",
        context,
        outputPartTargetSchema,
        { part, length: size }
      );
      const start = (part - 1) * 8 * 1024 * 1024;
      const end = start + target.expected - 1;
      if (
        request.headers.get("Content-Range") !== `bytes ${start}-${end}/${target.total}` ||
        !/^sha256:[a-f0-9]{64}$/.test(request.headers.get("X-Part-Digest") ?? "")
      )
        return errorResponse(400, "bad_request", "Output part range and digest are required.");
      const { readable, writable } = new FixedLengthStream(target.expected);
      let received = 0;
      const hasher = new crypto.DigestStream("SHA-256");
      const [toUpload, toHash] = request.body.tee();
      const hashDone = toHash.pipeTo(hasher);
      const counted = toUpload.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength;
            controller.enqueue(chunk);
          },
        })
      );
      const piping = counted.pipeTo(writable).then(
        () => true,
        () => false
      );
      let uploaded: R2UploadedPart;
      try {
        uploaded = await env.SIGNING_ARTIFACTS.resumeMultipartUpload(
          target.key,
          target.uploadId
        ).uploadPart(part, readable);
      } catch {
        const intact = await Promise.race([
          piping,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
        ]);
        return errorResponse(
          intact && received === target.expected ? 503 : 400,
          "signing_part_upload_failed",
          "Output part upload failed."
        );
      }
      if (!(await piping))
        return errorResponse(400, "bad_request", "Output part length is invalid.");
      await hashDone;
      const partDigest = `sha256:${Array.from(new Uint8Array(await hasher.digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      if (partDigest !== request.headers.get("X-Part-Digest"))
        return errorResponse(
          422,
          "signing_part_digest_mismatch",
          "Output part digest did not match."
        );
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "output-record",
          context,
          z.object({
            part: z.number().int().positive(),
            receivedParts: z.array(z.number().int().positive()),
          }),
          { part, etag: uploaded.etag, size }
        )
      );
    }
    if (operation === "output" && parts[5] === "complete" && request.method === "POST") {
      const plan = await machineRpc(
        env,
        context.ownerId,
        id,
        "output-complete",
        context,
        z.object({
          key: z.string(),
          uploadId: z.string(),
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          size: z.number().int().positive(),
          verified: z.boolean(),
          parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string() })),
        })
      );
      if (plan.verified)
        return dataResponse({ digest: plan.digest, size: plan.size, verified: true });
      let object = await env.SIGNING_ARTIFACTS.get(plan.key);
      if (!object) {
        try {
          await env.SIGNING_ARTIFACTS.resumeMultipartUpload(plan.key, plan.uploadId).complete(
            plan.parts
          );
        } catch {
          object = await env.SIGNING_ARTIFACTS.get(plan.key);
          if (!object) throw new Error("signing_output_completion_unavailable");
        }
        object ??= await env.SIGNING_ARTIFACTS.get(plan.key);
      }
      if (!object || object.size !== plan.size) {
        await object?.body.cancel();
        if (object) await env.SIGNING_ARTIFACTS.delete(plan.key);
        return errorResponse(
          422,
          "signing_output_invalid",
          "The output archive is missing or has an invalid size."
        );
      }
      const digestStream = new crypto.DigestStream("SHA-256");
      await object.body.pipeTo(digestStream);
      const actual = `sha256:${Array.from(new Uint8Array(await digestStream.digest), (value) => value.toString(16).padStart(2, "0")).join("")}`;
      if (actual !== plan.digest) {
        await env.SIGNING_ARTIFACTS.delete(plan.key);
        return errorResponse(
          422,
          "signing_output_invalid",
          "The output archive digest did not match."
        );
      }
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "output-verified",
          context,
          z.object({
            digest: z.string(),
            size: z.number().int().positive(),
            verified: z.literal(true),
          }),
          { digest: actual, size: plan.size }
        )
      );
    }
    if (operation === "complete" && request.method === "POST") {
      const body = z
        .object({
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          size: z.number().int().positive().max(2_000_000_000),
          verificationReport: z.unknown(),
        })
        .strict()
        .parse(await readJsonLimited(request, 131_072));
      const output = await machineRpc(
        env,
        context.ownerId,
        id,
        "output-target",
        context,
        objectTargetSchema
      );
      if (body.digest !== output.digest || body.size !== output.size)
        return errorResponse(
          422,
          "signing_output_invalid",
          "The output archive is missing or does not match its declared digest."
        );
      const { profile, sourceDigest, sourceCommitOid, version } = await machineRpc(
        env,
        context.ownerId,
        id,
        "profile",
        context,
        profileContextRpcSchema
      );
      if (
        !(await hooks.verifyOutput({
          context,
          profile,
          platform: profile.platform,
          sourceDigest,
          sourceCommitOid,
          version,
          outputDigest: output.digest,
          outputSize: output.size,
          report: body.verificationReport,
        }))
      )
        return errorResponse(
          422,
          "signing_verification_failed",
          "The platform verification report was rejected."
        );
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "complete",
          context,
          z.object({ state: SigningRequestSchema.shape.state }),
          { digest: body.digest, size: body.size, verificationReport: body.verificationReport }
        ),
        202
      );
    }
    if (operation === "fail" && request.method === "POST") {
      const body = z
        .object({
          code: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,63}$/)
            .optional(),
        })
        .strict()
        .parse(await readJsonLimited(request, 4096));
      return dataResponse(
        await machineRpc(
          env,
          context.ownerId,
          id,
          "fail",
          context,
          z.object({ state: z.literal("failed") }),
          body
        )
      );
    }
    return errorResponse(405, "method_not_allowed", "Signing operation is not supported.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const errorCode = /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : "unclassified";
    logger.warn("signing:machine-operation-failed", {
      operation,
      errorCode,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    if (message === "invalid_range")
      return errorResponse(416, "range_not_satisfiable", "Requested source range is invalid.");
    if (message === "signing_lease_invalid")
      return errorResponse(409, "conflict", "The signing lease is no longer valid.");
    if (message === "signing_output_invalid")
      return errorResponse(409, "conflict", "Signing output does not match the active request.");
    return errorResponse(503, "signing_unavailable", "Signing operation failed closed.");
  }
}
