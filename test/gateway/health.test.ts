import { describe, expect, it } from "vitest";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

const healthy = () => service(() => Response.json({ data: { ok: true } }));

function environment(overrides: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    ASSETS: service(() => new Response("asset")),
    AUTH: healthy(),
    FORGE: healthy(),
    GIT: healthy(),
    DEPLOY: healthy(),
    ACTIONS: healthy(),
    RATE_LIMITER: {
      getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
    ...overrides,
  };
}

const healthRequest = () => new Request("https://gitedge.example.com/api/health");

describe("Gateway health", () => {
  it("reports every probe for an anonymous caller without leaking details", async () => {
    const response = await handleGatewayRequest(healthRequest(), environment());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok" });
    expect(Object.keys(body.services)).toEqual([
      "auth",
      "forge",
      "git",
      "deploy",
      "actions",
      "limits",
      "d1",
    ]);
    for (const entry of Object.values<{ ok: boolean; latencyMs: number }>(body.services)) {
      expect(entry.ok).toBe(true);
      expect(Number.isInteger(entry.latencyMs)).toBe(true);
    }
    expect(Object.keys(body).sort()).toEqual(["services", "status"]);
  });

  it("probes services one at a time, never through the public routes", async () => {
    let active = 0;
    let overlapped = false;
    const paths: string[] = [];
    const slow = (name: string) =>
      service(async (request) => {
        paths.push(`${name}${new URL(request.url).pathname}`);
        expect(request.headers.has("Cookie")).toBe(false);
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return Response.json({ data: { ok: true } });
      });
    const response = await handleGatewayRequest(
      healthRequest(),
      environment({ AUTH: slow("auth"), FORGE: slow("forge"), GIT: slow("git") })
    );
    expect(response.status).toBe(200);
    expect(overlapped).toBe(false);
    expect(paths).toEqual([
      "auth/internal/health",
      "forge/internal/health",
      "git/internal/health",
      "forge/internal/health/d1",
    ]);
  });

  it("returns 503 degraded when a service fails or throws", async () => {
    const response = await handleGatewayRequest(
      healthRequest(),
      environment({
        GIT: service(() => new Response("down", { status: 503 })),
        DEPLOY: service(() => {
          throw new Error("unreachable");
        }),
      })
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.services.git.ok).toBe(false);
    expect(body.services.deploy.ok).toBe(false);
    expect(body.services.auth.ok).toBe(true);
    expect(JSON.stringify(body)).not.toContain("unreachable");
  });

  it("marks a probe unhealthy once its timeout elapses", async () => {
    const response = await handleGatewayRequest(
      healthRequest(),
      environment({ ACTIONS: service(() => new Promise<Response>(() => {})) })
    );
    expect(response.status).toBe(503);
    expect((await response.json()).services.actions.ok).toBe(false);
  }, 10_000);

  it("is not exempt from the IP rate limit", async () => {
    const response = await handleGatewayRequest(
      healthRequest(),
      environment({
        RATE_LIMITER: {
          getByName: () => ({ consume: async () => ({ allowed: false, retryAfter: 17 }) }),
        },
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
  });

  it("does not expose the internal health routes publicly", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/internal/health"),
      environment()
    );
    expect(response.status).toBe(404);
  });
});
