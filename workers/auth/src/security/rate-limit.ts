import {
  consumeRateLimit,
  type RateLimitDecision,
  type RateLimitNamespace,
} from "../../../../packages/contracts/src/index";
import { errorResponse } from "../../../../src/worker/common/http";

export function rateLimited(decision: RateLimitDecision): Response | null {
  if (decision.allowed) return null;
  return errorResponse(429, "rate_limited", "Too many attempts. Try again later.", {
    "Retry-After": String(decision.retryAfter),
  });
}

/** Consumes one unit from each key and returns a 429 response when any of them is exhausted. */
export async function limitAttempts(
  namespace: RateLimitNamespace,
  limits: readonly (readonly [key: string, perMinute: number])[]
): Promise<Response | null> {
  for (const [key, limit] of limits) {
    const limited = rateLimited(await consumeRateLimit(namespace, key, limit));
    if (limited) return limited;
  }
  return null;
}

export function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
