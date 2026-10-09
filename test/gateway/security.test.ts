import { readFileSync } from "node:fs";
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

  it("never lets a response that sets a cookie be shared", async () => {
    const response = await gateway.fetch(
      new Request("https://gitedge.example.com/api/forge/repositories"),
      environment({
        FORGE: service(
          () =>
            new Response("ok", {
              headers: { "Cache-Control": "public, max-age=60", "Set-Cookie": "a=b" },
            })
        ),
      })
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("passes edge cache validators and status through for public Git reads", async () => {
    let received: string | null = null;
    const response = await gateway.fetch(
      new Request("https://gitedge.example.com/api/git/repositories/r1/tree?ref=main", {
        headers: { "If-None-Match": '"abc"' },
      }),
      environment({
        GIT: service((request) => {
          received = request.headers.get("If-None-Match");
          return new Response(null, {
            status: 304,
            headers: {
              ETag: '"abc"',
              "Cache-Control": "public, max-age=0, s-maxage=30, must-revalidate",
              "X-GitEdge-Cache": "revalidated",
            },
          });
        }),
      })
    );
    expect(received).toBe('"abc"');
    expect(response.status).toBe(304);
    expect(response.headers.get("X-GitEdge-Cache")).toBe("revalidated");
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=30");
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
        getByName: (name) => {
          keys.push(name);
          return { consume: async () => ({ allowed: true, retryAfter: 0 }) };
        },
      },
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

describe("Static asset headers", () => {
  it("applies the frame-denying policy to assets served without the Worker", () => {
    const rules = readFileSync("apps/web/public/_headers", "utf8");
    expect(rules).toMatch(/^\/\*$/m);
    expect(rules).toContain("frame-ancestors 'none'");
    expect(rules).toContain("X-Content-Type-Options: nosniff");
  });
});

describe("Gateway recent-authentication claim", () => {
  it("forwards the session's claim and drops a client-supplied one", async () => {
    const seen: (string | null)[] = [];
    const forged = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: { "X-GitEdge-Recent-Auth": "9999999999999", Cookie: "gitedge_session=t" },
      }),
      environment({
        AUTH: service(() =>
          Response.json({ data: { id: "u1", identifier: "ada", groupKey: "free" } })
        ),
        FORGE: service((request) => {
          seen.push(request.headers.get("X-GitEdge-Recent-Auth"));
          return Response.json({ data: [] });
        }),
      })
    );
    expect(forged.status).toBe(200);
    const claimed = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: { Cookie: "gitedge_session=t" },
      }),
      environment({
        AUTH: service(() =>
          Response.json({
            data: { id: "u1", identifier: "ada", groupKey: "free", recentAuthAt: 1234567890 },
          })
        ),
        FORGE: service((request) => {
          seen.push(request.headers.get("X-GitEdge-Recent-Auth"));
          return Response.json({ data: [] });
        }),
      })
    );
    expect(claimed.status).toBe(200);
    expect(seen).toEqual([null, "1234567890"]);
  });
});
