import type { RateLimitNamespace } from "../../../../packages/contracts/src/index";

export interface SecurityEnv {
  readonly DB: D1Database;
  readonly RATE_LIMITER: RateLimitNamespace;
  readonly LOG_LEVEL?: string;
  /** Cloudflare Email Service binding; email features are hidden when absent. */
  readonly EMAIL?: SendEmail;
  readonly EMAIL_FROM?: string;
  /** Public origin used for email links and the WebAuthn relying party. */
  readonly PUBLIC_ORIGIN?: string;
  readonly TOTP_ENCRYPTION_KEY?: string;
}

export function publicOrigin(env: SecurityEnv, request: Request): string {
  return env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : new URL(request.url).origin;
}

export function relyingPartyId(env: SecurityEnv, request: Request): string {
  return new URL(publicOrigin(env, request)).hostname;
}

export function emailConfigured(env: SecurityEnv): boolean {
  return Boolean(env.EMAIL && env.EMAIL_FROM);
}
