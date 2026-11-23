import { z } from "zod";

export const remoteAccessSchema = z
  .object({
    endpoint: z.url(),
    jobToken: z.string().regex(/^ge_job_[0-9a-f]{64}$/),
    runId: z.uuid(),
    leaseToken: z.string().regex(/^[0-9a-f]{64}$/i),
  })
  .strict();

/** Lease-bound access to the request's remote signing endpoints. */
export function remoteAccess(identity) {
  return {
    endpoint: `${identity.baseUrl}/runner/signing/requests/${encodeURIComponent(identity.requestId)}`,
    jobToken: identity.jobToken,
    runId: identity.runId,
    leaseToken: identity.leaseToken,
  };
}

export function remoteHeaders(remote) {
  return {
    authorization: `Bearer ${remote.jobToken}`,
    accept: "application/json",
    "x-runner-run-id": remote.runId,
    "x-runner-lease-token": remote.leaseToken,
  };
}

/** The value a managed-identity client sends as X-IDENTITY-HEADER. */
export function remoteIdentityHeader(remote) {
  return `${remote.jobToken}.${remote.runId}.${remote.leaseToken}`;
}

/** Validates a grant of the shape `{ ...grant, remote }` against the platform's grant schema. */
export function parseGrant(schema, value) {
  const { remote, ...grant } = value ?? {};
  return { ...schema.parse(grant), remote: remoteAccessSchema.parse(remote) };
}
