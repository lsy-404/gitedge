import { RECOVERY_CODE_COUNT } from "../../../../packages/contracts/src/index";
import { hashToken } from "../session";
import type { SecurityEnv } from "./env";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 10;

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  const chars = Array.from(bytes, (byte) => ALPHABET[byte & 31]);
  return `${chars.slice(0, 5).join("")}-${chars.slice(5).join("")}`;
}

function normalize(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function codeHash(userId: string, code: string): Promise<string> {
  return hashToken(`recovery:${userId}:${normalize(code)}`);
}

/** Replaces all existing codes with a fresh set. Plaintext is returned once and never stored. */
export async function regenerateRecoveryCodes(
  env: Pick<SecurityEnv, "DB">,
  userId: string
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, randomCode);
  const now = Date.now();
  const inserts = await Promise.all(
    codes.map(async (code) =>
      env.DB.prepare(
        "INSERT INTO auth_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), userId, await codeHash(userId, code), now)
    )
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_recovery_codes WHERE user_id = ?").bind(userId),
    ...inserts,
  ]);
  return codes;
}

/** Spends a recovery code; returns false when it is unknown or already used. */
export async function consumeRecoveryCode(
  env: Pick<SecurityEnv, "DB">,
  userId: string,
  code: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE auth_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING id"
  )
    .bind(Date.now(), userId, await codeHash(userId, code))
    .first<{ id: string }>();
  return row !== null;
}

export async function countRecoveryCodes(
  env: Pick<SecurityEnv, "DB">,
  userId: string
): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS remaining FROM auth_recovery_codes WHERE user_id = ? AND used_at IS NULL"
  )
    .bind(userId)
    .first<{ remaining: number }>();
  return row?.remaining ?? 0;
}
