import {
  AgentSessionIdentitySchema,
  TRUSTED_USER_HEADERS,
  trustedHeaders,
  consumeRateLimit,
  parseUserGroupLimits,
  type RateLimitDecision,
  type RateLimitNamespace,
  type TrustedUser,
} from "../../../packages/contracts/src/index";

export interface GatewayService {
  fetch(request: Request): Promise<Response>;
}

export interface GatewayEnv {
  ASSETS: GatewayService;
  AUTH: GatewayService;
  FORGE: GatewayService;
  GIT: GatewayService;
  DEPLOY?: GatewayService;
  RATE_LIMITER: RateLimitNamespace;
  IP_RPM_LIMIT?: string;
  USER_GROUP_LIMITS_JSON?: string;
}

interface AuthenticatedSession extends TrustedUser {
  authenticated: true;
}

interface AnonymousSession {
  authenticated: false;
}

type SessionResult = AuthenticatedSession | AnonymousSession;

interface AuthSessionPayload {
  data: TrustedUser | null;
}

function isSessionPayload(value: unknown): value is AuthSessionPayload {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return false;
  }

  return (
    value.data === null ||
    (typeof value.data === "object" &&
      value.data !== null &&
      "id" in value.data &&
      "identifier" in value.data &&
      typeof value.data.id === "string" &&
      value.data.id.length > 0 &&
      typeof value.data.identifier === "string" &&
      value.data.identifier.length > 0 &&
      "groupKey" in value.data &&
      typeof value.data.groupKey === "string" &&
      value.data.groupKey.length > 0 &&
      (!("agentSession" in value.data) ||
        AgentSessionIdentitySchema.safeParse(value.data.agentSession).success))
  );
}

function isGitRequest(pathname: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(?:\/|$)/.test(pathname);
}

function isApiPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function withPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}

function withoutTrustedHeaders(headers: Headers): void {
  for (const header of TRUSTED_USER_HEADERS) {
    headers.delete(header);
  }
}

async function readSession(response: Response): Promise<SessionResult | Response> {
  if (response.status === 401 || response.status === 403) {
    return { authenticated: false };
  }
  if (!response.ok) {
    return new Response(JSON.stringify({ error: "Authentication service unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const payload: unknown = await response.json();
  if (!isSessionPayload(payload)) {
    return new Response(JSON.stringify({ error: "Invalid authentication response" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (payload.data === null) return { authenticated: false };
  return {
    authenticated: true,
    id: payload.data.id,
    identifier: payload.data.identifier,
    groupKey: payload.data.groupKey,
    agentSession: payload.data.agentSession,
  };
}

async function authenticate(
  request: Request,
  auth: GatewayService
): Promise<SessionResult | Response> {
  const sessionUrl = new URL("/session", request.url);
  const headers = new Headers();
  const cookie = request.headers.get("Cookie");
  if (cookie) {
    headers.set("Cookie", cookie);
  }
  headers.set("Accept", "application/json");
  const authorization = request.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  return readSession(await auth.fetch(new Request(sessionUrl, { headers })));
}

function forwardServicePath(request: Request, prefix: string): Request {
  const pathname = new URL(request.url).pathname;
  const servicePath = pathname.slice(prefix.length) || "/";
  return withPath(request, servicePath);
}

function forwardAuthenticated(
  request: Request,
  prefix: string,
  session?: AuthenticatedSession
): Request {
  const headers = new Headers(request.headers);
  withoutTrustedHeaders(headers);
  headers.delete("Cookie");
  headers.delete("Authorization");
  trustedHeaders(session).forEach((value, name) => headers.set(name, value));
  if (prefix === "/api/deploy") {
    const cookie = (request.headers.get("Cookie") ?? "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("ge_deploy_") || part.startsWith("__Host-ge_deploy_"))
      .join("; ");
    if (cookie) headers.set("Cookie", cookie);
  }
  return new Request(forwardServicePath(request, prefix), { headers });
}

function parsePositiveLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rateLimitedResponse(decision: RateLimitDecision): Response | null {
  if (decision.allowed) return null;
  return Response.json(
    { error: "Rate limit exceeded", retryAfter: decision.retryAfter },
    { status: 429, headers: { "Retry-After": String(decision.retryAfter) } }
  );
}

async function enforceIpLimit(request: Request, env: GatewayEnv): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const decision = await consumeRateLimit(
    env.RATE_LIMITER,
    `ip:${ip}`,
    parsePositiveLimit(env.IP_RPM_LIMIT, 300)
  );
  return rateLimitedResponse(decision);
}

async function enforceUserLimit(
  session: AuthenticatedSession,
  env: GatewayEnv
): Promise<Response | null> {
  const limits = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
  const decision = await consumeRateLimit(
    env.RATE_LIMITER,
    `user:${session.groupKey}:${session.id}`,
    limits[session.groupKey]?.rpm ?? limits.free.rpm
  );
  return rateLimitedResponse(decision);
}

async function serveSpa(request: Request, assets: GatewayService): Promise<Response> {
  const assetResponse = await assets.fetch(request);
  if (assetResponse.status !== 404 || (request.method !== "GET" && request.method !== "HEAD")) {
    return assetResponse;
  }
  return assets.fetch(withPath(request, "/index.html"));
}

export async function handleGatewayRequest(request: Request, env: GatewayEnv): Promise<Response> {
  const url = new URL(request.url);

  const rateLimitPath = isApiPath(url.pathname, "/api") || isGitRequest(url.pathname);
  if (rateLimitPath) {
    const ipLimitResponse = await enforceIpLimit(request, env);
    if (ipLimitResponse) return ipLimitResponse;
  }

  if (isApiPath(url.pathname, "/api/auth")) {
    return env.AUTH.fetch(forwardServicePath(request, "/api/auth"));
  }

  if (["/api/forge", "/api/git", "/api/deploy"].some((prefix) => isApiPath(url.pathname, prefix))) {
    const prefix = isApiPath(url.pathname, "/api/forge")
      ? "/api/forge"
      : isApiPath(url.pathname, "/api/git")
        ? "/api/git"
        : "/api/deploy";
    const service =
      prefix === "/api/forge" ? env.FORGE : prefix === "/api/git" ? env.GIT : env.DEPLOY;
    if (!service)
      return Response.json(
        { error: { code: "service_unavailable", message: "Deployment service is unavailable." } },
        { status: 503 }
      );
    const session = await authenticate(request, env.AUTH);
    if (session instanceof Response) return session;
    if (!session.authenticated) {
      if ((request.method === "GET" || request.method === "HEAD") && prefix !== "/api/deploy") {
        return service.fetch(forwardAuthenticated(request, prefix));
      }
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !request.headers.get("Authorization") &&
      request.headers.get("Origin") !== url.origin
    )
      return Response.json(
        { error: { code: "forbidden", message: "Same-origin writes are required." } },
        { status: 403 }
      );
    const userLimitResponse = await enforceUserLimit(session, env);
    if (userLimitResponse) return userLimitResponse;
    return service.fetch(forwardAuthenticated(request, prefix, session));
  }

  if (isGitRequest(url.pathname)) {
    const headers = new Headers(request.headers);
    withoutTrustedHeaders(headers);
    headers.delete("Cookie");
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/|$)/.exec(url.pathname);
    if (request.headers.has("Authorization") && gitMatch) {
      const authUrl = new URL("/git-session", url);
      authUrl.searchParams.set("owner", gitMatch[1]);
      authUrl.searchParams.set("repo", gitMatch[2]);
      const authHeaders = new Headers();
      authHeaders.set("Authorization", request.headers.get("Authorization") ?? "");
      const response = await env.AUTH.fetch(new Request(authUrl, { headers: authHeaders }));
      if (!response.ok)
        return new Response("Git authentication failed.\n", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="GitEdge"', "Cache-Control": "no-store" },
        });
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== "object" ||
        !("data" in payload) ||
        !payload.data ||
        typeof payload.data !== "object" ||
        !("user" in payload.data) ||
        !isSessionPayload({ data: payload.data.user }) ||
        !("repositoryId" in payload.data) ||
        typeof payload.data.repositoryId !== "string" ||
        !("permission" in payload.data) ||
        (payload.data.permission !== "read" && payload.data.permission !== "write")
      )
        return Response.json({ error: "Invalid Git authentication response" }, { status: 502 });
      const userPayload = { data: payload.data.user };
      if (!isSessionPayload(userPayload) || !userPayload.data)
        return Response.json({ error: "Invalid Git authentication response" }, { status: 502 });
      trustedHeaders(userPayload.data).forEach((value, name) => headers.set(name, value));
      headers.set(
        "X-GitEdge-Git-Grant",
        JSON.stringify({
          repositoryId: payload.data.repositoryId,
          permission: payload.data.permission,
        })
      );
      const userLimit = await enforceUserLimit({ authenticated: true, ...userPayload.data }, env);
      if (userLimit) return userLimit;
    }
    headers.delete("Authorization");
    return env.GIT.fetch(new Request(request, { headers }));
  }

  if (request.method === "GET" || request.method === "HEAD") {
    return serveSpa(request, env.ASSETS);
  }

  return new Response("Not found\n", { status: 404 });
}

export default {
  fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return handleGatewayRequest(request, env);
  },
};
