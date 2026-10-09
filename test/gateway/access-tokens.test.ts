import { describe, expect, it } from "vitest";
import {
  handleGatewayRequest,
  type GatewayEnv,
  type GatewayService,
} from "../../workers/gateway/src/index";
import {
  AccessTokenIdentitySchema,
  REPOSITORY_ACCESS_DENIED_HEADER,
  TRUSTED_USER_HEADERS,
  type AccessTokenIdentity,
} from "../../packages/contracts/src/index";

const TOKEN = `gep_${"a".repeat(64)}`;
const identity: AccessTokenIdentity = { id: "t1", scopes: ["repo:read"], repositoryIds: ["r1"] };
const user = { id: "u1", identifier: "alice", groupKey: "free", token: identity };

function service(handler: (request: Request) => Response | Promise<Response>): GatewayService {
  return { fetch: async (request) => handler(request) };
}

function environment(overrides: Partial<Record<"auth" | "forge" | "git", GatewayService>> = {}) {
  const env: GatewayEnv = {
    AUTH:
      overrides.auth ??
      service((request) =>
        request.headers.get("Authorization") === `Bearer ${TOKEN}`
          ? Response.json({ data: user })
          : new Response(null, { status: 401 })
      ),
    FORGE: overrides.forge ?? service(() => new Response("forge")),
    GIT: overrides.git ?? service(() => new Response("git")),
    ASSETS: service(() => new Response("asset")),
    RATE_LIMITER: {
      getByName: () => ({ consume: async () => ({ allowed: true, retryAfter: 0 }) }),
    },
  };
  return env;
}

const basic = (secret: string, username = "git") => `Basic ${btoa(`${username}:${secret}`)}`;

describe("Gateway personal access tokens", () => {
  it("derives trusted identity with the token scope and drops the credential", async () => {
    let forwarded: Request | undefined;
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories/r1/issues", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, Cookie: "gitedge_session=abc" },
        body: "{}",
      }),
      environment({
        forge: service((request) => {
          forwarded = request;
          return new Response("ok");
        }),
      })
    );
    expect(response.status).toBe(200);
    expect(forwarded?.headers.has("Authorization")).toBe(false);
    expect(forwarded?.headers.has("Cookie")).toBe(false);
    expect(forwarded?.headers.get("X-GitEdge-User-Id")).toBe("u1");
    expect(
      AccessTokenIdentitySchema.parse(
        JSON.parse(forwarded?.headers.get("X-GitEdge-Access-Token") ?? "")
      )
    ).toEqual(identity);
  });

  it("strips forged trust headers, including the access token scope", async () => {
    let forwarded: Request | undefined;
    const forged = Object.fromEntries(TRUSTED_USER_HEADERS.map((name) => [name, "forged"]));
    await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", { headers: forged }),
      environment({
        forge: service((request) => {
          forwarded = request;
          return new Response("ok");
        }),
      })
    );
    for (const name of TRUSTED_USER_HEADERS) expect(forwarded?.headers.has(name)).toBe(false);
    expect(TRUSTED_USER_HEADERS).toContain("x-gitedge-access-token");
  });

  it("rejects invalid, revoked or expired tokens instead of falling back to anonymous reads", async () => {
    let reached = false;
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: { Authorization: `Bearer gep_${"b".repeat(64)}` },
      }),
      environment({
        forge: service(() => {
          reached = true;
          return new Response("public");
        }),
      })
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
    expect(reached).toBe(false);
  });

  it("rejects an identity payload with a malformed token scope", async () => {
    const response = await handleGatewayRequest(
      new Request("https://gitedge.example.com/api/forge/repositories", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      environment({
        auth: service(() =>
          Response.json({ data: { ...user, token: { id: "t1", scopes: ["root"] } } })
        ),
      })
    );
    expect(response.status).toBe(502);
  });
});

describe("Gateway Git authentication", () => {
  const gitUrl = "https://gitedge.example.com/alice/demo.git/info/refs?service=git-upload-pack";

  it("accepts HTTP Basic with any username and forwards a grant", async () => {
    let authRequest: Request | undefined;
    let forwarded: Request | undefined;
    const response = await handleGatewayRequest(
      new Request(gitUrl, { headers: { Authorization: basic(TOKEN, "whatever") } }),
      environment({
        auth: service((request) => {
          authRequest = request;
          return Response.json({
            data: { user, repositoryId: "r1", permission: "write" },
          });
        }),
        git: service((request) => {
          forwarded = request;
          return new Response("refs");
        }),
      })
    );
    expect(response.status).toBe(200);
    expect(authRequest ? new URL(authRequest.url).pathname : "").toBe("/git-session");
    expect(authRequest?.headers.get("Authorization")).toBe(basic(TOKEN, "whatever"));
    expect(forwarded?.headers.has("Authorization")).toBe(false);
    expect(JSON.parse(forwarded?.headers.get("X-GitEdge-Git-Grant") ?? "")).toEqual({
      repositoryId: "r1",
      permission: "write",
    });
    expect(forwarded?.headers.has("X-GitEdge-Access-Token")).toBe(true);
  });

  it("challenges for credentials on anonymous misses and bad tokens", async () => {
    const missing = await handleGatewayRequest(
      new Request(gitUrl),
      environment({ git: service(() => new Response("not found", { status: 404 })) })
    );
    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toContain("Basic");

    const bad = await handleGatewayRequest(
      new Request(gitUrl, { headers: { Authorization: basic("nope") } }),
      environment({ auth: service(() => new Response(null, { status: 401 })) })
    );
    expect(bad.status).toBe(401);
    expect(bad.headers.get("WWW-Authenticate")).toContain("Basic");

    const open = await handleGatewayRequest(new Request(gitUrl), environment());
    expect(open.status).toBe(200);
  });

  it("answers valid tokens without access with 404 or 403 instead of a challenge", async () => {
    const denied = await handleGatewayRequest(
      new Request(gitUrl, { headers: { Authorization: basic(TOKEN) } }),
      environment({
        auth: service(() => {
          const response = Response.json({ error: { code: "not_found" } }, { status: 404 });
          response.headers.set(REPOSITORY_ACCESS_DENIED_HEADER, "1");
          return response;
        }),
      })
    );
    expect(denied.status).toBe(404);
    expect(denied.headers.has("WWW-Authenticate")).toBe(false);
    expect(denied.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)).toBe(false);

    const scope = await handleGatewayRequest(
      new Request(gitUrl, { headers: { Authorization: basic(TOKEN) } }),
      environment({
        auth: service(() =>
          Response.json({ error: { code: "insufficient_scope" } }, { status: 403 })
        ),
      })
    );
    expect(scope.status).toBe(403);
    expect(scope.headers.has("WWW-Authenticate")).toBe(false);

    const unavailable = await handleGatewayRequest(
      new Request(gitUrl, { headers: { Authorization: basic(TOKEN) } }),
      environment({ auth: service(() => new Response("boom", { status: 500 })) })
    );
    expect(unavailable.status).toBe(502);
  });

  it("does not let forged grant headers through", async () => {
    let forwarded: Request | undefined;
    await handleGatewayRequest(
      new Request(gitUrl, {
        headers: {
          "X-GitEdge-Git-Grant": JSON.stringify({ repositoryId: "r1", permission: "write" }),
          "X-GitEdge-Access-Token": JSON.stringify({ id: "x", scopes: ["admin"] }),
        },
      }),
      environment({
        git: service((request) => {
          forwarded = request;
          return new Response("refs");
        }),
      })
    );
    expect(forwarded?.headers.has("X-GitEdge-Git-Grant")).toBe(false);
    expect(forwarded?.headers.has("X-GitEdge-Access-Token")).toBe(false);
  });
});
