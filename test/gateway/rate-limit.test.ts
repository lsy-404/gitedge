import { describe, expect, it } from "vitest";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";
import { SharedRateLimitDurableObject } from "../../workers/limits/src/index";
import { sha256Hex } from "../../packages/contracts/src/index";

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

function createLimiter(): SharedRateLimitDurableObject {
  const hits: Array<{ key: string; at: number }> = [];
  const sql = {
    exec<T>(query: string, ...values: unknown[]) {
      if (query.startsWith("DELETE FROM")) {
        const cutoff = Number(values[0]);
        hits.splice(0, hits.length, ...hits.filter((hit) => hit.at > cutoff));
      } else if (query.startsWith("INSERT INTO")) {
        hits.push({ key: String(values[0]), at: Number(values[1]) });
      }
      const key = String(values[0]);
      const cutoff = Number(values[1]);
      const matching = hits.filter((hit) => hit.key === key && hit.at > cutoff);
      const rows = query.startsWith("SELECT COUNT")
        ? [{ count: matching.length }]
        : query.startsWith("SELECT at")
          ? matching.sort((left, right) => left.at - right.at).slice(0, 1)
          : [];
      return {
        one: () => rows[0] as T,
        toArray: () => rows as T[],
      };
    },
  };
  const ctx = {
    storage: { sql },
    blockConcurrencyWhile: (task: () => Promise<void>) => task(),
  } as unknown as DurableObjectState;
  return new SharedRateLimitDurableObject(ctx, {} as Env);
}

describe("Gateway strict rate limits", () => {
  it("enforces an exact rolling window per key and releases expired hits", async () => {
    const limiter = createLimiter();

    expect(await limiter.consume("ip-a", 2, 100_000)).toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect(await limiter.consume("ip-a", 2, 100_001)).toEqual({
      allowed: true,
      retryAfter: 0,
    });
    expect(await limiter.consume("ip-a", 2, 100_002)).toEqual({
      allowed: false,
      retryAfter: 60,
    });
    expect(await limiter.consume("ip-a", 2, 160_001)).toEqual({
      allowed: true,
      retryAfter: 0,
    });
  });

  it("denies a zero or non-finite limit without recording a hit", async () => {
    const limiter = createLimiter();
    for (const limit of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await limiter.consume("ip-b", limit, 100_000)).toEqual({
        allowed: false,
        retryAfter: 60,
      });
    }
    expect(await limiter.consume("ip-b", 1, 100_001)).toEqual({ allowed: true, retryAfter: 0 });
  });

  it("returns JSON 429 and Retry-After when an IP window is full", async () => {
    const env: GatewayEnv = {
      ASSETS: service(() => new Response("asset")),
      AUTH: service(() => new Response(JSON.stringify({ data: null }))),
      FORGE: service(() => new Response("forge")),
      GIT: service(() => new Response("git")),
      IP_RPM_LIMIT: "1",
      RATE_LIMITER: {
        getByName: () => ({
          consume: async () => ({ allowed: false, retryAfter: 42 }),
        }),
      },
    };
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/owner/repo.git/info/refs", {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      }),
      env
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({ error: "Rate limit exceeded", retryAfter: 42 });
  });
  it("limits repository import starts and retries per user", async () => {
    const importKey = await sha256Hex("import:user-1");
    const consumed: string[] = [];
    let forwarded = 0;
    const env: GatewayEnv = {
      ASSETS: service(() => new Response("asset")),
      AUTH: service(() =>
        Response.json({ data: { id: "user-1", identifier: "owner", groupKey: "free" } })
      ),
      FORGE: service(() => {
        forwarded += 1;
        return Response.json({ data: {} }, { status: 202 });
      }),
      GIT: service(() => new Response("git")),
      RATE_LIMITER: {
        getByName: () => ({
          consume: async (key: string) => {
            consumed.push(key);
            return key === importKey
              ? { allowed: false, retryAfter: 30 }
              : { allowed: true, retryAfter: 0 };
          },
        }),
      },
    };
    const send = (path: string, method = "POST") =>
      handleGatewayRequest(
        new Request(`https://gitedge.example.com${path}`, {
          method,
          headers: { Origin: "https://gitedge.example.com", Cookie: "gitedge_session=s" },
        }),
        env
      );
    for (const path of ["/api/forge/repository-imports", "/api/forge/repository-imports/j/retry"]) {
      const response = await send(path);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
    }
    expect(forwarded).toBe(0);
    consumed.length = 0;
    expect((await send("/api/forge/repository-imports/j", "GET")).status).toBe(202);
    expect(consumed).not.toContain(importKey);
    expect(forwarded).toBe(1);
  });
});
