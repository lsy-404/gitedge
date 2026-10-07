import type { AuthEnv } from "./index";
import { dataResponse as json, errorResponse as fail } from "../../../src/worker/common/http";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import {
  AddSigningKeyInputSchema,
  SigningKeyChallengeInputSchema,
  type SigningKey,
  type SigningKeyChallenge,
} from "../../../packages/contracts/src/signatures";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { inspectSigningKey, verifyDetachedSignature } from "../../../src/worker/common/signatures";
import { createLogger } from "../../../src/worker/common/logger";

type SigningEnvironment = Pick<AuthEnv, "DB" | "LOG_LEVEL">;
interface KeyRow {
  id: string;
  title: string;
  fingerprint: string;
  keyIdsJson: string;
  publicKey: string;
  createdAt: number;
  revokedAt: number | null;
}
interface ChallengeRow extends SigningKeyChallenge {
  title: string;
  publicKey: string;
}
const keyColumns =
  "id, title, fingerprint, key_ids_json AS keyIdsJson, public_key AS publicKey, created_at AS createdAt, revoked_at AS revokedAt";
function present(row: KeyRow): SigningKey {
  const ids: unknown = JSON.parse(row.keyIdsJson);
  return {
    id: row.id,
    title: row.title,
    fingerprint: row.fingerprint,
    keyIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
    publicKey: row.publicKey,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}
export async function handleSigningKeys(
  request: Request,
  env: SigningEnvironment,
  user: TrustedUser
): Promise<Response> {
  if (user.agentSession || request.headers.has("Authorization"))
    return fail(403, "forbidden", "A human browser session is required.");
  const path = new URL(request.url).pathname;
  const logger = createLogger(env.LOG_LEVEL, { service: "signing-keys" });
  if (path === "/signing-keys" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT ${keyColumns} FROM auth_signing_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
    )
      .bind(user.id)
      .all<KeyRow>();
    return json(rows.results.map(present));
  }
  if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
    return fail(403, "forbidden", "Same-origin key management is required.");
  if (path === "/signing-keys/challenges" && request.method === "POST") {
    const parsed = SigningKeyChallengeInputSchema.safeParse(
      await readJsonLimited(request, SMALL_JSON_BYTES)
    );
    if (!parsed.success) return fail(400, "bad_request", "Invalid signing key.");
    let key;
    try {
      key = await inspectSigningKey(parsed.data.publicKey);
    } catch {
      return fail(400, "bad_request", "A valid, unexpired OpenPGP public signing key is required.");
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM auth_signing_keys WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ total: number }>();
    if ((count?.total ?? 0) >= 100) return fail(409, "key_limit", "Signing key limit reached.");
    const duplicate = await env.DB.prepare("SELECT id FROM auth_signing_keys WHERE fingerprint = ?")
      .bind(key.fingerprint)
      .first();
    if (duplicate) return fail(409, "conflict", "This signing key is already registered.");
    const now = Date.now();
    const id = crypto.randomUUID();
    const payload = `GitEdge signing key ownership\nOrigin: ${new URL(request.url).origin}\nAccount: ${user.id}\nFingerprint: ${key.fingerprint}\nChallenge: ${id}\nExpires: ${now + 600_000}\n`;
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM auth_signing_key_challenges WHERE user_id = ? OR expires_at <= ?"
      ).bind(user.id, now),
      env.DB.prepare(
        "INSERT INTO auth_signing_key_challenges (id,user_id,title,fingerprint,public_key,payload,expires_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(
        id,
        user.id,
        parsed.data.title,
        key.fingerprint,
        key.publicKey,
        payload,
        now + 600_000
      ),
    ]);
    logger.info("signing-key:challenge-created", { fingerprint: key.fingerprint });
    return json(
      {
        id,
        fingerprint: key.fingerprint,
        payload,
        expiresAt: now + 600_000,
      } satisfies SigningKeyChallenge,
      201
    );
  }
  if (path === "/signing-keys" && request.method === "POST") {
    const parsed = AddSigningKeyInputSchema.safeParse(
      await readJsonLimited(request, SMALL_JSON_BYTES)
    );
    if (!parsed.success) return fail(400, "bad_request", "Invalid signing proof.");
    const challenge = await env.DB.prepare(
      "SELECT id,title,fingerprint,public_key AS publicKey,payload,expires_at AS expiresAt FROM auth_signing_key_challenges WHERE id = ? AND user_id = ? AND expires_at > ?"
    )
      .bind(parsed.data.challengeId, user.id, Date.now())
      .first<ChallengeRow>();
    if (!challenge) return fail(409, "challenge_expired", "Create a new signing challenge.");
    if (
      !(await verifyDetachedSignature(
        challenge.publicKey,
        parsed.data.signature,
        challenge.payload
      ))
    )
      return fail(400, "invalid_signature", "The signature does not prove ownership of this key.");
    const key = await inspectSigningKey(challenge.publicKey);
    const id = crypto.randomUUID(),
      now = Date.now();
    try {
      const inserted = await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO auth_signing_keys (id,user_id,title,fingerprint,key_ids_json,public_key,created_at) SELECT ?,user_id,title,fingerprint,?,public_key,? FROM auth_signing_key_challenges WHERE id = ? AND user_id = ? AND expires_at > ? RETURNING id"
        ).bind(id, JSON.stringify(key.keyIds), now, challenge.id, user.id, now),
        ...key.keyIds.map((keyId) =>
          env.DB.prepare(
            "INSERT INTO auth_signing_key_ids (key_id,signing_key_id) SELECT ?,id FROM auth_signing_keys WHERE id = ?"
          ).bind(keyId, id)
        ),
        env.DB.prepare("DELETE FROM auth_signing_key_challenges WHERE id = ? AND user_id = ?").bind(
          challenge.id,
          user.id
        ),
      ]);
      if (!inserted[0].results.length)
        return fail(409, "challenge_expired", "The signing challenge was already used.");
    } catch {
      logger.warn("signing-key:registration-conflict", { fingerprint: key.fingerprint });
      return fail(409, "conflict", "This signing key is already registered.");
    }
    logger.info("signing-key:registered", { keyId: id, fingerprint: key.fingerprint });
    return json(
      { id, title: challenge.title, ...key, createdAt: now, revokedAt: null } satisfies SigningKey,
      201
    );
  }
  const match = /^\/signing-keys\/([^/]+)$/.exec(path);
  if (match && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE auth_signing_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ? RETURNING id"
    )
      .bind(Date.now(), match[1], user.id)
      .first();
    if (!result) return fail(404, "not_found", "Signing key was not found.");
    logger.info("signing-key:revoked", { keyId: match[1] });
    return json({ revoked: true });
  }
  return fail(405, "method_not_allowed", "Method is not allowed.");
}
