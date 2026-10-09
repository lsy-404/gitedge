import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeySummary } from "../../../../packages/contracts/src/index";
import { base64UrlToBytes, bytesToBase64Url } from "../../../../src/worker/common/encoding";
import { createLogger } from "../../../../src/worker/common/logger";
import { publicOrigin, relyingPartyId, type SecurityEnv } from "./env";

const RP_NAME = "GitEdge";
const MAX_PASSKEYS = 20;

interface PasskeyRow {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string;
}

const PASSKEY_COLUMNS =
  "id, user_id AS userId, public_key AS publicKey, counter, transports FROM auth_passkeys";

function parseTransports(value: string): AuthenticatorTransport[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AuthenticatorTransport => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export async function listPasskeys(
  env: Pick<SecurityEnv, "DB">,
  userId: string
): Promise<PasskeySummary[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, backed_up AS backedUp FROM auth_passkeys WHERE user_id = ? ORDER BY created_at LIMIT ?"
  )
    .bind(userId, MAX_PASSKEYS)
    .all<Omit<PasskeySummary, "backedUp"> & { backedUp: number }>();
  return rows.results.map((row) => ({ ...row, backedUp: row.backedUp === 1 }));
}

export async function countPasskeys(env: Pick<SecurityEnv, "DB">, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM auth_passkeys WHERE user_id = ?")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function registrationOptions(
  env: SecurityEnv,
  request: Request,
  user: { id: string; identifier: string }
): Promise<PublicKeyCredentialCreationOptionsJSON | "limit"> {
  if ((await countPasskeys(env, user.id)) >= MAX_PASSKEYS) return "limit";
  const existing = await env.DB.prepare(`SELECT ${PASSKEY_COLUMNS} WHERE user_id = ? LIMIT ?`)
    .bind(user.id, MAX_PASSKEYS)
    .all<PasskeyRow>();
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: relyingPartyId(env, request),
    userName: user.identifier,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.results.map((row) => ({
      id: row.id,
      transports: parseTransports(row.transports),
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
}

export async function addPasskey(
  env: SecurityEnv,
  request: Request,
  user: { id: string },
  input: { name: string; response: RegistrationResponseJSON; expectedChallenge: string }
): Promise<PasskeySummary | null> {
  try {
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: publicOrigin(env, request),
      expectedRPID: relyingPartyId(env, request),
      requireUserVerification: false,
    });
    if (!verification.verified) return null;
    const { credential, credentialBackedUp } = verification.registrationInfo;
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO auth_passkeys (id, user_id, name, public_key, counter, transports, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        credential.id,
        user.id,
        input.name,
        bytesToBase64Url(credential.publicKey),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        credentialBackedUp ? 1 : 0,
        now
      )
      .run();
    return {
      id: credential.id,
      name: input.name,
      createdAt: now,
      lastUsedAt: null,
      backedUp: credentialBackedUp,
    };
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("passkey:registration-rejected", {
      userId: user.id,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return null;
  }
}

/** Options for a prompt scoped to the user's passkeys, or discoverable when no user is given. */
export async function authenticationOptions(
  env: SecurityEnv,
  request: Request,
  userId: string | null,
  userVerification: "required" | "preferred"
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const credentials = userId
    ? (
        await env.DB.prepare(`SELECT ${PASSKEY_COLUMNS} WHERE user_id = ? LIMIT ?`)
          .bind(userId, MAX_PASSKEYS)
          .all<PasskeyRow>()
      ).results.map((row) => ({ id: row.id, transports: parseTransports(row.transports) }))
    : undefined;
  return generateAuthenticationOptions({
    rpID: relyingPartyId(env, request),
    userVerification,
    ...(credentials ? { allowCredentials: credentials } : {}),
  });
}

/**
 * Verifies an assertion and advances the signature counter. Returns the owning user id, or null.
 * `expectedUserId` restricts the credential to one user (second factor and re-authentication).
 */
export async function verifyAssertion(
  env: SecurityEnv,
  request: Request,
  input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    expectedUserId: string | null;
    requireUserVerification: boolean;
  }
): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT ${PASSKEY_COLUMNS} WHERE id = ?`)
    .bind(input.response.id)
    .first<PasskeyRow>();
  if (!row || (input.expectedUserId !== null && row.userId !== input.expectedUserId)) return null;
  try {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: publicOrigin(env, request),
      expectedRPID: relyingPartyId(env, request),
      requireUserVerification: input.requireUserVerification,
      credential: {
        id: row.id,
        publicKey: base64UrlToBytes(row.publicKey),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
    });
    if (!verification.verified) return null;
    // Compare-and-set on the counter that was verified, so concurrent assertions cannot both advance it.
    const updated = await env.DB.prepare(
      "UPDATE auth_passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ? RETURNING id"
    )
      .bind(verification.authenticationInfo.newCounter, Date.now(), row.id, row.counter)
      .first();
    return updated ? row.userId : null;
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("passkey:assertion-rejected", {
      userId: row.userId,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return null;
  }
}

export async function renamePasskey(
  env: Pick<SecurityEnv, "DB">,
  userId: string,
  id: string,
  name: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "UPDATE auth_passkeys SET name = ? WHERE id = ? AND user_id = ? RETURNING id"
  )
    .bind(name, id, userId)
    .first();
  return row !== null;
}

export async function removePasskey(
  env: Pick<SecurityEnv, "DB">,
  userId: string,
  id: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "DELETE FROM auth_passkeys WHERE id = ? AND user_id = ? RETURNING id"
  )
    .bind(id, userId)
    .first();
  return row !== null;
}
