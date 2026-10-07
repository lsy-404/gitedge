import type { RateLimitDecision, RateLimitNamespace } from "../../packages/contracts/src/index";

export const unlimitedRateLimiter: RateLimitNamespace = {
  getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
};

export function countingRateLimiter(): RateLimitNamespace {
  const counts = new Map<string, number>();
  return {
    getByName: () => ({
      consume: async (key: string, limit: number): Promise<RateLimitDecision> => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return { allowed: count <= limit, retryAfter: 60 };
      },
    }),
  };
}
