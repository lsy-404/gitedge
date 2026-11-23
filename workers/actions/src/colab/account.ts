import type { ColabAccount } from "../../../../packages/contracts/src/index";
import { base64UrlToBytes } from "../../../../src/worker/common/encoding";
import { createLogger } from "../../../../src/worker/common/logger";
import { openText, sealText, type SealedText } from "../../../../src/worker/common/secret-box";
import type { RunnerEnv } from "../runners";
import { GoogleGrantError, refreshAccessToken, type GoogleTokens } from "./google-oauth";
import { readComputeUnits } from "./session-backend";

const KEY_INFO = "gitedge-colab-oauth";
const ACCESS_TOKEN_MARGIN_MS = 60_000;
export const AUTHORIZATION_REVOKED = "colab_authorization_revoked";

export class ColabAccountUnavailableError extends Error {}

let sealingKey: { secret: string; key: Promise<CryptoKey | null> } | null = null;
const accessTokens = new Map<string, { token: string; expiresAt: number }>();
const refreshes = new Map<string, Promise<string>>();

async function deriveSealingKey(secret: string): Promise<CryptoKey | null> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlToBytes(secret);
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(KEY_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** The AES-GCM key for Colab OAuth secrets, derived from SIGNING_ENCRYPTION_KEY. */
export function colabSealingKey(env: RunnerEnv): Promise<CryptoKey | null> {
  const secret = env.SIGNING_ENCRYPTION_KEY;
  if (!secret) return Promise.resolve(null);
  if (sealingKey?.secret !== secret) sealingKey = { secret, key: deriveSealingKey(secret) };
  return sealingKey.key;
}

export function cacheAccessToken(ownerId: string, tokens: GoogleTokens): void {
  accessTokens.set(ownerId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
}

export function forgetAccessToken(ownerId: string): void {
  accessTokens.delete(ownerId);
}

async function refreshOwnerToken(env: RunnerEnv, ownerId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT refresh_token_ciphertext,refresh_token_iv,error FROM actions_colab_accounts WHERE owner_id=?"
  )
    .bind(ownerId)
    .first<{ refresh_token_ciphertext: string; refresh_token_iv: string; error: string | null }>();
  const key = await colabSealingKey(env);
  if (!row || row.error || !key) throw new ColabAccountUnavailableError("No usable Colab account.");
  const sealed: SealedText = { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv };
  let tokens: GoogleTokens;
  try {
    tokens = await refreshAccessToken(await openText(key, sealed));
  } catch (cause) {
    if (cause instanceof GoogleGrantError && cause.code === "invalid_grant") {
      await env.DB.prepare(
        "UPDATE actions_colab_accounts SET error=? WHERE owner_id=? AND refresh_token_ciphertext=?"
      )
        .bind(AUTHORIZATION_REVOKED, ownerId, row.refresh_token_ciphertext)
        .run();
      createLogger(env.LOG_LEVEL, { service: "colab-runner" }).warn(
        "colab-runner:authorization-revoked",
        { ownerId }
      );
    }
    throw new ColabAccountUnavailableError(
      cause instanceof Error ? cause.message : "Google token refresh failed."
    );
  }
  if (tokens.refreshToken) {
    const next = await sealText(key, tokens.refreshToken);
    await env.DB.prepare(
      "UPDATE actions_colab_accounts SET refresh_token_ciphertext=?,refresh_token_iv=? WHERE owner_id=? AND refresh_token_ciphertext=?"
    )
      .bind(next.ciphertext, next.iv, ownerId, row.refresh_token_ciphertext)
      .run();
  }
  cacheAccessToken(ownerId, tokens);
  return tokens.accessToken;
}

/** Returns a Colab access token for the owner, cached per isolate until shortly before it expires. */
export function colabAccessToken(env: RunnerEnv, ownerId: string): Promise<string> {
  const cached = accessTokens.get(ownerId);
  if (cached && cached.expiresAt - ACCESS_TOKEN_MARGIN_MS > Date.now())
    return Promise.resolve(cached.token);
  let pending = refreshes.get(ownerId);
  if (!pending) {
    pending = refreshOwnerToken(env, ownerId).finally(() => refreshes.delete(ownerId));
    refreshes.set(ownerId, pending);
  }
  return pending;
}

/** Stores the account's compute-unit balance and hourly rate; failures leave the last reading. */
export async function recordComputeUnits(
  env: RunnerEnv,
  ownerId: string,
  accessToken: string
): Promise<void> {
  try {
    const units = await readComputeUnits(accessToken);
    await env.DB.prepare(
      "UPDATE actions_colab_accounts SET balance=?,rate_hourly=?,checked_at=? WHERE owner_id=?"
    )
      .bind(units.balance, units.rateHourly, Date.now(), ownerId)
      .run();
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "colab-runner" }).warn("colab-runner:ccu-info-failed", {
      ownerId,
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
}

export async function readColabAccount(
  db: D1Database,
  ownerId: string
): Promise<ColabAccount | null> {
  return db
    .prepare(
      `SELECT email,connected_at AS connectedAt,balance,rate_hourly AS rateHourly,checked_at AS checkedAt,error
      FROM actions_colab_accounts WHERE owner_id=?`
    )
    .bind(ownerId)
    .first<ColabAccount>();
}
