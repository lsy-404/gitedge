import { z } from "zod";
import {
  CompleteLoginSchema,
  EmailResetConfirmSchema,
  EmailResetRequestSchema,
  MfaTokenSchema,
  PASSWORD_RESET_TTL_MS,
  PasskeyLoginInputSchema,
  RecoveryPasswordResetSchema,
  TokenInputSchema,
  type PasskeyAuthenticationOptions,
  type RecoveryOptions,
  type SecondFactorOptions,
} from "../../../../packages/contracts/src/index";
import { dataResponse, errorResponse } from "../../../../src/worker/common/http";
import { createLogger } from "../../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../../src/worker/common/readText";
import { rememberBrowserLogin } from "../browser-accounts";
import { hashToken, issueSession } from "../session";
import { findAccountById, findAccountByIdentifier, replacePassword } from "./accounts";
import {
  attemptSecondFactorChallenge,
  peekSecondFactorChallenge,
  saveChallenge,
  setSecondFactorPasskeyChallenge,
  takeChallenge,
} from "./challenges";
import { resetMessage, sendEmail } from "./email";
import { emailConfigured, publicOrigin, type SecurityEnv } from "./env";
import { secondFactorMethods, verifySecondFactor } from "./factors";
import { authenticationOptions, verifyAssertion } from "./passkeys";
import { clientAddress, limitAttempts } from "./rate-limit";
import { consumeRecoveryCode } from "./recovery-codes";
import { consumeOneTimeToken, issueOneTimeToken, peekOneTimeToken } from "./tokens";
import { verifyTotpCode } from "./totp";

const INVALID_SIGN_IN = "Invalid or expired sign-in.";
const SECOND_FACTOR_ATTEMPTS_PER_MINUTE = 5;

function secondFactorKey(userId: string): string {
  return `second-factor:${userId}`;
}

async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  return parsed.success ? parsed.data : null;
}

async function signedIn(request: Request, env: SecurityEnv, userId: string): Promise<Response> {
  const account = await findAccountById(env, userId);
  if (!account) return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  const token = await issueSession(env, account.id);
  if (!token) return errorResponse(403, "account_disabled", "This account is disabled.");
  return rememberBrowserLogin(
    request,
    env,
    account.id,
    token,
    dataResponse({ id: account.id, identifier: account.identifier, groupKey: account.groupKey })
  );
}

async function completeSecondFactor(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, CompleteLoginSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid sign-in payload.");
  const pending = await attemptSecondFactorChallenge(env, body.mfaToken);
  if (!pending) return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
  // Fresh password sign-ins each grant new attempts, so codes are also limited per account.
  const limited = await limitAttempts(env.RATE_LIMITER, [
    [secondFactorKey(pending.userId), SECOND_FACTOR_ATTEMPTS_PER_MINUTE],
  ]);
  if (limited) {
    logger.warn("auth:second-factor-rate-limited", { userId: pending.userId });
    return limited;
  }
  const accepted = await verifySecondFactor(
    env,
    request,
    pending.userId,
    body.factor,
    pending.webauthnChallenge
  );
  if (!accepted) {
    logger.warn("auth:second-factor-rejected", {
      userId: pending.userId,
      method: body.factor.method,
    });
    return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  }
  if (!(await takeChallenge(env, "login_second_factor", body.mfaToken)))
    return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  logger.info("auth:second-factor-accepted", {
    userId: pending.userId,
    method: body.factor.method,
  });
  return signedIn(request, env, pending.userId);
}

async function secondFactorOptions(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, MfaTokenSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid sign-in payload.");
  const userId = await peekSecondFactorChallenge(env, body.mfaToken);
  if (!userId || !(await secondFactorMethods(env, userId)).includes("passkey"))
    return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  const options = await authenticationOptions(env, request, userId, "preferred");
  await setSecondFactorPasskeyChallenge(env, body.mfaToken, options.challenge);
  const data: SecondFactorOptions = { options };
  return dataResponse(data);
}

async function passkeyLoginOptions(request: Request, env: SecurityEnv): Promise<Response> {
  const limited = await limitAttempts(env.RATE_LIMITER, [
    [`passkey-login:${clientAddress(request)}`, 30],
  ]);
  if (limited) return limited;
  const options = await authenticationOptions(env, request, null, "required");
  const challengeId = await saveChallenge(env, {
    purpose: "passkey_login",
    userId: null,
    webauthnChallenge: options.challenge,
  });
  const data: PasskeyAuthenticationOptions = { challengeId, options };
  return dataResponse(data);
}

async function passkeyLogin(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, PasskeyLoginInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid sign-in payload.");
  const challenge = await takeChallenge(env, "passkey_login", body.challengeId);
  if (!challenge?.webauthnChallenge) return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  const userId = await verifyAssertion(env, request, {
    response: body.response,
    expectedChallenge: challenge.webauthnChallenge,
    expectedUserId: null,
    requireUserVerification: true,
  });
  if (!userId) return errorResponse(401, "unauthorized", INVALID_SIGN_IN);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:passkey-login", { userId });
  return signedIn(request, env, userId);
}

const INVALID_RECOVERY = "Invalid username or recovery code.";

async function resetWithRecoveryCode(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, RecoveryPasswordResetSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid recovery payload.");
  const limited = await limitAttempts(env.RATE_LIMITER, [
    [`recovery:ip:${clientAddress(request)}`, 20],
    [`recovery:${body.identifier.toLowerCase()}`, 5],
  ]);
  if (limited) return limited;
  const account = await findAccountByIdentifier(env, body.identifier);
  const eligible = account !== null && account.passwordEnabled === 1;
  // The lookup runs for unknown accounts too, so both outcomes take the same path.
  const consumed = await consumeRecoveryCode(env, eligible ? account.id : "", body.recoveryCode);
  if (!eligible || !consumed) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("auth:recovery-rejected");
    return errorResponse(401, "unauthorized", INVALID_RECOVERY);
  }
  await replacePassword(env, account.id, body.newPassword, null);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:password-reset", {
    userId: account.id,
    via: "recovery-code",
  });
  return dataResponse({ reset: true });
}

async function requestEmailReset(
  request: Request,
  env: SecurityEnv,
  defer: (work: Promise<void>) => void
): Promise<Response> {
  if (!emailConfigured(env))
    return errorResponse(503, "service_unavailable", "Email reset is not available.");
  const body = await readBody(request, EmailResetRequestSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid email.");
  const email = body.email.toLowerCase();
  const limited = await limitAttempts(env.RATE_LIMITER, [
    [`recovery-email:ip:${clientAddress(request)}`, 10],
    [`recovery-email:${email}`, 3],
  ]);
  if (limited) return limited;
  const origin = publicOrigin(env, request);
  // The response is identical whether or not the address belongs to an account.
  defer(
    (async () => {
      const row = await env.DB.prepare(
        "SELECT users.id AS userId FROM auth_emails JOIN users ON users.id = auth_emails.user_id WHERE auth_emails.email = ? AND auth_emails.verified_at IS NOT NULL AND users.password_auth_enabled = 1"
      )
        .bind(email)
        .first<{ userId: string }>();
      if (!row) return;
      const token = await issueOneTimeToken(env, {
        userId: row.userId,
        purpose: "reset_password",
        email,
        ttlMs: PASSWORD_RESET_TTL_MS,
      });
      const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
      await sendEmail(env, { to: email, ...resetMessage(link) });
    })().catch((cause: unknown) => {
      createLogger(env.LOG_LEVEL, { service: "auth" }).error("auth:reset-email-failed", {
        reason: cause instanceof Error ? cause.name : "unknown",
      });
    })
  );
  return dataResponse({ sent: true }, 202);
}

async function confirmEmailReset(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, EmailResetConfirmSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid reset payload.");
  const invalid = errorResponse(400, "invalid_token", "This reset link is invalid or has expired.");
  const limited = await limitAttempts(env.RATE_LIMITER, [
    [`recovery-confirm:${await hashToken(body.token)}`, 5],
  ]);
  if (limited) return limited;
  const subject = await peekOneTimeToken(env, body.token, "reset_password");
  if (!subject) return invalid;
  const methods = await secondFactorMethods(env, subject.userId);
  if (methods.length > 0) {
    if (!body.factor)
      return errorResponse(401, "second_factor_required", "A second factor is required.");
    const factorLimited = await limitAttempts(env.RATE_LIMITER, [
      [secondFactorKey(subject.userId), SECOND_FACTOR_ATTEMPTS_PER_MINUTE],
    ]);
    if (factorLimited) return factorLimited;
    const accepted =
      body.factor.method === "totp"
        ? await verifyTotpCode(env, subject.userId, body.factor.code)
        : await consumeRecoveryCode(env, subject.userId, body.factor.code);
    if (!accepted) return errorResponse(401, "unauthorized", "Second factor was not accepted.");
  }
  if (!(await consumeOneTimeToken(env, body.token, "reset_password"))) return invalid;
  await replacePassword(env, subject.userId, body.newPassword, null);
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:password-reset", {
    userId: subject.userId,
    via: "email",
  });
  return dataResponse({ reset: true });
}

async function verifyEmail(request: Request, env: SecurityEnv): Promise<Response> {
  const body = await readBody(request, TokenInputSchema);
  if (!body) return errorResponse(400, "bad_request", "Invalid verification payload.");
  const invalid = errorResponse(
    400,
    "invalid_token",
    "This verification link is invalid or has expired."
  );
  const subject = await consumeOneTimeToken(env, body.token, "verify_email");
  if (!subject) return invalid;
  try {
    const updated = await env.DB.prepare(
      "UPDATE auth_emails SET verified_at = ? WHERE user_id = ? AND email = ? AND verified_at IS NULL RETURNING user_id"
    )
      .bind(Date.now(), subject.userId, subject.email)
      .first();
    if (!updated) return invalid;
  } catch (cause) {
    // Another account verified this address first.
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("account:email-verify-conflict", {
      userId: subject.userId,
      reason: cause instanceof Error ? cause.name : "unknown",
    });
    return invalid;
  }
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:email-verified", {
    userId: subject.userId,
  });
  return dataResponse({ verified: true });
}

/** Routes that need no session: second-factor sign-in, passkey sign-in, password recovery and email verification. */
export async function handlePublicSecurity(
  request: Request,
  env: SecurityEnv,
  defer: (work: Promise<void>) => void
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/recovery/options") {
    const data: RecoveryOptions = { emailReset: emailConfigured(env) };
    return dataResponse(data);
  }
  if (request.method !== "POST") return null;
  switch (path) {
    case "/login/second-factor":
      return completeSecondFactor(request, env);
    case "/login/second-factor/options":
      return secondFactorOptions(request, env);
    case "/login/passkey/options":
      return passkeyLoginOptions(request, env);
    case "/login/passkey":
      return passkeyLogin(request, env);
    case "/recovery/password":
      return resetWithRecoveryCode(request, env);
    case "/recovery/email":
      return requestEmailReset(request, env, defer);
    case "/recovery/email/confirm":
      return confirmEmailReset(request, env);
    case "/email/verify":
      return verifyEmail(request, env);
    default:
      return null;
  }
}
