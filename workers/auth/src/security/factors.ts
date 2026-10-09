import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type {
  LoginSecondFactorChallenge,
  SecondFactorInput,
  SecondFactorMethod,
} from "../../../../packages/contracts/src/index";
import type { SecurityEnv } from "./env";
import { beginSecondFactorChallenge } from "./challenges";
import { verifyAssertion, countPasskeys } from "./passkeys";
import { consumeRecoveryCode, countRecoveryCodes } from "./recovery-codes";
import { totpConfirmed, verifyTotpCode } from "./totp";

/** Second factors the user can currently present; empty when two-factor sign-in is off. */
export async function secondFactorMethods(
  env: SecurityEnv,
  userId: string
): Promise<SecondFactorMethod[]> {
  const [totp, passkeys, codes] = await Promise.all([
    totpConfirmed(env, userId),
    countPasskeys(env, userId),
    countRecoveryCodes(env, userId),
  ]);
  const methods: SecondFactorMethod[] = [];
  if (totp) methods.push("totp");
  if (passkeys > 0) methods.push("passkey");
  if (methods.length > 0 && codes > 0) methods.push("recovery");
  return methods;
}

export async function beginSecondFactor(
  env: SecurityEnv,
  userId: string
): Promise<LoginSecondFactorChallenge | null> {
  const methods = await secondFactorMethods(env, userId);
  if (methods.length === 0) return null;
  return {
    secondFactorRequired: true,
    mfaToken: await beginSecondFactorChallenge(env, userId),
    methods,
  };
}

/** Verifies one second-factor proof for the user. Spends recovery codes and advances TOTP/passkey counters. */
export async function verifySecondFactor(
  env: SecurityEnv,
  request: Request,
  userId: string,
  factor: SecondFactorInput,
  passkeyChallenge: string | null
): Promise<boolean> {
  if (factor.method === "totp") return verifyTotpCode(env, userId, factor.code);
  if (factor.method === "recovery") return consumeRecoveryCode(env, userId, factor.code);
  if (!passkeyChallenge) return false;
  return passkeyAssertionMatches(env, request, userId, factor.response, passkeyChallenge);
}

async function passkeyAssertionMatches(
  env: SecurityEnv,
  request: Request,
  userId: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string
): Promise<boolean> {
  const owner = await verifyAssertion(env, request, {
    response,
    expectedChallenge,
    expectedUserId: userId,
    requireUserVerification: false,
  });
  return owner === userId;
}
