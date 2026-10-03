import { describe, expect, it } from "vitest";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

const unlimitedRateLimiter = {
  getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
};

function environment(
  overrides: Partial<Record<"auth" | "forge" | "git" | "assets", GatewayService>> = {}
): GatewayEnv {
  return {
    AUTH:
      overrides.auth ??
      service(
        () =>
          new Response(JSON.stringify({ data: null }), {
            headers: { "Content-Type": "application/json" },
          })
      ),
    FORGE: overrides.forge ?? service(() => new Response("forge")),
    GIT: overrides.git ?? service(() => new Response("git")),
    ASSETS: overrides.assets ?? service(() => new Response("asset")),
    RATE_LIMITER: unlimitedRateLimiter,
  };
}

describe("Gateway routing", () => {
  it("rejects stale browser account and perspective headers before forwarding", async () => {
    let forwarded = 0;
    const env = environment({
      auth: service(() =>
        Response.json({
          data: {
            id: "user-2",
            identifier: "second",
            groupKey: "free",
            agentSession: {
              id: "session-2",
              agentId: "agent-2",
              agentName: "Reviewer",
              repositoryId: "r1",
              workspaceName: "fork-2",
              permission: "read",
            },
          },
        })
      ),
      forge: service(() => {
        forwarded += 1;
        return new Response("forge");
      }),
    });
    for (const headers of [
      { "X-GitEdge-Expected-User": "user-1", "X-GitEdge-Expected-View": "session-2" },
      { "X-GitEdge-Expected-User": "user-2", "X-GitEdge-Expected-View": "account" },
    ]) {
      const result = await handleGatewayRequest(
        new Request("https://gitedge.example.com/api/forge/repositories", { headers }),
        env
      );
      expect(result.status).toBe(409);
    }
    expect(forwarded).toBe(0);
    const result = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: { "X-GitEdge-Expected-User": "user-2", "X-GitEdge-Expected-View": "session-2" },
      }),
      env
    );
    expect(result.status).toBe(200);
    expect(forwarded).toBe(1);
  });
  it("keeps direct Git merges private even for authenticated callers", async () => {
    let forwarded = false;
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/git/repositories/r1/merge", {
        method: "POST",
        headers: { Origin: "https://gitedge.example.com", Cookie: "session=valid" },
      }),
      environment({
        auth: service(() =>
          Response.json({ data: { id: "user-1", identifier: "owner", groupKey: "free" } })
        ),
        git: service(() => {
          forwarded = true;
          return new Response("merged");
        }),
      })
    );
    expect(response.status).toBe(405);
    expect(forwarded).toBe(false);
  });
  it("forwards auth routes directly to the Auth binding", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/auth/session"),
      environment({ auth: service((request) => new Response(new URL(request.url).pathname)) })
    );

    expect(await response.text()).toBe("/session");
  });

  it("preserves the public origin and query while forwarding GitHub OAuth routes", async () => {
    let receivedUrl = "";
    const response = await handleGatewayRequest(
      new Request(
        "https://gitedge.example.com/api/auth/github/start?returnTo=%2Fsettings%2Faccount"
      ),
      environment({
        auth: service((request) => {
          receivedUrl = request.url;
          return Response.redirect("https://github.com/login/oauth/authorize", 302);
        }),
      })
    );

    expect(response.status).toBe(302);
    expect(receivedUrl).toBe(
      "https://gitedge.example.com/github/start?returnTo=%2Fsettings%2Faccount"
    );
  });

  it("forwards OIDC SSO routes to Auth without the public prefix", async () => {
    let receivedUrl = "";
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/auth/sso/voidcarve/callback?code=c&state=s"),
      environment({
        auth: service((request) => {
          receivedUrl = request.url;
          return new Response(null, { status: 302 });
        }),
      })
    );

    expect(response.status).toBe(302);
    expect(receivedUrl).toBe("https://gitedge.example.com/sso/voidcarve/callback?code=c&state=s");
  });

  it("forwards anonymous Forge GET routes while rejecting writes", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories"),
      environment()
    );

    expect(response.status).toBe(200);
    const writeResponse = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", { method: "POST" }),
      environment()
    );
    expect(writeResponse.status).toBe(401);
  });

  it("forwards task and memory paths to Forge and keeps their writes authenticated", async () => {
    const paths: string[] = [];
    const forge = service((request) => {
      paths.push(new URL(request.url).pathname);
      return new Response("forge");
    });
    for (const path of ["tasks", "tasks/3/documents/plan", "memory", "settings"]) {
      const response = await handleGatewayRequest(
        new Request(`https://gitedge.example.com/api/forge/repositories/r1/${path}`),
        environment({ forge })
      );
      expect(response.status).toBe(200);
    }
    expect(paths).toEqual([
      "/repositories/r1/tasks",
      "/repositories/r1/tasks/3/documents/plan",
      "/repositories/r1/memory",
      "/repositories/r1/settings",
    ]);
    const write = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories/r1/tasks", {
        method: "POST",
      }),
      environment({ forge })
    );
    expect(write.status).toBe(401);
    expect(paths).toHaveLength(4);
  });

  it("strips spoofed identity headers and injects Auth identity", async () => {
    let received: Request | undefined;
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: {
          "X-GitEdge-User-Id": "attacker",
          "X-GitEdge-User-Name": "attacker",
          Cookie: "session=valid",
        },
      }),
      environment({
        auth: service(
          () =>
            new Response(
              JSON.stringify({
                data: { id: "user-1", identifier: "FixtureUser", groupKey: "team" },
              }),
              { headers: { "Content-Type": "application/json" } }
            )
        ),
        forge: service((request) => {
          received = request;
          return new Response("ok");
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(received?.headers.get("X-GitEdge-User-Id")).toBe("user-1");
    expect(received?.headers.get("X-GitEdge-User-Name")).toBe("FixtureUser");
    expect(received?.headers.get("X-GitEdge-User-Group")).toBe("team");
    expect(received?.headers.get("Cookie")).toBeNull();
    expect(new URL(received?.url ?? "https://invalid").pathname).toBe("/repositories");
  });

  it("routes Git Smart HTTP paths to the Git binding", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/owner/repo.git/info/refs?service=git-upload-pack"),
      environment()
    );

    expect(await response.text()).toBe("git");
  });

  it("falls back to index.html for an unknown browser route", async () => {
    const paths: string[] = [];
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/owner/repo"),
      environment({
        assets: service((request) => {
          paths.push(new URL(request.url).pathname);
          return new Response(paths.length === 1 ? "missing" : "index", {
            status: paths.length === 1 ? 404 : 200,
          });
        }),
      })
    );

    expect(await response.text()).toBe("index");
    expect(paths).toEqual(["/owner/repo", "/index.html"]);
  });
  it("strips trust headers even on directly forwarded Auth requests", async () => {
    let forwarded = false;
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/auth/session", {
        headers: { "X-GitEdge-User-Id": "spoofed", "X-GitEdge-Agent-Session": "spoofed" },
      }),
      environment({
        auth: service((request) => {
          forwarded = true;
          expect(request.headers.get("X-GitEdge-User-Id")).toBeNull();
          expect(request.headers.get("X-GitEdge-Agent-Session")).toBeNull();
          return Response.json({ data: null });
        }),
      })
    );
    expect(response.status).toBe(200);
    expect(forwarded).toBe(true);
  });
  it.each([
    "auth/_internal/agent-events",
    "actions/internal/push",
    "forge/internal/actions-check",
    "forge/internal/merge-authorization",
  ])("keeps internal %s inaccessible", async (path) => {
    const response = await handleGatewayRequest(
      new Request(`https://gitedge.example.com/api/${path}`, {
        method: "POST",
        headers: { Origin: "https://gitedge.example.com" },
      }),
      environment()
    );
    expect(response.status).toBe(404);
  });
  it("redirects renamed deep links while retaining refs and path", async () => {
    const response = await handleGatewayRequest(
      new Request(
        "https://gitedge.example.com/owner/old.name/blob/docs/setup.md?ref=feature%2Fbranch"
      ),
      environment({
        forge: service((request) => {
          expect(new URL(request.url).pathname).toBe("/repositories/by-name/owner/old.name");
          return Response.json({ data: { owner: "owner", name: "new.name" } });
        }),
      })
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe(
      "https://gitedge.example.com/owner/new.name/blob/docs/setup.md?ref=feature%2Fbranch"
    );
  });
  it("does not reveal renamed private paths to anonymous readers", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/owner/private-old"),
      environment({ forge: service(() => new Response("missing", { status: 404 })) })
    );
    expect(response.headers.get("Location")).toBeNull();
  });
});
