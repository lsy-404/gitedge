import { z } from "zod";
import type {
  SigningMachineContext,
  SigningProfile,
} from "../../../../packages/contracts/src/signing";
import { windowsCredentialsSchema } from "../../../../packages/contracts/signing-native.mjs";
import { dataResponse, errorResponse, jsonResponse } from "../../../../src/worker/common/http";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import { base64ToBytes, bytesToBase64 } from "../../../../src/worker/common/encoding";
import {
  chainToBase64,
  loadRemoteSigningKey,
  recordRemoteOperation,
  remoteSign,
} from "./remote-keys";
import { appleConnectToken, boundedJson, storedPlatformCredentials } from "./services";
import type { SigningEnv } from "./types";

export const REMOTE_OPERATIONS = new Set(["signer", "sign", "azure-token", "notary"]);

const AZURE_RESOURCE = "https://codesigning.azure.net";
const MAX_SIGN_BYTES = 8 * 1024 * 1024;
const notaryStages = new Set(["sign", "dmg_sign"]);

const signBody = z
  .object({
    data: z.string().min(1),
    hash: z.enum(["SHA-1", "SHA-256", "SHA-384", "SHA-512"]),
    format: z.enum(["der", "raw"]).optional(),
  })
  .strict();
const notaryBody = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    submissionName: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  })
  .strict();
const submissionResponse = z.object({
  data: z.object({
    id: z.uuid(),
    attributes: z.object({
      awsAccessKeyId: z.string().min(1),
      awsSecretAccessKey: z.string().min(1),
      awsSessionToken: z.string().min(1),
      bucket: z.string().min(1),
      object: z.string().min(1),
    }),
  }),
});
const statusResponse = z.object({
  data: z.object({
    id: z.uuid(),
    attributes: z.object({ status: z.enum(["Accepted", "Invalid", "Rejected", "In Progress"]) }),
  }),
});

/** Serves the lease-authorized remote-signing operations; the caller has already authorized the lease. */
export async function handleRemoteOperation(
  request: Request,
  env: SigningEnv,
  context: SigningMachineContext,
  profile: SigningProfile,
  operation: string,
  submissionId: string | undefined
): Promise<Response> {
  if (operation === "signer" && request.method === "GET") {
    const key = await loadRemoteSigningKey(env, context, profile);
    if (!key) return errorResponse(404, "not_found", "No signing key is configured.");
    return dataResponse({ keyType: key.keyType, chain: chainToBase64(key.chain) });
  }
  if (operation === "sign" && request.method === "POST") {
    if (profile.platform !== "android")
      return errorResponse(403, "forbidden", "Remote signing is not enabled for this profile.");
    const parsed = signBody.safeParse(await readJsonLimited(request, MAX_SIGN_BYTES * 2));
    if (!parsed.success) return errorResponse(400, "bad_request", "Signing request is invalid.");
    let data: Uint8Array;
    try {
      data = base64ToBytes(parsed.data.data);
    } catch {
      return errorResponse(400, "bad_request", "Signing request is invalid.");
    }
    if (data.length > MAX_SIGN_BYTES)
      return errorResponse(413, "payload_too_large", "Signing data is too large.");
    const key = await loadRemoteSigningKey(env, context, profile);
    if (!key) return errorResponse(404, "not_found", "No signing key is configured.");
    await recordRemoteOperation(env, context, "sign");
    const signature = await remoteSign(key, data, parsed.data.hash, parsed.data.format);
    return dataResponse({ signature: bytesToBase64(signature) });
  }
  if (operation === "azure-token" && request.method === "GET") {
    if (profile.platform !== "windows")
      return errorResponse(403, "forbidden", "Azure tokens are not enabled for this profile.");
    const url = new URL(request.url);
    if (
      url.searchParams.get("api-version") !== "2019-08-01" ||
      url.searchParams.get("resource")?.replace(/\/$/, "") !== AZURE_RESOURCE
    )
      return errorResponse(400, "bad_request", "Unsupported token request.");
    const credentials = await storedPlatformCredentials(
      env,
      context.ownerId,
      context.repositoryId,
      profile.revision,
      "windows"
    );
    if (!credentials)
      return errorResponse(404, "not_found", "No signing credentials are configured.");
    const { tenant_id, client_id, client_secret } = windowsCredentialsSchema.parse(credentials);
    const requestedClient = url.searchParams.get("client_id");
    if (requestedClient && requestedClient.toLowerCase() !== client_id.toLowerCase())
      return errorResponse(400, "bad_request", "Unsupported token request.");
    await recordRemoteOperation(env, context, "azure-token");
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenant_id)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id,
          client_secret,
          scope: `${AZURE_RESOURCE}/.default`,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      }
    );
    const token = z
      .object({ access_token: z.string().min(1), expires_in: z.coerce.number().int().positive() })
      .parse(await boundedJson(response, 65_536));
    // The managed-identity client parses this body itself, so it is not wrapped in a data envelope.
    return jsonResponse({
      access_token: token.access_token,
      expires_on: String(Math.floor(Date.now() / 1000) + token.expires_in),
      resource: AZURE_RESOURCE,
      token_type: "Bearer",
      client_id,
    });
  }
  if (operation === "notary") {
    if (profile.platform !== "macos" || !notaryStages.has(context.stage))
      return errorResponse(403, "forbidden", "Notarization is not enabled for this stage.");
    const credentials = await storedPlatformCredentials(
      env,
      context.ownerId,
      context.repositoryId,
      profile.revision,
      "macos"
    );
    if (!credentials)
      return errorResponse(404, "not_found", "No signing credentials are configured.");
    const token = await appleConnectToken(credentials);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (request.method === "POST" && !submissionId) {
      const parsed = notaryBody.safeParse(await readJsonLimited(request, 4096));
      if (!parsed.success) return errorResponse(400, "bad_request", "Notary request is invalid.");
      await recordRemoteOperation(env, context, "notary-submit");
      const response = await fetch("https://appstoreconnect.apple.com/notary/v2/submissions", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          submissionName: parsed.data.submissionName,
          sha256: parsed.data.sha256.toLowerCase(),
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const { data } = submissionResponse.parse(await boundedJson(response, 262_144));
      return dataResponse({
        id: data.id,
        region: "us-west-2",
        bucket: data.attributes.bucket,
        object: data.attributes.object,
        awsAccessKeyId: data.attributes.awsAccessKeyId,
        awsSecretAccessKey: data.attributes.awsSecretAccessKey,
        awsSessionToken: data.attributes.awsSessionToken,
      });
    }
    if (request.method === "GET" && submissionId && z.uuid().safeParse(submissionId).success) {
      await recordRemoteOperation(env, context, "notary-status");
      const response = await fetch(
        `https://appstoreconnect.apple.com/notary/v2/submissions/${encodeURIComponent(submissionId)}`,
        { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }
      );
      const { data } = statusResponse.parse(await boundedJson(response, 262_144));
      if (data.id.toLowerCase() !== submissionId.toLowerCase())
        throw new Error("notary_id_mismatch");
      return dataResponse({ status: data.attributes.status });
    }
  }
  return errorResponse(405, "method_not_allowed", "Signing operation is not supported.");
}
