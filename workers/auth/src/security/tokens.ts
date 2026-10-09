import { hashToken, createToken } from "../session";
import type { SecurityEnv } from "./env";

export type OneTimePurpose = "verify_email" | "reset_password";

export interface OneTimeTokenSubject {
  userId: string;
  email: string;
}

/** Issues a single-use token for the user and purpose, replacing any earlier one. */
export async function issueOneTimeToken(
  env: Pick<SecurityEnv, "DB">,
  subject: OneTimeTokenSubject & { purpose: OneTimePurpose; ttlMs: number }
): Promise<string> {
  const token = createToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM auth_one_time_tokens WHERE expires_at <= ? OR (user_id = ? AND purpose = ?)"
    ).bind(now, subject.userId, subject.purpose),
    env.DB.prepare(
      "INSERT INTO auth_one_time_tokens (token_hash, user_id, purpose, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(
      await hashToken(token),
      subject.userId,
      subject.purpose,
      subject.email,
      now + subject.ttlMs,
      now
    ),
  ]);
  return token;
}

export async function peekOneTimeToken(
  env: Pick<SecurityEnv, "DB">,
  token: string,
  purpose: OneTimePurpose
): Promise<OneTimeTokenSubject | null> {
  return env.DB.prepare(
    "SELECT user_id AS userId, email FROM auth_one_time_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?"
  )
    .bind(await hashToken(token), purpose, Date.now())
    .first<OneTimeTokenSubject>();
}

/** Atomically spends the token; a second call with the same token returns null. */
export async function consumeOneTimeToken(
  env: Pick<SecurityEnv, "DB">,
  token: string,
  purpose: OneTimePurpose
): Promise<OneTimeTokenSubject | null> {
  return env.DB.prepare(
    "DELETE FROM auth_one_time_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id AS userId, email"
  )
    .bind(await hashToken(token), purpose, Date.now())
    .first<OneTimeTokenSubject>();
}
