import { describe, expect, it } from "vitest";
import gateway, {
  handleGatewayRequest,
  rateLimitIpKey,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

const unlimitedRateLimiter = {
  getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
};

function environment(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    AUTH: service(() => Response.json({ data: null })),
    FORGE: service(() => Response.json({ data: [] })),
    GIT: service(() => new Response("git")),
    ASSETS: service(
      () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })
    ),
    RATE_LIMITER: unlimitedRateLimiter,
    ...overrides,
  };
}

describe("Gateway response headers", () => {
  it("adds a frame-denying policy and nosniff to the SPA document", async () => {
    const response = await gateway.fetch(
      new Request("https://gitedge.example.com/"),
      environment()
    );
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(response.headers.has("Cache-Control")).toBe(false);
    expect(await response.text()).toBe("<!doctype html>");
  });

  it("marks API responses uncacheable unless the service chose a policy", async () => {
    const plain = await gateway.fetch(
      new Request("https://gitedge.example.com/api/forge/repositories"),
      environment()
    );
    expect(plain.headers.get("Cache-Control")).toBe("private, no-store");

    const cached = await gateway.fetch(
      new Request("https://gitedge.example.com/api/forge/repositories"),
      environment({
        FORGE: service(
          () => new Response("ok", { headers: { "Cache-Control": "public, max-age=60" } })
        ),
      })
    );
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("keeps a stricter policy set by a downstream service", async () => {
    const response = await gateway.fetch(
      new Request("https://gitedge.example.com/api/forge/repositories"),
      environment({
        FORGE: service(
          () => new Response("ok", { headers: { "Content-Security-Policy": "default-src 'none'" } })
        ),
      })
    );
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
  });
});

describe("Gateway unavailable services", () => {
  it("names the missing Actions service", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/actions/runs/1"),
      environment()
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "service_unavailable", message: "Actions service is unavailable." },
    });
  });

  it("names the missing Deploy service", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/deploy/plan"),
      environment()
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "Deployment service is unavailable." },
    });
  });
});

describe("Gateway address limiting", () => {
  it("keys IPv6 clients by /64 prefix and leaves IPv4 unchanged", () => {
    const compressed = rateLimitIpKey("2001:db8:1:2::5");
    expect(rateLimitIpKey("2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd")).toBe(compressed);
    expect(rateLimitIpKey("2001:db8:1:3::5")).not.toBe(compressed);
    expect(rateLimitIpKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(rateLimitIpKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitIpKey("::ffff:203.0.113.9")).toBe("::ffff:203.0.113.9");
  });

  it("charges clients in one /64 to the same bucket", async () => {
    const keys: string[] = [];
    const env = environment({
      RATE_LIMITER: {
        getByName: (name: string) => {
          keys.push(name);
          return { consume: async () => ({ allowed: true, retryAfter: 0 }) };
        },
      } as GatewayEnv["RATE_LIMITER"],
    });
    for (const ip of ["2001:db8:1:2::5", "2001:db8:1:2:ffff::1"]) {
      await handleGatewayRequest(
        new Request("https://gitedge.example.com/api/forge/repositories", {
          headers: { "CF-Connecting-IP": ip },
        }),
        env
      );
    }
    expect(new Set(keys).size).toBe(1);
  });
});
