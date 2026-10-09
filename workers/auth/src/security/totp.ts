import { Secret, TOTP } from "otpauth";
import type { TotpEnrollment } from "../../../../packages/contracts/src/index";
import { importSealingKey, openText, sealText } from "../secret-box";
import type { SecurityEnv } from "./env";

const PERIOD_SECONDS = 30;
const WINDOW = 1;
const ISSUER = "GitEdge";

interface TotpRow {
  secretCiphertext: string;
  secretIv: string;
  confirmedAt: number | null;
  lastCounter: number;
}

export async function totpAvailable(
  env: Pick<SecurityEnv, "TOTP_ENCRYPTION_KEY">
): Promise<boolean> {
  return (await importSealingKey(env.TOTP_ENCRYPTION_KEY)) !== null;
}

function createTotp(secret: Secret, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: PERIOD_SECONDS,
    secret,
  });
}

const ROW_SQL =
  "SELECT secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, confirmed_at AS confirmedAt, last_counter AS lastCounter FROM auth_totp WHERE user_id = ?";

export async function totpConfirmed(
  env: Pick<SecurityEnv, "DB">,
  userId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM auth_totp WHERE user_id = ? AND confirmed_at IS NOT NULL"
  )
    .bind(userId)
    .first();
  return row !== null;
}

/** Starts (or restarts) enrollment; the factor is inactive until a code is confirmed. */
export async function beginTotpEnrollment(
  env: Pick<SecurityEnv, "DB" | "TOTP_ENCRYPTION_KEY">,
  userId: string,
  label: string
): Promise<TotpEnrollment | null> {
  const key = await importSealingKey(env.TOTP_ENCRYPTION_KEY);
  if (!key) return null;
  const secret = new Secret({ size: 20 });
  const sealed = await sealText(key, secret.base32);
  await env.DB.prepare(
    "INSERT INTO auth_totp (user_id, secret_ciphertext, secret_iv, confirmed_at, last_counter, created_at) VALUES (?, ?, ?, NULL, 0, ?) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext = excluded.secret_ciphertext, secret_iv = excluded.secret_iv, confirmed_at = NULL, last_counter = 0, created_at = excluded.created_at WHERE auth_totp.confirmed_at IS NULL"
  )
    .bind(userId, sealed.ciphertext, sealed.iv, Date.now())
    .run();
  return { secret: secret.base32, otpauthUri: createTotp(secret, label).toString() };
}

/**
 * Verifies a code within one step either side and records the matched time step, so a code (or any
 * earlier one) cannot be accepted twice. With `activate` the pending enrollment becomes active.
 */
export async function verifyTotpCode(
  env: Pick<SecurityEnv, "DB" | "TOTP_ENCRYPTION_KEY">,
  userId: string,
  code: string,
  options: { activate?: boolean; now?: number } = {}
): Promise<boolean> {
  const key = await importSealingKey(env.TOTP_ENCRYPTION_KEY);
  if (!key) return false;
  const row = await env.DB.prepare(ROW_SQL).bind(userId).first<TotpRow>();
  if (!row || (row.confirmedAt === null) !== Boolean(options.activate)) return false;
  const now = options.now ?? Date.now();
  let secret: Secret;
  try {
    secret = Secret.fromBase32(
      await openText(key, { ciphertext: row.secretCiphertext, iv: row.secretIv })
    );
  } catch {
    return false;
  }
  const delta = createTotp(secret, userId).validate({
    token: code,
    timestamp: now,
    window: WINDOW,
  });
  if (delta === null) return false;
  const counter = Math.floor(now / 1000 / PERIOD_SECONDS) + delta;
  const updated = await env.DB.prepare(
    options.activate
      ? "UPDATE auth_totp SET last_counter = ?, confirmed_at = ? WHERE user_id = ? AND confirmed_at IS NULL RETURNING user_id"
      : "UPDATE auth_totp SET last_counter = ? WHERE user_id = ? AND confirmed_at IS NOT NULL AND last_counter < ? RETURNING user_id"
  )
    .bind(...(options.activate ? [counter, now, userId] : [counter, userId, counter]))
    .first();
  return updated !== null;
}

export async function removeTotp(env: Pick<SecurityEnv, "DB">, userId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM auth_totp WHERE user_id = ?").bind(userId).run();
}
