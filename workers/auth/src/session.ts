import { bytesToBase64 } from "../../../src/worker/common/encoding";
const SESSION_COOKIE = "gitedge_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
export function createSessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function readCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const entry = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

/** Returns null when the account is disabled or deleted. */
export async function issueSession(
  env: { DB: D1Database },
  userId: string
): Promise<string | null> {
  const token = createToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT INTO auth_sessions (id, token_hash, user_id, expires_at, created_at, recent_auth_at) SELECT ?, ?, id, ?, ?, ? FROM users WHERE id = ? AND disabled_at IS NULL"
  )
    .bind(id, await hashToken(token), now + SESSION_MAX_AGE_SECONDS * 1000, now, now, userId)
    .run();
  return inserted.meta.changes === 1 ? token : null;
}

export async function hashToken(token: string): Promise<string> {
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  );
}

export function createToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
