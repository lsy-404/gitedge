import { z } from "zod";
import {
  AddPasskeyInputSchema,
  ChangePasswordInputSchema,
  ConfirmTotpInputSchema,
  DisableTotpInputSchema,
  EMAIL_VERIFICATION_TTL_MS,
  RECENT_AUTH_WINDOW_MS,
  ReauthInputSchema,
  RenamePasskeyInputSchema,
  SetEmailInputSchema,
  hasRecentAuth,
  type PasskeyRegistrationOptions,
  type RecoveryCodes,
  type SecondFactorOptions,
  type SecuritySummary,
  type TrustedUser,
} from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse, requireRecentAuth } from "../../../../src/worker/common/http";
import { auditActor, recordAudit, type AuditInput } from "../../../../src/worker/common/audit";
import { createLogger } from "../../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../../src/worker/common/readText";
import { verifyPassword } from "../password";
import { findAccountById, replacePassword } from "./accounts";
import { saveChallenge, takeChallenge } from "./challenges";
import { sendEmail, verificationMessage } from "./email";
import { emailConfigured, publicOrigin, type SecurityEnv } from "./env";
import { secondFactorMethods, verifySecondFactor } from "./factors";
import {
  addPasskey,
  authenticationOptions,
  listPasskeys,
  registrationOptions,
  removePasskey,
  renamePasskey,
} from "./passkeys";
import { limitAttempts } from "./rate-limit";
import { countRecoveryCodes, regenerateRecoveryCodes } from "./recovery-codes";
import { issueOneTimeToken } from "./tokens";
import {
  beginTotpEnrollment,
  removeTotp,
  totpAvailable,
  totpConfirmed,
  verifyTotpCode,
} from "./totp";

export interface HumanSession {
  user: TrustedUser;
  tokenHash: string;
}

function audit(
  env: SecurityEnv,
  session: HumanSession,
  action: AuditInput["action"],
  metadata: AuditInput["metadata"] = {}
): Promise<void> {
  return recordAudit(env, {
    action,
    actor: auditActor(session.user),
    target: { type: "user", id: session.user.id, label: session.user.identifier },
    subjectUserId: session.user.id,
    metadata,
  });
}

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  return parsed.success ? parsed.data : null;
}

/** Sensitive actions require a confirmation within the sudo window. */
function reauthRequired(session: HumanSession): Response | null {
  return requireRecentAuth(session.user);
}

async function summary(env: SecurityEnv, session: HumanSession): Promise<SecuritySummary> {
  const userId = session.user.id;
  const [account, email, passkeys, recoveryCodesRemaining, totp, methods] = await Promise.all([
    findAccountById(env, userId),
    env.DB.prepare("SELECT email, verified_at AS verifiedAt FROM auth_emails WHERE user_id = ?")
      .bind(userId)
      .first<{ email: string; verifiedAt: number | null }>(),
    listPasskeys(env, userId),
    countRecoveryCodes(env, userId),
    totpConfirmed(env, userId),
    secondFactorMethods(env, userId),
  ]);
  const passwordEnabled = account?.passwordEnabled === 1;
  const recentAt = session.user.recentAuthAt;
  const valid = hasRecentAuth(recentAt);
  return {
    passwordEnabled,
    email: email ? { address: email.email, verified: email.verifiedAt !== null } : null,
    emailAvailable: emailConfigured(env),
    totp: { enabled: totp, available: await totpAvailable(env) },
    passkeys,
    recoveryCodesRemaining,
    secondFactorEnabled: methods.length > 0,
    recentAuth: {
      valid,
      expiresAt: valid && recentAt !== undefined ? recentAt + RECENT_AUTH_WINDOW_MS : null,
      methods: [...(passwordEnabled ? (["password"] as const) : []), ...methods],
    },
  };
}

async function reauthenticate(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const body = await readBody(request, ReauthInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid confirmation payload.");
  const limited = await limitAttempts(env.RATE_LIMITER, [[`reauth:${session.user.id}`, 10]]);
  if (limited) return limited;
  const rejected = errorResponse(401, "invalid_credentials", "The confirmation was not accepted.");
  let accepted = false;
  if (body.method === "password") {
    const account = await findAccountById(env, session.user.id);
    accepted =
      account !== null &&
      account.passwordEnabled === 1 &&
      (await verifyPassword(body.password, {
        salt: account.passwordSalt,
        hash: account.passwordHash,
      }));
  } else {
    const challenge =
      body.method === "passkey"
        ? await takeChallenge(env, "passkey_reauth", session.tokenHash)
        : null;
    accepted = await verifySecondFactor(
      env,
      request,
      session.user.id,
      body,
      challenge?.webauthnChallenge ?? null
    );
  }
  if (!accepted) return rejected;
  const now = Date.now();
  await env.DB.prepare("UPDATE auth_sessions SET recent_auth_at = ? WHERE token_hash = ?")
    .bind(now, session.tokenHash)
    .run();
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:reauthenticated", {
    userId: session.user.id,
    method: body.method,
  });
  return dataResponse({ recentAuthAt: now, expiresAt: now + RECENT_AUTH_WINDOW_MS });
}

async function reauthPasskeyOptions(env: SecurityEnv, request: Request, session: HumanSession) {
  const options = await authenticationOptions(env, request, session.user.id, "preferred");
  if (!options.allowCredentials?.length)
    return errorResponse(409, "conflict", "No passkey is registered.");
  await saveChallenge(env, {
    purpose: "passkey_reauth",
    userId: session.user.id,
    webauthnChallenge: options.challenge,
    handle: session.tokenHash,
  });
  const data: SecondFactorOptions = { options };
  return dataResponse(data);
}

async function changePassword(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const body = await readBody(request, ChangePasswordInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid password.");
  const account = await findAccountById(env, session.user.id);
  if (account?.passwordEnabled !== 1)
    return errorResponse(409, "conflict", "This account does not use a password.");
  await replacePassword(env, session.user.id, body.newPassword, session.tokenHash);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:password-changed", {
    userId: session.user.id,
  });
  await audit(env, session, "account.password_changed");
  return dataResponse({ changed: true });
}

async function setEmail(request: Request, env: SecurityEnv, session: HumanSession) {
  const required = reauthRequired(session);
  if (required) return required;
  if (!emailConfigured(env))
    return errorResponse(503, "service_unavailable", "Email is not configured.");
  const body = await readBody(request, SetEmailInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid email.");
  const email = body.email.toLowerCase();
  const limited = await limitAttempts(env.RATE_LIMITER, [[`email-verify:${session.user.id}`, 5]]);
  if (limited) return limited;
  const taken = await env.DB.prepare(
    "SELECT user_id FROM auth_emails WHERE email = ? AND verified_at IS NOT NULL AND user_id <> ?"
  )
    .bind(email, session.user.id)
    .first();
  // Links sent to the previous address stop working once it is replaced.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO auth_emails (user_id, email, verified_at, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified_at = NULL, created_at = excluded.created_at"
    ).bind(session.user.id, email, Date.now()),
    env.DB.prepare("DELETE FROM auth_one_time_tokens WHERE user_id = ?").bind(session.user.id),
  ]);
  // Addresses verified elsewhere get no message, so the response never discloses another account.
  if (!taken) {
    const token = await issueOneTimeToken(env, {
      userId: session.user.id,
      purpose: "verify_email",
      email,
      ttlMs: EMAIL_VERIFICATION_TTL_MS,
    });
    const link = `${publicOrigin(env, request)}/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmail(env, { to: email, ...verificationMessage(link) });
  }
  return dataResponse({ sent: true }, 202);
}

async function removeEmail(env: SecurityEnv, session: HumanSession): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_emails WHERE user_id = ?").bind(session.user.id),
    env.DB.prepare("DELETE FROM auth_one_time_tokens WHERE user_id = ?").bind(session.user.id),
  ]);
  return dataResponse({ removed: true });
}

async function ensureRecoveryCodes(
  env: SecurityEnv,
  userId: string
): Promise<string[] | undefined> {
  return (await countRecoveryCodes(env, userId)) === 0
    ? regenerateRecoveryCodes(env, userId)
    : undefined;
}

async function enrollTotp(env: SecurityEnv, session: HumanSession): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  if (await totpConfirmed(env, session.user.id))
    return errorResponse(409, "conflict", "Authenticator app is already enabled.");
  const enrollment = await beginTotpEnrollment(env, session.user.id, session.user.identifier);
  if (!enrollment)
    return errorResponse(503, "service_unavailable", "Authenticator apps are not configured.");
  return dataResponse(enrollment);
}

async function confirmTotp(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const body = await readBody(request, ConfirmTotpInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid code.");
  const limited = await limitAttempts(env.RATE_LIMITER, [[`totp-confirm:${session.user.id}`, 10]]);
  if (limited) return limited;
  if (!(await verifyTotpCode(env, session.user.id, body.code, { activate: true })))
    return errorResponse(400, "invalid_code", "The code was not accepted.");
  const recoveryCodes = await ensureRecoveryCodes(env, session.user.id);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:totp-enabled", {
    userId: session.user.id,
  });
  await audit(env, session, "two_factor.totp_enabled");
  return dataResponse({ enabled: true, ...(recoveryCodes ? { recoveryCodes } : {}) });
}

async function disableTotp(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const body = await readBody(request, DisableTotpInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid payload.");
  const limited = await limitAttempts(env.RATE_LIMITER, [[`totp-disable:${session.user.id}`, 10]]);
  if (limited) return limited;
  const account = await findAccountById(env, session.user.id);
  const passwordOk =
    account?.passwordEnabled !== 1 ||
    (body.password !== undefined &&
      (await verifyPassword(body.password, {
        salt: account.passwordSalt,
        hash: account.passwordHash,
      })));
  if (!passwordOk || !(await verifyTotpCode(env, session.user.id, body.code)))
    return errorResponse(401, "invalid_credentials", "The confirmation was not accepted.");
  await removeTotp(env, session.user.id);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:totp-disabled", {
    userId: session.user.id,
  });
  await audit(env, session, "two_factor.totp_disabled");
  return dataResponse({ enabled: false });
}

async function regenerateCodes(env: SecurityEnv, session: HumanSession): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const data: RecoveryCodes = {
    recoveryCodes: await regenerateRecoveryCodes(env, session.user.id),
  };
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:recovery-codes-regenerated", {
    userId: session.user.id,
  });
  await audit(env, session, "two_factor.recovery_codes_regenerated");
  return dataResponse(data);
}

async function passkeyRegistrationOptions(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const options = await registrationOptions(env, request, session.user);
  if (options === "limit")
    return errorResponse(409, "conflict", "Too many passkeys are registered.");
  await saveChallenge(env, {
    purpose: "passkey_register",
    userId: session.user.id,
    webauthnChallenge: options.challenge,
    handle: session.user.id,
  });
  const data: PasskeyRegistrationOptions = { options };
  return dataResponse(data);
}

async function registerPasskey(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response> {
  const required = reauthRequired(session);
  if (required) return required;
  const body = await readBody(request, AddPasskeyInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid passkey payload.");
  const challenge = await takeChallenge(env, "passkey_register", session.user.id);
  if (!challenge?.webauthnChallenge)
    return errorResponse(400, "invalid_code", "The passkey request expired.");
  const passkey = await addPasskey(env, request, session.user, {
    name: body.name,
    response: body.response,
    expectedChallenge: challenge.webauthnChallenge,
  });
  if (!passkey) return errorResponse(400, "invalid_code", "The passkey could not be verified.");
  const recoveryCodes = await ensureRecoveryCodes(env, session.user.id);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:passkey-added", {
    userId: session.user.id,
  });
  await audit(env, session, "two_factor.passkey_added", { name: body.name });
  return dataResponse({ passkey, ...(recoveryCodes ? { recoveryCodes } : {}) }, 201);
}

/** Authenticated account-security routes. Returns null for paths outside this module. */
export async function handleAccountSecurity(
  request: Request,
  env: SecurityEnv,
  session: HumanSession
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (method === "GET" && path === "/security") return dataResponse(await summary(env, session));
  if (method === "POST" && path === "/reauth") return reauthenticate(request, env, session);
  if (method === "POST" && path === "/reauth/passkey/options")
    return reauthPasskeyOptions(env, request, session);
  if (method === "POST" && path === "/security/password")
    return changePassword(request, env, session);
  if (method === "PUT" && path === "/security/email") return setEmail(request, env, session);
  if (method === "DELETE" && path === "/security/email") return removeEmail(env, session);
  if (method === "POST" && path === "/security/totp") return enrollTotp(env, session);
  if (method === "POST" && path === "/security/totp/confirm")
    return confirmTotp(request, env, session);
  if (method === "POST" && path === "/security/totp/disable")
    return disableTotp(request, env, session);
  if (method === "POST" && path === "/security/recovery-codes")
    return regenerateCodes(env, session);
  if (method === "POST" && path === "/security/passkeys/options")
    return passkeyRegistrationOptions(request, env, session);
  if (method === "POST" && path === "/security/passkeys")
    return registerPasskey(request, env, session);
  const passkey = /^\/security\/passkeys\/([A-Za-z0-9_-]{1,512})$/.exec(path);
  if (passkey && method === "PATCH") {
    const body = await readBody(request, RenamePasskeyInputSchema);
    if (!body) return errorResponse(400, "bad_request", "Invalid name.");
    return (await renamePasskey(env, session.user.id, passkey[1], body.name))
      ? dataResponse({ renamed: true })
      : errorResponse(404, "not_found", "Passkey was not found.");
  }
  if (passkey && method === "DELETE") {
    const required = reauthRequired(session);
    if (required) return required;
    if (!(await removePasskey(env, session.user.id, passkey[1])))
      return errorResponse(404, "not_found", "Passkey was not found.");
    await audit(env, session, "two_factor.passkey_removed");
    return dataResponse({ removed: true });
  }
  return null;
}
