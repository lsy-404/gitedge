import { createPasswordCredential } from "../password";
import type { SecurityEnv } from "./env";

export interface AccountRow {
  id: string;
  identifier: string;
  groupKey: string;
  passwordSalt: string;
  passwordHash: string;
  passwordEnabled: number;
}

const ACCOUNT_SQL =
  "SELECT id, identifier, group_key AS groupKey, password_salt AS passwordSalt, password_hash AS passwordHash, password_auth_enabled AS passwordEnabled FROM users";

export function findAccountById(
  env: Pick<SecurityEnv, "DB">,
  id: string
): Promise<AccountRow | null> {
  return env.DB.prepare(`${ACCOUNT_SQL} WHERE id = ?`).bind(id).first<AccountRow>();
}

export function findAccountByIdentifier(
  env: Pick<SecurityEnv, "DB">,
  identifier: string
): Promise<AccountRow | null> {
  return env.DB.prepare(`${ACCOUNT_SQL} WHERE identifier = ?`)
    .bind(identifier.toLowerCase())
    .first<AccountRow>();
}

/**
 * Replaces the password and revokes every session except `keepTokenHash` (none when null), plus any
 * outstanding reset links.
 */
export async function replacePassword(
  env: Pick<SecurityEnv, "DB">,
  userId: string,
  password: string,
  keepTokenHash: string | null
): Promise<void> {
  const credential = await createPasswordCredential(password);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?").bind(
      credential.salt,
      credential.hash,
      userId
    ),
    env.DB.prepare(
      "DELETE FROM auth_sessions WHERE user_id = ? AND (? IS NULL OR token_hash <> ?)"
    ).bind(userId, keepTokenHash, keepTokenHash),
    env.DB.prepare(
      "DELETE FROM auth_one_time_tokens WHERE user_id = ? AND purpose = 'reset_password'"
    ).bind(userId),
  ]);
}
