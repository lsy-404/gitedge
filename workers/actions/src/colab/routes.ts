import {
  ColabAuthorizationCodeSchema,
  accessTokenAllows,
  type TrustedUser,
} from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../../src/worker/common/http";
import { createLogger } from "../../../../src/worker/common/logger";
import { readJsonLimited } from "../../../../src/worker/common/readText";
import { openText, sealText } from "../../../../src/worker/common/secret-box";
import { stopOwnerDispatches } from "../colab-runners";
import type { RunnerEnv } from "../runners";
import {
  cacheAccessToken,
  colabSealingKey,
  forgetAccessToken,
  readColabAccount,
  recordComputeUnits,
} from "./account";
import {
  GoogleGrantError,
  authorizationUrl,
  createCodeVerifier,
  exchangeAuthorizationCode,
  revokeToken,
} from "./google-oauth";

const AUTHORIZATION_WINDOW_MS = 10 * 60_000;

async function startAuthorization(env: RunnerEnv, ownerId: string): Promise<Response> {
  const key = await colabSealingKey(env);
  if (!key) return errorResponse(503, "service_unavailable", "Colab accounts are not configured.");
  const verifier = createCodeVerifier();
  const sealed = await sealText(key, verifier);
  await env.DB.prepare(
    `INSERT INTO actions_colab_authorizations (owner_id,verifier_ciphertext,verifier_iv,expires_at) VALUES (?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET verifier_ciphertext=excluded.verifier_ciphertext,verifier_iv=excluded.verifier_iv,expires_at=excluded.expires_at`
  )
    .bind(ownerId, sealed.ciphertext, sealed.iv, Date.now() + AUTHORIZATION_WINDOW_MS)
    .run();
  return dataResponse({ url: await authorizationUrl(verifier) });
}

async function revokeStored(
  key: CryptoKey,
  sealed: { ciphertext: string; iv: string }
): Promise<void> {
  try {
    await revokeToken(await openText(key, sealed));
  } catch {
    // Revocation is best effort; the stored token is deleted either way.
  }
}

async function connectAccount(
  request: Request,
  env: RunnerEnv,
  ownerId: string
): Promise<Response> {
  const body = ColabAuthorizationCodeSchema.safeParse(await readJsonLimited(request, 4096));
  if (!body.success) return errorResponse(400, "bad_request", "Invalid authorization code.");
  const key = await colabSealingKey(env);
  if (!key) return errorResponse(503, "service_unavailable", "Colab accounts are not configured.");
  const pending = await env.DB.prepare(
    "DELETE FROM actions_colab_authorizations WHERE owner_id=? RETURNING verifier_ciphertext,verifier_iv,expires_at"
  )
    .bind(ownerId)
    .first<{ verifier_ciphertext: string; verifier_iv: string; expires_at: number }>();
  if (!pending || pending.expires_at <= Date.now())
    return errorResponse(409, "conflict", "Start the Google authorization again.");
  const verifier = await openText(key, {
    ciphertext: pending.verifier_ciphertext,
    iv: pending.verifier_iv,
  });
  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(body.data.code, verifier);
  } catch (cause) {
    if (cause instanceof GoogleGrantError)
      return errorResponse(400, "bad_request", "Google rejected the authorization code.");
    throw cause;
  }
  if (!tokens.refreshToken || !tokens.email)
    return errorResponse(400, "bad_request", "Google did not grant offline Colab access.");
  const previous = await env.DB.prepare(
    "SELECT refresh_token_ciphertext AS ciphertext,refresh_token_iv AS iv FROM actions_colab_accounts WHERE owner_id=?"
  )
    .bind(ownerId)
    .first<{ ciphertext: string; iv: string }>();
  const sealed = await sealText(key, tokens.refreshToken);
  await env.DB.prepare(
    `INSERT INTO actions_colab_accounts (owner_id,email,refresh_token_ciphertext,refresh_token_iv,connected_at) VALUES (?,?,?,?,?)
    ON CONFLICT(owner_id) DO UPDATE SET email=excluded.email,refresh_token_ciphertext=excluded.refresh_token_ciphertext,
      refresh_token_iv=excluded.refresh_token_iv,connected_at=excluded.connected_at,balance=NULL,rate_hourly=NULL,checked_at=NULL,error=NULL`
  )
    .bind(ownerId, tokens.email, sealed.ciphertext, sealed.iv, Date.now())
    .run();
  if (previous) await revokeStored(key, previous);
  cacheAccessToken(ownerId, tokens);
  await recordComputeUnits(env, ownerId, tokens.accessToken);
  createLogger(env.LOG_LEVEL, { service: "colab-runner" }).info("colab-runner:account-connected", {
    ownerId,
  });
  return dataResponse(await readColabAccount(env.DB, ownerId));
}

async function disconnectAccount(env: RunnerEnv, ownerId: string): Promise<Response> {
  await stopOwnerDispatches(env, ownerId);
  const row = await env.DB.prepare(
    "DELETE FROM actions_colab_accounts WHERE owner_id=? RETURNING refresh_token_ciphertext AS ciphertext,refresh_token_iv AS iv"
  )
    .bind(ownerId)
    .first<{ ciphertext: string; iv: string }>();
  await env.DB.prepare("DELETE FROM actions_colab_authorizations WHERE owner_id=?")
    .bind(ownerId)
    .run();
  forgetAccessToken(ownerId);
  const key = await colabSealingKey(env);
  if (row && key) await revokeStored(key, row);
  return new Response(null, { status: 204 });
}

/** Account routes that connect the signed-in person's Google account for Colab runtimes. */
export async function colabAccountRequest(
  request: Request,
  env: RunnerEnv,
  user: TrustedUser | null
): Promise<Response> {
  if (
    !user ||
    user.job ||
    user.agentSession ||
    user.token?.repositoryIds ||
    (user.token && !accessTokenAllows(user.token, "admin"))
  )
    return errorResponse(403, "forbidden", "Only the account owner can manage the Colab account.");
  const pathname = new URL(request.url).pathname;
  if (pathname === "/colab/authorization") {
    if (request.method !== "POST")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    return startAuthorization(env, user.id);
  }
  if (pathname === "/colab/account") {
    if (request.method === "PUT") return connectAccount(request, env, user.id);
    if (request.method === "DELETE") return disconnectAccount(env, user.id);
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  }
  return errorResponse(404, "not_found", "Colab endpoint was not found.");
}
