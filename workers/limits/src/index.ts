import { DurableObject } from "cloudflare:workers";

import type { RateLimitDecision } from "../../../packages/contracts/src/index";

type HitRow = { at: number };

export class SharedRateLimitDurableObject extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS rate_limit_hits (key TEXT NOT NULL, at INTEGER NOT NULL)"
      );
      ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS rate_limit_hits_key_at ON rate_limit_hits (key, at)"
      );
      ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS rate_limit_hits_at ON rate_limit_hits (at)");
    });
  }

  async consume(key: string, limit: number, now = Date.now()): Promise<RateLimitDecision> {
    const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
    const cutoff = now - 60_000;
    this.ctx.storage.sql.exec("DELETE FROM rate_limit_hits WHERE at <= ?", cutoff);
    const count = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM rate_limit_hits WHERE key = ? AND at > ?",
        key,
        cutoff
      )
      .one().count;
    if (safeLimit <= 0 || count >= safeLimit) {
      const oldest = this.ctx.storage.sql
        .exec<HitRow>(
          "SELECT at FROM rate_limit_hits WHERE key = ? AND at > ? ORDER BY at ASC LIMIT 1",
          key,
          cutoff
        )
        .toArray()[0]?.at;
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil(((oldest ?? now) + 60_000 - now) / 1000)),
      };
    }
    this.ctx.storage.sql.exec("INSERT INTO rate_limit_hits (key, at) VALUES (?, ?)", key, now);
    return { allowed: true, retryAfter: 0 };
  }
}

export default {
  fetch(): Response {
    return new Response("Not found\n", { status: 404 });
  },
};
