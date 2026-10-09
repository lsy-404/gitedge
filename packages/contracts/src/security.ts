import { z } from "zod";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** How long a successful re-authentication keeps sensitive account actions unlocked. */
export const RECENT_AUTH_WINDOW_MS = 10 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function hasRecentAuth(recentAuthAt: number | undefined, now = Date.now()): boolean {
  return (
    recentAuthAt !== undefined && recentAuthAt <= now && now - recentAuthAt < RECENT_AUTH_WINDOW_MS
  );
}

export const SecondFactorMethodSchema = z.enum(["totp", "recovery", "passkey"]);
export type SecondFactorMethod = z.infer<typeof SecondFactorMethodSchema>;

const PasswordSchema = z.string().min(12).max(256);
const TotpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/);
const RecoveryCodeSchema = z.string().trim().min(8).max(32);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const RegistrationResponseSchema = z.custom<RegistrationResponseJSON>(
  (value) =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.rawId === "string" &&
    value.type === "public-key" &&
    isRecord(value.response) &&
    typeof value.response.clientDataJSON === "string" &&
    typeof value.response.attestationObject === "string"
);

export const AuthenticationResponseSchema = z.custom<AuthenticationResponseJSON>(
  (value) =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.rawId === "string" &&
    value.type === "public-key" &&
    isRecord(value.response) &&
    typeof value.response.clientDataJSON === "string" &&
    typeof value.response.authenticatorData === "string" &&
    typeof value.response.signature === "string"
);

/** A second proof of identity: a TOTP code, a recovery code or a passkey assertion. */
export const SecondFactorInputSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("totp"), code: TotpCodeSchema }),
  z.object({ method: z.literal("recovery"), code: RecoveryCodeSchema }),
  z.object({ method: z.literal("passkey"), response: AuthenticationResponseSchema }),
]);
export type SecondFactorInput = z.infer<typeof SecondFactorInputSchema>;

export const CompleteLoginSchema = z.object({
  mfaToken: z.string().min(20).max(128),
  factor: SecondFactorInputSchema,
});
export const MfaTokenSchema = z.object({ mfaToken: z.string().min(20).max(128) });

export const ReauthInputSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("password"), password: z.string().min(1).max(256) }),
  ...SecondFactorInputSchema.options,
]);
export type ReauthInput = z.infer<typeof ReauthInputSchema>;

export const PasskeyLoginInputSchema = z.object({
  challengeId: z.string().min(20).max(128),
  response: AuthenticationResponseSchema,
});
export const AddPasskeyInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  response: RegistrationResponseSchema,
});
export const RenamePasskeyInputSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const ChangePasswordInputSchema = z.object({ newPassword: PasswordSchema });
export const RecoveryPasswordResetSchema = z.object({
  identifier: z.string().trim().min(3).max(64),
  recoveryCode: RecoveryCodeSchema,
  newPassword: PasswordSchema,
});
export const EmailResetRequestSchema = z.object({ email: z.string().trim().email().max(254) });
export const EmailResetConfirmSchema = z.object({
  token: z.string().min(20).max(128),
  newPassword: PasswordSchema,
  factor: z
    .discriminatedUnion("method", [
      z.object({ method: z.literal("totp"), code: TotpCodeSchema }),
      z.object({ method: z.literal("recovery"), code: RecoveryCodeSchema }),
    ])
    .optional(),
});
export const SetEmailInputSchema = z.object({ email: z.string().trim().email().max(254) });
export const TokenInputSchema = z.object({ token: z.string().min(20).max(128) });
export const ConfirmTotpInputSchema = z.object({ code: TotpCodeSchema });
export const DisableTotpInputSchema = z.object({
  password: z.string().max(256).optional(),
  code: TotpCodeSchema,
});

export interface LoginSecondFactorChallenge {
  secondFactorRequired: true;
  mfaToken: string;
  methods: SecondFactorMethod[];
}
export interface LoginSuccess {
  id: string;
  identifier: string;
  groupKey: string;
}
export type LoginResponse = LoginSuccess | LoginSecondFactorChallenge;

export function isSecondFactorChallenge(value: LoginResponse): value is LoginSecondFactorChallenge {
  return "secondFactorRequired" in value;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export interface SecuritySummary {
  passwordEnabled: boolean;
  email: { address: string; verified: boolean } | null;
  /** Email delivery is configured, so verification and reset links can be sent. */
  emailAvailable: boolean;
  totp: { enabled: boolean; available: boolean };
  passkeys: PasskeySummary[];
  recoveryCodesRemaining: number;
  secondFactorEnabled: boolean;
  recentAuth: {
    valid: boolean;
    expiresAt: number | null;
    methods: ("password" | SecondFactorMethod)[];
  };
}

export interface RecoveryOptions {
  emailReset: boolean;
}

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
}

export interface RecoveryCodes {
  recoveryCodes: string[];
}

export interface PasskeyRegistrationOptions {
  options: PublicKeyCredentialCreationOptionsJSON;
}
export interface PasskeyAuthenticationOptions {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}
export interface SecondFactorOptions {
  options: PublicKeyCredentialRequestOptionsJSON;
}
