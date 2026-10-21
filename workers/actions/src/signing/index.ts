import { SigningMachineContextSchema, SigningSubmissionSchema, type SigningRequest, type SigningPlatform } from "../../../../packages/contracts/src/signing";
import { z } from "zod";
import type { TrustedUser } from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../../src/worker/common/http";
import { SigningCoordinator, coordinator } from "./coordinator";
import type { ApprovedSigningProfile, SigningEnv, SigningExecutionHooks } from "./types";
export { createSigningExecutionHooks, installSigningCredentials, saveApprovedProfile } from "./services";

export { SigningCoordinator };
export type { SigningEnv, SigningExecutionHooks, SigningQueueInput } from "./types";

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

function bodyResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("signing_state_unavailable");
  return response.json() as Promise<T>;
}

function signingObjectKey(ownerId: string, repositoryId: string, requestId: string, object: "source" | "output") {
  return `signing/${ownerId}/${repositoryId}/${requestId}/${object}.zip`;
}

async function verifiedObject(env: SigningEnv, key: string, digest: string, size: number): Promise<boolean> {
  const object = await env.SIGNING_ARTIFACTS.get(key);
  if (!object || object.size !== size) {
    await object?.body.cancel();
    return false;
  }
  const DigestStream = (crypto as unknown as { DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
  const sink = new DigestStream("SHA-256");
  await object.body.pipeTo(sink);
  const actual = Array.from(new Uint8Array(await sink.digest), value => value.toString(16).padStart(2, "0")).join("");
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
  if (path[0] !== "signing" || path[1] !== "requests")
    return errorResponse(404, "not_found", "Signing endpoint was not found.");
  if (!user || user.job || user.agentSession)
    return errorResponse(403, "forbidden", "An account owner session is required.");
  try {
    if (request.method === "POST" && path.length === 2) {
      const repositoryId = url.searchParams.get("repositoryId") ?? undefined;
      const repository = await ownedRunnerRepository(env, user.id, repositoryId);
      if (!repository) return errorResponse(503, "signing_runner_unavailable", "The private account Runner is unavailable.");
      const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
      if (!/^[A-Za-z0-9_.-]{16,128}$/.test(idempotencyKey))
        return errorResponse(400, "bad_request", "A valid idempotency key is required.");
      const submission = SigningSubmissionSchema.parse(await request.json());
      const profile = await executionHooks.loadApprovedProfile(user, repository.id, submission.profile);
      if (!profile || !profile.enabled || profile.platform !== submission.platform)
        return errorResponse(503, "signing_profile_unavailable", "No approved signing profile is available.");
      const operatorApproval = await executionHooks.verifySigningHost(user.id, repository.id, profile.platform);
      if (!operatorApproval?.operatorApproved || operatorApproval.approvedBy !== user.id || !Number.isSafeInteger(operatorApproval.approvedAt))
        return errorResponse(503, "signing_host_unverified", "No owner-approved dedicated signing host is available.");
      const source = await executionHooks.verifySource(user, submission);
      if (!source)
        return errorResponse(422, "signing_source_not_allowed", "The source run is not authorized by the approved profile.");
      const generation = 1;
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const stub = coordinator(env, user.id);
      const created = await bodyResponse<{
        request: SigningRequest;
        created: boolean;
        dispatch: { profile: ApprovedSigningProfile; submission: typeof submission; generation: number; nonce: string; operatorApproval: NonNullable<typeof operatorApproval> };
      }>(await stub.fetch(new Request("https://signing.internal/create", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          requestId: crypto.randomUUID(), ownerId: user.id, repositoryId: repository.id,
          idempotencyKey, profile, submission, generation, nonce,
        }),
      })));
      if (!created.created && created.request.state !== "accepted") return dataResponse({ request: created.request }, 200);
      const accepted = created.dispatch;
      if (created.request.profileRevision !== profile.revision || accepted.profile.revision !== profile.revision)
        return errorResponse(409, "conflict", "The approved profile changed after this request was accepted.");
      const sourceKey = signingObjectKey(user.id, repository.id, created.request.id, "source");
      try {
        const existing = await env.SIGNING_ARTIFACTS.head(sourceKey);
        if (!existing) {
          await env.SIGNING_ARTIFACTS.put(sourceKey, source.body, {
            customMetadata: { ownerId: user.id, repositoryId: repository.id, requestId: created.request.id, sha256: submission.sourceDigest, size: String(submission.sourceSize) },
          });
        }
        if (!await verifiedObject(env, sourceKey, submission.sourceDigest, submission.sourceSize)) {
          await env.SIGNING_ARTIFACTS.delete(sourceKey);
          return errorResponse(422, "signing_source_digest_mismatch", "The source artifact did not match its validated digest and size.");
        }
      } catch {
        return errorResponse(503, "signing_source_storage_unavailable", "The source artifact could not be stored and verified.");
      }
      const queued = await executionHooks.enqueue({
        requestId: created.request.id,
        ownerId: user.id,
        repositoryId: repository.id,
        workflowOid: accepted.profile.workflowOid,
        workflowPath: accepted.profile.workflowPath,
        workflowSource: accepted.profile.workflowSource,
        stage: accepted.profile.policy.stage as import("../../../../packages/contracts/src/signing").SigningStage,
        inputDigest: accepted.submission.sourceDigest,
        platform: accepted.profile.platform,
        generation: accepted.generation,
        nonce: accepted.nonce,
        timeoutMinutes: accepted.profile.timeoutMinutes,
        sourceDigest: accepted.submission.sourceDigest,
        profileRevision: accepted.profile.revision,
        operatorApproval: accepted.operatorApproval,
      });
      const bound = await bodyResponse<{ bound: boolean }>(await stub.fetch(new Request(`https://signing.internal/bind-run/${created.request.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerId: user.id, repositoryId: repository.id, runId: queued.runId }),
      })));
      if (!bound.bound) return errorResponse(404, "not_found", "Signing request was not found.");
      return dataResponse({ request: { ...created.request, runId: queued.runId, state: "queued" } }, created.created ? 202 : 200);
    }
    if (request.method === "GET" && path.length === 3) {
      const repoParam = url.searchParams.get("repositoryId");
      if (!repoParam) return errorResponse(400, "bad_request", "repositoryId is required.");
      const repository = await ownedRunnerRepository(env, user.id, repoParam);
      if (!repository) return errorResponse(404, "not_found", "Signing request was not found.");
      const response = await coordinator(env, user.id).fetch(new Request(`https://signing.internal/requests/${encodeURIComponent(path[2]!)}`, {
        headers: { "X-Signing-Owner": user.id, "X-Signing-Repository": repository.id },
      }));
      const value = await response.json() as { request?: SigningRequest };
      return response.ok && value.request ? dataResponse(value.request) : errorResponse(404, "not_found", "Signing request was not found.");
    }
    if (request.method === "GET" && path.length === 4 && path[3] === "download") {
      const repoParam = url.searchParams.get("repositoryId");
      if (!repoParam) return errorResponse(400, "bad_request", "repositoryId is required.");
      const repository = await ownedRunnerRepository(env, user.id, repoParam);
      if (!repository) return errorResponse(404, "not_found", "Signing request was not found.");
      const response = await coordinator(env, user.id).fetch(new Request(`https://signing.internal/requests/${encodeURIComponent(path[2]!)}`, {
        headers: { "X-Signing-Owner": user.id, "X-Signing-Repository": repository.id },
      }));
      const value = await response.json() as { request?: SigningRequest };
      const state = value.request;
      if (!response.ok || !state || state.state !== "succeeded" || !state.outputDigest || !state.outputSize)
        return errorResponse(404, "not_found", "Signing output was not found.");
      const key = signingObjectKey(user.id, repository.id, state.id, "output");
      const object = await env.SIGNING_ARTIFACTS.get(key);
      if (!object || object.size !== state.outputSize) return errorResponse(410, "gone", "Signing output is no longer available.");
      return new Response(object.body, { headers: objectHeaders(state.outputDigest, object.size) });
    }
    return errorResponse(405, "method_not_allowed", "Signing operation is not supported.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "signing_idempotency_conflict") return errorResponse(409, "conflict", "The idempotency key is already bound to another request.");
    if (message === "signing_profile_not_approved") return errorResponse(503, "signing_profile_unavailable", "No approved signing profile is available.");
    if (error instanceof SyntaxError || error instanceof z.ZodError) return errorResponse(400, "bad_request", "Invalid signing request.");
    return errorResponse(503, "signing_unavailable", "Signing service is unavailable.");
  }
}

async function machineRpc<T>(env: SigningEnv, ownerId: string, id: string, operation: string, context: unknown, payload?: unknown): Promise<T> {
  const response = await coordinator(env, ownerId).fetch(new Request(`https://signing.internal/machine/${encodeURIComponent(id)}/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context, payload }),
  }));
  const body = await response.json() as { data?: T; error?: string };
  if (!response.ok || !body.data) throw new Error(body.error ?? "signing_state_unavailable");
  return body.data;
}

async function authorizeMachine(raw: unknown, id: string, env: SigningEnv, hooks: SigningExecutionHooks) {
  const parsed = SigningMachineContextSchema.safeParse(raw);
  if (!parsed.success || parsed.data.requestId !== id || parsed.data.leaseExpiresAt <= Date.now()) return null;
  try {
    await machineRpc<{ profile: ApprovedSigningProfile }>(env, parsed.data.ownerId, id, "profile", parsed.data);
  } catch { return null; }
  const current = await hooks.verifySigningHost(parsed.data.ownerId, parsed.data.repositoryId, parsed.data.platform);
  if (!current?.operatorApproved || current.approvedBy !== parsed.data.ownerId
    || current.approvedBy !== parsed.data.operatorApproval.approvedBy || current.approvedAt !== parsed.data.operatorApproval.approvedAt)
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
  if (parts[0] !== "runner" || parts[1] !== "signing" || parts[2] !== "requests" || !parts[3] || !parts[4])
    return errorResponse(404, "not_found", "Signing runner endpoint was not found.");
  const id = parts[3];
  const operation = parts[4];
  const context = await authorizeMachine(trustedContext, id, env, hooks);
  if (!context) return errorResponse(403, "forbidden", "The active owner-approved signing lease is required.");
  try {
    if (operation === "start" && request.method === "POST") {
      return dataResponse(await machineRpc(env, context.ownerId, id, "start", context));
    }
    if (operation === "heartbeat" && request.method === "POST") {
      return dataResponse(await machineRpc(env, context.ownerId, id, "heartbeat", context));
    }
    if (operation === "download" && request.method === "GET") {
      const objectName = new URL(request.url).searchParams.get("object") ?? "input";
      if (objectName !== "input" && objectName !== "template") return errorResponse(400, "bad_request", "Requested signing input object is invalid.");
      const target = await machineRpc<{ key: string; digest: string; size: number }>(env, context.ownerId, id, "download", context, { object: objectName });
      const start = parseRange(request.headers.get("Range"), target.size);
      const object = await env.SIGNING_ARTIFACTS.get(target.key, start ? { range: { offset: start } } : undefined);
      if (!object || object.size !== target.size) return errorResponse(409, "signing_object_unavailable", "The validated source archive is unavailable.");
      return new Response(object.body, { status: start ? 206 : 200, headers: objectHeaders(target.digest, target.size, start) });
    }
    if (operation === "authorize-sign" && request.method === "POST") {
      const { profile } = await machineRpc<{ profile: ApprovedSigningProfile }>(env, context.ownerId, id, "profile", context);
      await machineRpc(env, context.ownerId, id, "authorize-sign", context);
      const grant = await hooks.authorizeCredentials(context, profile);
      if (!grant || grant.expiresAt <= Date.now() || grant.expiresAt > context.leaseExpiresAt || grant.expiresAt > Date.now() + 10 * 60_000)
        return errorResponse(503, "signing_credentials_unavailable", "A request-scoped signing credential grant is unavailable.");
      return dataResponse({ credentials: grant.credentials, expiresAt: grant.expiresAt });
    }
    if (operation === "output" && parts.length === 5 && request.method === "POST") {
      if (request.headers.get("Content-Type") !== "application/json") return errorResponse(400, "bad_request", "Output metadata must be JSON.");
      const body = await request.json() as { digest?: string; size?: number };
      const digest = body.digest ?? "";
      const size = body.size;
      if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || !size || size < 1 || size > 2_000_000_000)
        return errorResponse(400, "bad_request", "Output digest and size are required.");
      const transfer = await machineRpc(env, context.ownerId, id, "output-begin", context, { digest, size });
      return dataResponse(transfer);
    }
    if (operation === "output" && parts[5] === "parts" && parts[6] && request.method === "PUT") {
      if (request.headers.get("Content-Type") !== "application/octet-stream") return errorResponse(400, "bad_request", "Output must be an octet stream.");
      const sizeHeader = request.headers.get("Content-Length") ?? "";
      if (!/^\d{1,10}$/.test(sizeHeader) || !request.body) return errorResponse(411, "length_required", "Output content length is required.");
      const size = Number(sizeHeader);
      const part = Number(parts[6]);
      const target = await machineRpc<{ key: string; uploadId: string; expected: number; total: number }>(env, context.ownerId, id, "output-part", context, { part, length: size });
      const start = (part - 1) * 8 * 1024 * 1024;
      const end = start + target.expected - 1;
      if (request.headers.get("Content-Range") !== `bytes ${start}-${end}/${target.total}`
        || !/^sha256:[a-f0-9]{64}$/.test(request.headers.get("X-Part-Digest") ?? ""))
        return errorResponse(400, "bad_request", "Output part range and digest are required.");
      const { readable, writable } = new FixedLengthStream(target.expected);
      let received = 0;
      const DigestStream = (crypto as unknown as { DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }).DigestStream;
      const hasher = new DigestStream("SHA-256");
      const [toUpload, toHash] = request.body.tee();
      const hashDone = toHash.pipeTo(hasher);
      const counted = toUpload.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { received += chunk.byteLength; controller.enqueue(chunk); },
      }));
      const piping = counted.pipeTo(writable).then(() => true, () => false);
      let uploaded: R2UploadedPart;
      try {
        uploaded = await env.SIGNING_ARTIFACTS.resumeMultipartUpload(target.key, target.uploadId).uploadPart(part, readable);
      } catch {
        const intact = await Promise.race([piping, new Promise<boolean>(resolve => setTimeout(() => resolve(true), 100))]);
        return errorResponse(intact && received === target.expected ? 503 : 400, "signing_part_upload_failed", "Output part upload failed.");
      }
      if (!await piping) return errorResponse(400, "bad_request", "Output part length is invalid.");
      await hashDone;
      const partDigest = `sha256:${Array.from(new Uint8Array(await hasher.digest), value => value.toString(16).padStart(2, "0")).join("")}`;
      if (partDigest !== request.headers.get("X-Part-Digest")) return errorResponse(422, "signing_part_digest_mismatch", "Output part digest did not match.");
      return dataResponse(await machineRpc(env, context.ownerId, id, "output-record", context, { part, etag: uploaded.etag, size }));
    }
    if (operation === "output" && parts[5] === "complete" && request.method === "POST") {
      const result = await machineRpc(env, context.ownerId, id, "output-complete", context);
      return dataResponse(result);
    }
    if (operation === "complete" && request.method === "POST") {
      const body = await request.json() as { digest?: string; size?: number; verificationReport?: unknown };
      const output = await machineRpc<{ key: string; digest: string; size: number }>(env, context.ownerId, id, "output-target", context);
      if (body.digest !== output.digest || body.size !== output.size || !await verifiedObject(env, output.key, output.digest, output.size))
        return errorResponse(422, "signing_output_invalid", "The output archive is missing or does not match its declared digest.");
      const { profile, sourceDigest, sourceCommitOid, version } = await machineRpc<{ profile: ApprovedSigningProfile; sourceDigest: string; sourceCommitOid: string; version: string }>(env, context.ownerId, id, "profile", context);
      if (!await hooks.verifyOutput({ context, profile, platform: profile.platform as SigningPlatform, sourceDigest, sourceCommitOid, version, outputDigest: output.digest, outputSize: output.size, report: body.verificationReport }))
        return errorResponse(422, "signing_verification_failed", "The platform verification report was rejected.");
      return dataResponse(await machineRpc(env, context.ownerId, id, "complete", context, { digest: body.digest, size: body.size, verificationReport: body.verificationReport }), 202);
    }
    return errorResponse(405, "method_not_allowed", "Signing operation is not supported.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "invalid_range") return errorResponse(416, "range_not_satisfiable", "Requested source range is invalid.");
    if (message === "signing_lease_invalid") return errorResponse(409, "conflict", "The signing lease is no longer valid.");
    if (message === "signing_output_invalid") return errorResponse(409, "conflict", "Signing output does not match the active request.");
    return errorResponse(503, "signing_unavailable", "Signing operation failed closed.");
  }
}
