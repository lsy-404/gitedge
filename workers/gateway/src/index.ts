import { z } from "zod";
import {
  RepositorySlugSchema,
  NamespaceSlugSchema,
  ReservedAccountIdentifiers,
} from "../../../packages/contracts/src/index";
import { readTextLimited } from "../../../src/worker/common/readText";
import {
  TRUSTED_USER_HEADERS,
  TrustedUserSchema,
  REPOSITORY_ACCESS_DENIED_HEADER,
  trustedHeaders,
  consumeRateLimit,
  parseUserGroupLimits,
  type HealthResponse,
  type ServiceHealth,
  type RateLimitDecision,
  type RateLimitNamespace,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import {
  MCP_PATH,
  OPENAPI_PATH,
  buildOpenApiDocument,
} from "../../../packages/contracts/src/openapi";
import { createLogger, type Logger } from "../../../src/worker/common/logger";

export interface GatewayService {
  fetch(request: Request): Promise<Response>;
}

export interface GatewayEnv {
  ASSETS: GatewayService;
  AUTH: GatewayService;
  FORGE: GatewayService;
  GIT: GatewayService;
  DEPLOY?: GatewayService;
  ACTIONS?: GatewayService;
  MCP?: GatewayService;
  RATE_LIMITER: RateLimitNamespace;
  IP_RPM_LIMIT?: string;
  USER_GROUP_LIMITS_JSON?: string;
  PRIVATE_REPOSITORY_RESPONSE?: string;
}

interface AuthenticatedSession extends TrustedUser {
  authenticated: true;
}

interface AnonymousSession {
  authenticated: false;
  view?: "guest";
}

type SessionResult = AuthenticatedSession | AnonymousSession;

const AuthSessionPayloadSchema = z.object({
  data: TrustedUserSchema.nullable(),
  view: z.string().optional(),
});

const GitSessionPayloadSchema = z.object({
  data: z.object({
    user: TrustedUserSchema,
    repositoryId: z.string().min(1),
    permission: z.enum(["read", "write"]),
  }),
});

const securityHeaders: Readonly<Record<string, string>> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

const unavailableMessages: Readonly<Record<string, string>> = {
  "/api/forge": "Forge service is unavailable.",
  "/api/git": "Git service is unavailable.",
  "/api/actions": "Actions service is unavailable.",
  "/api/deploy": "Deployment service is unavailable.",
};

export function withSecurityHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (pathname.startsWith("/api/") && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function gitAuthChallenge(message = "Authentication required.\n"): Response {
  return new Response(message, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="GitEdge"', "Cache-Control": "no-store" },
  });
}

function isGitRequest(pathname: string): boolean {
  return /^\/[^/]+\/[^/]+\.git(?:\/|$)/.test(pathname);
}

const DOWNLOAD_ROUTE = /^\/([^/]+)\/([^/]+)\/(raw|archive)\/(.+)$/;
const ARCHIVE_SUFFIX = /\.(zip|tar\.gz)$/;

function isDownloadPath(pathname: string): boolean {
  return DOWNLOAD_ROUTE.test(pathname);
}

/** Maps `/:owner/:repo/raw/...` and `/:owner/:repo/archive/<ref>.<format>` onto the Git API. */
function downloadRequest(request: Request, repositoryId: string): Request | null {
  const match = DOWNLOAD_ROUTE.exec(new URL(request.url).pathname);
  if (!match) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(match[4]);
  } catch {
    return null;
  }
  const target = new URL(
    `/api/git/repositories/${encodeURIComponent(repositoryId)}/${match[3]}`,
    request.url
  );
  const source = new URL(request.url);
  if (match[3] === "raw") {
    target.searchParams.set("spec", rest);
    if (source.searchParams.get("download") === "1") target.searchParams.set("download", "1");
  } else {
    const suffix = ARCHIVE_SUFFIX.exec(rest);
    if (!suffix) return null;
    target.searchParams.set("ref", rest.slice(0, -suffix[0].length));
    target.searchParams.set("format", suffix[1]);
  }
  return new Request(target, { method: request.method, headers: request.headers });
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

async function presentRepositoryResponse(response: Response, env: GatewayEnv): Promise<Response> {
  const denied =
    response.status === 404 && response.headers.get(REPOSITORY_ACCESS_DENIED_HEADER) === "1";
  if (!response.headers.has(REPOSITORY_ACCESS_DENIED_HEADER)) return response;
  if (denied && env.PRIVATE_REPOSITORY_RESPONSE === "forbidden") {
    await response.body?.cancel();
    return Response.json(
      { error: { code: "forbidden", message: "Repository access is denied." } },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }
  const headers = new Headers(response.headers);
  headers.delete(REPOSITORY_ACCESS_DENIED_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

  const parsed = AuthSessionPayloadSchema.safeParse(await response.json());
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid authentication response" }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const payload = parsed.data;
  if (payload.data === null)
    return { authenticated: false, ...(payload.view === "guest" ? { view: "guest" } : {}) };
  return { authenticated: true, ...payload.data };
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
  const headers = new Headers(request.headers);
  withoutTrustedHeaders(headers);
  return withPath(new Request(request, { headers }), servicePath);
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

export function rateLimitIpKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  // Clients typically control a whole IPv6 /64, so the limiter keys on the prefix.
  const [head, tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().padStart(4, "0"))
    .join(":")}::/64`;
}

async function enforceIpLimit(request: Request, env: GatewayEnv): Promise<Response | null> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const decision = await consumeRateLimit(
    env.RATE_LIMITER,
    `ip:${rateLimitIpKey(ip)}`,
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

const HEALTH_PROBE_TIMEOUT_MS = 2000;

async function probeService(service: GatewayService, path: string): Promise<boolean> {
  const response = await service.fetch(new Request(`https://gateway.internal${path}`));
  await response.body?.cancel();
  return response.ok;
}

async function runProbe(
  name: string,
  probe: () => Promise<boolean>,
  logger: Logger
): Promise<ServiceHealth> {
  const started = Date.now();
  let timer: number | null = null;
  let ok = false;
  try {
    ok = await Promise.race([
      probe(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), HEALTH_PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    logger.warn("gateway:health-probe-failed", {
      probe: name,
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (!ok) logger.warn("gateway:health-probe-unhealthy", { probe: name, latencyMs });
  return { ok, latencyMs };
}

// Probes run one after another so a health check never fans out subrequests.
async function handleHealth(env: GatewayEnv): Promise<Response> {
  const logger = createLogger(undefined, { service: "gateway" });
  const bound: [string, GatewayService | undefined][] = [
    ["auth", env.AUTH],
    ["forge", env.FORGE],
    ["git", env.GIT],
    ["deploy", env.DEPLOY],
    ["actions", env.ACTIONS],
  ];
  const probes: [string, () => Promise<boolean>][] = [];
  for (const [name, service] of bound)
    if (service) probes.push([name, () => probeService(service, "/internal/health")]);
  probes.push([
    "limits",
    async () => {
      await consumeRateLimit(env.RATE_LIMITER, "health-probe", 1);
      return true;
    },
  ]);
  probes.push(["d1", () => probeService(env.FORGE, "/internal/health/d1")]);
  const services: Record<string, ServiceHealth> = {};
  for (const [name, probe] of probes) services[name] = await runProbe(name, probe, logger);
  const healthy = Object.values(services).every((entry) => entry.ok);
  const body: HealthResponse = { status: healthy ? "ok" : "degraded", services };
  return Response.json(body, { status: healthy ? 200 : 503 });
}

const IMPORT_RPM_LIMIT = 5;
const ARCHIVE_RPM_LIMIT = 10;
const ARCHIVE_PATH = /^(?:\/api\/git\/repositories\/[^/]+\/archive|\/[^/]+\/[^/]+\/archive\/.+)$/;

/** Archives read every blob of a tree from Artifacts, so they get a much tighter budget. */
async function enforceArchiveLimit(
  request: Request,
  pathname: string,
  session: SessionResult,
  env: GatewayEnv
): Promise<Response | null> {
  if (request.method !== "GET" || !ARCHIVE_PATH.test(pathname)) return null;
  const key = session.authenticated
    ? `archive:user:${session.id}`
    : `archive:ip:${rateLimitIpKey(request.headers.get("CF-Connecting-IP") || "unknown")}`;
  return rateLimitedResponse(await consumeRateLimit(env.RATE_LIMITER, key, ARCHIVE_RPM_LIMIT));
}

async function enforceImportLimit(
  request: Request,
  pathname: string,
  session: AuthenticatedSession,
  env: GatewayEnv
): Promise<Response | null> {
  if (
    request.method !== "POST" ||
    !/^\/api\/forge\/repository-imports(?:\/[^/]+\/retry)?$/.test(pathname)
  )
    return null;
  return rateLimitedResponse(
    await consumeRateLimit(env.RATE_LIMITER, `import:${session.id}`, IMPORT_RPM_LIMIT)
  );
}

const bearerChallenge = { "WWW-Authenticate": 'Bearer realm="GitEdge"' };

/**
 * MCP clients authenticate with a Bearer personal access token or agent session token only;
 * cookies are dropped so a browser can never drive tools with its ambient session.
 */
async function handleMcp(request: Request, env: GatewayEnv): Promise<Response> {
  if (!env.MCP) {
    createLogger(undefined, { service: "gateway" }).warn("gateway:mcp-unbound");
    return Response.json(
      { error: { code: "service_unavailable", message: "MCP service is unavailable." } },
      { status: 503 }
    );
  }
  const headers = new Headers(request.headers);
  withoutTrustedHeaders(headers);
  headers.delete("Cookie");
  if (!/^Bearer \S+$/.test(headers.get("Authorization") ?? ""))
    return Response.json(
      { error: { code: "unauthorized", message: "A Bearer access token is required." } },
      { status: 401, headers: bearerChallenge }
    );
  const forwarded = new Request(request, { headers });
  const session = await authenticate(forwarded, env.AUTH);
  if (session instanceof Response) return session;
  if (!session.authenticated)
    return Response.json(
      { error: { code: "unauthorized", message: "Invalid or expired access token." } },
      { status: 401, headers: bearerChallenge }
    );
  const userLimitResponse = await enforceUserLimit(session, env);
  if (userLimitResponse) return userLimitResponse;
  return env.MCP.fetch(forwarded);
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

  if (/^\/api\/(?:auth|forge|git|deploy|actions)\/_?internal(?:\/|$)/.test(url.pathname))
    return new Response("Not found\n", { status: 404 });

  const rateLimitPath =
    isApiPath(url.pathname, "/api") ||
    url.pathname === MCP_PATH ||
    isGitRequest(url.pathname) ||
    (isDownloadPath(url.pathname) && (request.method === "GET" || request.method === "HEAD"));
  if (rateLimitPath) {
    const ipLimitResponse = await enforceIpLimit(request, env);
    if (ipLimitResponse) return ipLimitResponse;
  }

  if (request.method === "GET" && url.pathname === "/api/health") return handleHealth(env);
  if (request.method === "GET" && url.pathname === OPENAPI_PATH)
    return Response.json(buildOpenApiDocument(url.origin), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  if (url.pathname === MCP_PATH) return handleMcp(request, env);

  if (isApiPath(url.pathname, "/api/auth")) {
    return env.AUTH.fetch(forwardServicePath(request, "/api/auth"));
  }

  if (
    ["/api/forge", "/api/git", "/api/deploy", "/api/actions"].some((prefix) =>
      isApiPath(url.pathname, prefix)
    )
  ) {
    const prefix = isApiPath(url.pathname, "/api/forge")
      ? "/api/forge"
      : isApiPath(url.pathname, "/api/git")
        ? "/api/git"
        : isApiPath(url.pathname, "/api/actions")
          ? "/api/actions"
          : "/api/deploy";
    if (
      prefix === "/api/git" &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !/^\/api\/git\/repositories\/[^/]+\/(edit|commit|branches|tags)$/.test(url.pathname)
    )
      return Response.json(
        {
          error: { code: "method_not_allowed", message: "Use the pull request workflow to merge." },
        },
        { status: 405, headers: { Allow: "GET, HEAD" } }
      );
    const service =
      prefix === "/api/forge"
        ? env.FORGE
        : prefix === "/api/git"
          ? env.GIT
          : prefix === "/api/actions"
            ? env.ACTIONS
            : env.DEPLOY;
    if (!service)
      return Response.json(
        { error: { code: "service_unavailable", message: unavailableMessages[prefix] } },
        { status: 503 }
      );
    const session = await authenticate(request, env.AUTH);
    if (session instanceof Response) return session;
    const expectedUser = request.headers.get("X-GitEdge-Expected-User");
    const expectedView = request.headers.get("X-GitEdge-Expected-View");
    if (
      (expectedUser && (!session.authenticated || session.id !== expectedUser)) ||
      (expectedView &&
        expectedView !==
          (session.authenticated
            ? (session.agentSession?.id ?? "account")
            : (session.view ?? "account")))
    ) {
      return Response.json(
        {
          error: {
            code: "account_changed",
            message: "The active identity changed. Reload before continuing.",
          },
        },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!session.authenticated) {
      if (request.headers.has("Authorization"))
        return Response.json(
          { error: { code: "unauthorized", message: "Invalid or expired access token." } },
          { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="GitEdge"' } }
        );
      if ((request.method === "GET" || request.method === "HEAD") && prefix !== "/api/deploy") {
        const archiveLimit = await enforceArchiveLimit(request, url.pathname, session, env);
        if (archiveLimit) return archiveLimit;
        return presentRepositoryResponse(
          await service.fetch(forwardAuthenticated(request, prefix)),
          env
        );
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
    ) {
      createLogger(undefined, { service: "gateway" }).warn("gateway:origin-rejected", {
        origin: request.headers.get("Origin"),
        expectedOrigin: url.origin,
      });
      return Response.json(
        { error: { code: "forbidden", message: "Same-origin writes are required." } },
        { status: 403 }
      );
    }
    const userLimitResponse = await enforceUserLimit(session, env);
    if (userLimitResponse) return userLimitResponse;
    const importLimitResponse = await enforceImportLimit(request, url.pathname, session, env);
    if (importLimitResponse) return importLimitResponse;
    const archiveLimitResponse = await enforceArchiveLimit(request, url.pathname, session, env);
    if (archiveLimitResponse) return archiveLimitResponse;
    return presentRepositoryResponse(
      await service.fetch(forwardAuthenticated(request, prefix, session)),
      env
    );
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
      if (response.status === 401) {
        await response.body?.cancel();
        return gitAuthChallenge("Git authentication failed.\n");
      }
      // A valid credential without access must not be challenged, or Git erases it from its helper.
      if (response.status === 403 || response.status === 404)
        return presentRepositoryResponse(response, env);
      if (!response.ok) {
        await response.body?.cancel();
        return Response.json({ error: "Authentication service unavailable" }, { status: 502 });
      }
      const parsed = GitSessionPayloadSchema.safeParse(await response.json());
      if (!parsed.success)
        return Response.json({ error: "Invalid Git authentication response" }, { status: 502 });
      const grant = parsed.data.data;
      trustedHeaders(grant.user).forEach((value, name) => headers.set(name, value));
      headers.set(
        "X-GitEdge-Git-Grant",
        JSON.stringify({ repositoryId: grant.repositoryId, permission: grant.permission })
      );
      const userLimit = await enforceUserLimit({ authenticated: true, ...grant.user }, env);
      if (userLimit) return userLimit;
    }
    const anonymous = !request.headers.has("Authorization");
    headers.delete("Authorization");
    const gitResponse = await env.GIT.fetch(new Request(request, { headers }));
    // Git only prompts for credentials on 401, so anonymous misses challenge uniformly and hide private repositories.
    if (anonymous && (gitResponse.status === 404 || gitResponse.status === 401)) {
      await gitResponse.body?.cancel();
      return gitAuthChallenge();
    }
    return presentRepositoryResponse(gitResponse, env);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const segments = url.pathname.split("/").filter(Boolean);
    const [owner, slug] = segments;
    if (
      owner &&
      slug &&
      !ReservedAccountIdentifiers.has(owner) &&
      NamespaceSlugSchema.safeParse(owner).success &&
      RepositorySlugSchema.safeParse(slug).success
    ) {
      const session = await authenticate(request, env.AUTH);
      if (session instanceof Response) return session;
      if (
        isDownloadPath(url.pathname) &&
        !session.authenticated &&
        request.headers.has("Authorization")
      )
        return Response.json(
          { error: { code: "unauthorized", message: "Invalid or expired access token." } },
          { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="GitEdge"' } }
        );
      const resolveUrl = new URL(
        `/api/forge/repositories/by-name/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
        request.url
      );
      const resolved = await presentRepositoryResponse(
        await env.FORGE.fetch(
          forwardAuthenticated(
            new Request(resolveUrl, { headers: request.headers }),
            "/api/forge",
            session.authenticated ? session : undefined
          )
        ),
        env
      );
      if (resolved.ok) {
        const text = await readTextLimited(resolved.body, 65536);
        let payload: unknown = null;
        try {
          payload = JSON.parse(text ?? "null");
        } catch {}
        const parsed = z
          .object({
            data: z.object({
              id: z.string().min(1),
              owner: NamespaceSlugSchema,
              name: RepositorySlugSchema,
            }),
          })
          .safeParse(payload);
        if (parsed.success && isDownloadPath(url.pathname)) {
          const download = downloadRequest(request, parsed.data.data.id);
          if (!download)
            return Response.json(
              { error: { code: "not_found", message: "Download was not found." } },
              { status: 404, headers: { "Cache-Control": "no-store" } }
            );
          if (session.authenticated) {
            const userLimit = await enforceUserLimit(session, env);
            if (userLimit) return userLimit;
          }
          const archiveLimit = await enforceArchiveLimit(request, url.pathname, session, env);
          if (archiveLimit) return archiveLimit;
          return presentRepositoryResponse(
            await env.GIT.fetch(
              forwardAuthenticated(
                download,
                "/api/git",
                session.authenticated ? session : undefined
              )
            ),
            env
          );
        }
        if (
          parsed.success &&
          (parsed.data.data.owner !== owner || parsed.data.data.name !== slug)
        ) {
          const target = new URL(url);
          target.pathname = `/${parsed.data.data.owner}/${parsed.data.data.name}${segments.length > 2 ? "/" + segments.slice(2).join("/") : ""}`;
          return new Response(null, {
            status: 308,
            headers: { Location: target.toString(), "Cache-Control": "no-store" },
          });
        }
      } else {
        await resolved.body?.cancel();
        if (isDownloadPath(url.pathname) && (resolved.status === 403 || resolved.status === 404))
          return Response.json(
            { error: { code: "not_found", message: "Repository was not found." } },
            { status: resolved.status, headers: { "Cache-Control": "no-store" } }
          );
        if (resolved.status === 403 || resolved.status === 404) {
          const page = await serveSpa(request, env.ASSETS);
          const headers = new Headers(page.headers);
          headers.set("Cache-Control", "no-store");
          return new Response(request.method === "HEAD" ? null : page.body, {
            status: resolved.status,
            headers,
          });
        }
      }
    }
    return serveSpa(request, env.ASSETS);
  }

  return new Response("Not found\n", { status: 404 });
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    return withSecurityHeaders(
      await handleGatewayRequest(request, env),
      new URL(request.url).pathname
    );
  },
};
