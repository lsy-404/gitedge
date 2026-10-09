import { timingSafeEqual } from "node:crypto";
import { base64ToBytes, bytesToBase64 } from "../../../src/worker/common/encoding";

export const PBKDF2_ITERATIONS = 100_000;

export async function derivePasswordHash(
  password: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function createPasswordCredential(
  password: string
): Promise<{ salt: string; hash: string }> {
  const salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToBase64(salt), hash: await derivePasswordHash(password, salt) };
}

export async function verifyPassword(
  password: string,
  stored: { salt: string; hash: string }
): Promise<boolean> {
  try {
    const derived = await derivePasswordHash(password, base64ToBytes(stored.salt));
    return timingSafeEqual(base64ToBytes(derived), base64ToBytes(stored.hash));
  } catch {
    // A malformed stored credential must not reveal a distinct authentication outcome.
    return false;
  }
}

const UNMATCHED_CREDENTIAL = {
  salt: bytesToBase64(new Uint8Array(16)),
  hash: bytesToBase64(new Uint8Array(32)),
};

/** Spends the same derivation cost as a real check so a missing account is not distinguishable by timing. */
export async function rejectPassword(password: string): Promise<false> {
  await verifyPassword(password, UNMATCHED_CREDENTIAL);
  return false;
}
