import { createToken, hashToken } from "../session";
import type { SecurityEnv } from "./env";

export type ChallengePurpose =
  "login_second_factor" | "passkey_register" | "passkey_login" | "passkey_reauth";

export interface StoredChallenge {
  userId: string | null;
  webauthnChallenge: string | null;
}

const SECOND_FACTOR_TTL_MS = 5 * 60 * 1000;
export const WEBAUTHN_TTL_MS = 5 * 60 * 1000;
export const MAX_SECOND_FACTOR_ATTEMPTS = 5;

/** Stores a challenge under a caller-chosen or fresh handle; the handle itself is never stored. */
export async function saveChallenge(
  env: Pick<SecurityEnv, "DB">,
  challenge: {
    purpose: ChallengePurpose;
    userId: string | null;
    webauthnChallenge: string | null;
    handle?: string;
    ttlMs?: number;
  }
): Promise<string> {
  const handle = challenge.handle ?? createToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT OR REPLACE INTO auth_challenges (handle_hash, purpose, user_id, webauthn_challenge, attempts, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
    ).bind(
      await hashToken(`${challenge.purpose}:${handle}`),
      challenge.purpose,
      challenge.userId,
      challenge.webauthnChallenge,
      now + (challenge.ttlMs ?? WEBAUTHN_TTL_MS),
      now
    ),
  ]);
  return handle;
}

/** Spends the challenge; each handle verifies at most one response. */
export async function takeChallenge(
  env: Pick<SecurityEnv, "DB">,
  purpose: ChallengePurpose,
  handle: string
): Promise<StoredChallenge | null> {
  return env.DB.prepare(
    "DELETE FROM auth_challenges WHERE handle_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id AS userId, webauthn_challenge AS webauthnChallenge"
  )
    .bind(await hashToken(`${purpose}:${handle}`), purpose, Date.now())
    .first<StoredChallenge>();
}

export async function beginSecondFactorChallenge(
  env: Pick<SecurityEnv, "DB">,
  userId: string
): Promise<string> {
  return saveChallenge(env, {
    purpose: "login_second_factor",
    userId,
    webauthnChallenge: null,
    ttlMs: SECOND_FACTOR_TTL_MS,
  });
}

/** Counts an attempt against the pending login and returns it while attempts remain. */
export async function attemptSecondFactorChallenge(
  env: Pick<SecurityEnv, "DB">,
  handle: string
): Promise<(StoredChallenge & { userId: string }) | null> {
  const row = await env.DB.prepare(
    "UPDATE auth_challenges SET attempts = attempts + 1 WHERE handle_hash = ? AND purpose = 'login_second_factor' AND expires_at > ? AND attempts < ? RETURNING user_id AS userId, webauthn_challenge AS webauthnChallenge"
  )
    .bind(await hashToken(`login_second_factor:${handle}`), Date.now(), MAX_SECOND_FACTOR_ATTEMPTS)
    .first<StoredChallenge>();
  return row?.userId ? { ...row, userId: row.userId } : null;
}

export async function setSecondFactorPasskeyChallenge(
  env: Pick<SecurityEnv, "DB">,
  handle: string,
  webauthnChallenge: string
): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_challenges SET webauthn_challenge = ? WHERE handle_hash = ? AND purpose = 'login_second_factor'"
  )
    .bind(webauthnChallenge, await hashToken(`login_second_factor:${handle}`))
    .run();
}

/** Looks up a pending login without consuming an attempt (used to prepare a passkey prompt). */
export async function peekSecondFactorChallenge(
  env: Pick<SecurityEnv, "DB">,
  handle: string
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT user_id AS userId FROM auth_challenges WHERE handle_hash = ? AND purpose = 'login_second_factor' AND expires_at > ? AND attempts < ?"
  )
    .bind(await hashToken(`login_second_factor:${handle}`), Date.now(), MAX_SECOND_FACTOR_ATTEMPTS)
    .first<{ userId: string }>();
  return row?.userId ?? null;
}
