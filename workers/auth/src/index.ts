import {
  browserAccountLogout,
  handleBrowserAccounts,
  readBrowserView,
  rememberBrowserLogin,
} from "./browser-accounts";
import { ReservedAccountIdentifiers } from "../../../packages/contracts/src/account";
import { handleSigningKeys } from "./signing-keys";
import { timingSafeEqual } from "node:crypto";
import { handleSso } from "./sso/routes";
import {
  consumeRateLimit,
  LoginInputSchema,
  type RateLimitDecision,
  type RateLimitNamespace,
  RegisterInputSchema,
  type ServiceResult,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { readCookie, issueSession, hashToken, createToken } from "./session";
import { PBKDF2_ITERATIONS } from "./password";
import {
  authenticateAgentSession,
  authenticateGitToken,
  handleAgentManagement,
  handleAgentSessionRevocation,
  handleAgentProfile,
} from "./agents";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";
import {
  repositoryAccessDenied,
  repositoryNotFound,
} from "../../../src/worker/common/repository-response";
import { base64ToBytes, bytesToBase64 } from "../../../src/worker/common/encoding";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import { handleAccountProfile, handleWebSessions } from "./profile";
import {
  authenticateAccessToken,
  handleAccessTokenManagement,
  isAccessToken,
} from "./access-tokens";
import { drainAgentEventOutbox, handleAgentEvent } from "./agent-webhooks";

export type AuthEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: Artifacts;
  readonly RATE_LIMITER: RateLimitNamespace;
  readonly LOG_LEVEL?: string;
  readonly WEBHOOK_ENCRYPTION_KEY?: string;
  readonly ALLOW_PUBLIC_SIGNUP: string;
  readonly DEFAULT_USER_GROUP: string;
  readonly SSO_PROVIDERS_JSON?: string;
  readonly SSO_SECRETS_JSON?: string;
  readonly GITHUB_CLIENT_ID?: string;
  readonly GITHUB_CLIENT_SECRET?: string;
  readonly GITHUB_API_BASE?: string;
  readonly GITHUB_OAUTH_BASE?: string;
};
type UserRow = {
  id: string;
  identifier: string;
  group_key: string;
  password_salt: string;
  password_hash: string;
  password_auth_enabled: number;
};
type SessionRow = { id: string; identifier: string; group_key: string };
type SessionWithExternalIdentityRow = SessionRow & {
  provider: string | null;
  provider_login: string | null;
  avatar_url: string | null;
  profile_url: string | null;
};
type ExternalIdentitySummary = {
  readonly provider: "github";
  readonly login: string;
  readonly avatarUrl?: string;
  readonly profileUrl?: string;
};
type SessionData = TrustedUser & { readonly externalIdentity?: ExternalIdentitySummary };
type GithubOAuthStateRow = {
  code_verifier: string;
  return_to: string;
};
type GithubTokenResponse = { access_token: string; token_type: string; scope: string };
type GithubUserResponse = { id: number; login: string; avatar_url: string; html_url: string };

const GITHUB_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const GITHUB_FLOW_COOKIE = "gitedge_github_flow";

const LOGIN_ATTEMPTS_PER_MINUTE = 10;
const REGISTRATIONS_PER_MINUTE = 5;

function rateLimited(decision: RateLimitDecision): Response | null {
  if (decision.allowed) return null;
  return errorResponse(429, "rate_limited", "Too many attempts. Try again later.", {
    "Retry-After": String(decision.retryAfter),
  });
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array<ArrayBuffer>
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function createPkceVerifier(): string {
  return createToken();
}

async function createPkceChallenge(verifier: string): Promise<string> {
  return (await hashToken(verifier)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function githubOAuthBase(env: AuthEnv): string {
  return env.GITHUB_OAUTH_BASE ?? "https://github.com";
}

function githubApiBase(env: AuthEnv): string {
  return env.GITHUB_API_BASE ?? "https://api.github.com";
}

function githubCallbackUrl(request: Request): string {
  return new URL("/api/auth/github/callback", request.url).toString();
}

function isSafeReturnTo(value: string | null, request: Request): value is string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return false;
  const requestUrl = new URL(request.url);
  const destination = new URL(value, requestUrl.origin);
  return destination.origin === requestUrl.origin;
}

function githubErrorRedirect(
  returnTo: string,
  code: "github_oauth_failed" | "github_signup_disabled"
): Response {
  const destination = new URL(returnTo, "https://gitedge.invalid");
  destination.searchParams.set("error", code);
  return new Response(null, {
    status: 302,
    headers: { Location: `${destination.pathname}${destination.search}` },
  });
}

// Identity-only sign-in requests no scopes, so GitHub must grant none.
function grantsNoScopes(value: string): boolean {
  return value.split(/[,\s]+/).every((scope) => scope.length === 0);
}

function isGithubTokenResponse(value: unknown): value is GithubTokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    "access_token" in value &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0 &&
    "token_type" in value &&
    value.token_type === "bearer" &&
    "scope" in value &&
    typeof value.scope === "string"
  );
}

function isGithubUserResponse(value: unknown): value is GithubUserResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    "id" in value &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    "login" in value &&
    typeof value.login === "string" &&
    value.login.length > 0 &&
    "avatar_url" in value &&
    typeof value.avatar_url === "string" &&
    "html_url" in value &&
    typeof value.html_url === "string"
  );
}

export async function register(
  env: AuthEnv,
  input: unknown
): Promise<ServiceResult<TrustedUser & { readonly sessionToken: string }>> {
  if (env.ALLOW_PUBLIC_SIGNUP !== "true")
    return {
      ok: false,
      status: 403,
      error: { code: "forbidden", message: "Public registration is disabled." },
    };
  const parsed = RegisterInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      status: 400,
      error: { code: "bad_request", message: "Invalid registration payload." },
    };
  const identifier = parsed.data.identifier.toLowerCase();
  if (ReservedAccountIdentifiers.has(identifier))
    return {
      ok: false,
      status: 400,
      error: { code: "bad_request", message: "This identifier is reserved." },
    };
  const existing = await env.DB.prepare(
    "SELECT id FROM users WHERE identifier = ? UNION ALL SELECT namespace_id FROM namespace_slug_history WHERE slug = ? LIMIT 1"
  )
    .bind(identifier, identifier)
    .first<{ id: string }>();
  if (existing)
    return {
      ok: false,
      status: 409,
      error: { code: "conflict", message: "Identifier is already registered." },
    };
  const salt: Uint8Array<ArrayBuffer> = crypto.getRandomValues(new Uint8Array(16));
  const user: TrustedUser = {
    id: crypto.randomUUID(),
    identifier,
    groupKey: env.DEFAULT_USER_GROUP,
  };
  const namespaceId = crypto.randomUUID();
  const now = Date.now();
  const passwordHash = await derivePasswordHash(parsed.data.password, salt);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, identifier, group_key, password_salt, password_hash, password_auth_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(user.id, identifier, user.groupKey, bytesToBase64(salt), passwordHash, 1, now),
      env.DB.prepare(
        "INSERT INTO namespaces (id, slug, created_by, created_at) VALUES (?, ?, ?, ?)"
      ).bind(namespaceId, identifier, user.id, now),
      env.DB.prepare(
        "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) VALUES (?, ?, ?, 'owner')"
      ).bind(namespaceId, user.id, now),
    ]);
  } catch {
    const conflict = await env.DB.prepare(
      "SELECT id FROM namespaces WHERE slug = ? UNION ALL SELECT id FROM users WHERE identifier = ? UNION ALL SELECT namespace_id FROM namespace_slug_history WHERE slug = ? LIMIT 1"
    )
      .bind(identifier, identifier, identifier)
      .first<{ id: string }>()
      .catch(() => null);
    if (conflict)
      return {
        ok: false,
        status: 409,
        error: { code: "conflict", message: "This username is already in use." },
      };
    createLogger(env.LOG_LEVEL, { service: "auth" }).error("auth:registration-failed", {});
    return {
      ok: false,
      status: 503,
      error: { code: "internal_error", message: "Registration is temporarily unavailable." },
    };
  }
  return { ok: true, data: { ...user, sessionToken: await issueSession(env, user.id) } };
}

export async function login(
  env: AuthEnv,
  input: unknown
): Promise<ServiceResult<TrustedUser & { readonly sessionToken: string }>> {
  const parsed = LoginInputSchema.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      status: 400,
      error: { code: "bad_request", message: "Invalid login payload." },
    };
  const identifier = parsed.data.identifier.toLowerCase();
  const user = await env.DB.prepare(
    "SELECT id, identifier, group_key, password_salt, password_hash, password_auth_enabled FROM users WHERE identifier = ?"
  )
    .bind(identifier)
    .first<UserRow>();
  if (!user)
    return {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Invalid identifier or password." },
    };
  if (user.password_auth_enabled !== 1)
    return {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Invalid identifier or password." },
    };
  let passwordMatches = false;
  try {
    const passwordHash = await derivePasswordHash(
      parsed.data.password,
      base64ToBytes(user.password_salt)
    );
    passwordMatches = timingSafeEqual(
      base64ToBytes(passwordHash),
      base64ToBytes(user.password_hash)
    );
  } catch {
    // A malformed stored credential must not reveal a distinct authentication outcome.
    passwordMatches = false;
  }
  if (!passwordMatches)
    return {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Invalid identifier or password." },
    };
  return {
    ok: true,
    data: {
      id: user.id,
      identifier: user.identifier,
      groupKey: user.group_key,
      sessionToken: await issueSession(env, user.id),
    },
  };
}

function externalIdentityFromRow(
  row: SessionWithExternalIdentityRow
): ExternalIdentitySummary | undefined {
  if (row.provider !== "github" || !row.provider_login) return undefined;
  return {
    provider: "github",
    login: row.provider_login,
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    ...(row.profile_url ? { profileUrl: row.profile_url } : {}),
  };
}

export async function session(
  env: AuthEnv,
  token: string | null
): Promise<ServiceResult<SessionData>> {
  if (!token)
    return {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Authentication is required." },
    };
  const row = await env.DB.prepare(
    "SELECT users.id, users.identifier, users.group_key, external_identities.provider, external_identities.provider_login, external_identities.avatar_url, external_identities.profile_url FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id LEFT JOIN external_identities ON external_identities.user_id = users.id AND external_identities.provider = 'github' WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?"
  )
    .bind(await hashToken(token), Date.now())
    .first<SessionWithExternalIdentityRow>();
  if (!row)
    return {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Authentication is required." },
    };
  const externalIdentity = externalIdentityFromRow(row);
  return {
    ok: true,
    data: {
      id: row.id,
      identifier: row.identifier,
      groupKey: row.group_key,
      ...(externalIdentity ? { externalIdentity } : {}),
    },
  };
}

export async function logout(env: AuthEnv, token: string | null): Promise<void> {
  if (token)
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await hashToken(token))
      .run();
}

async function readGithubJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function githubApiUrl(env: AuthEnv, path: string): string {
  return `${githubApiBase(env).replace(/\/$/, "")}${path}`;
}

function githubHeaders(token: string): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

async function fetchGithubApi(env: AuthEnv, token: string, path: string): Promise<unknown | null> {
  const response = await fetch(githubApiUrl(env, path), { headers: githubHeaders(token) });
  const grantedScopes = response.headers.get("X-OAuth-Scopes");
  if (!response.ok || grantedScopes === null || !grantsNoScopes(grantedScopes)) return null;
  return readGithubJson(response);
}

async function findGithubUser(
  env: AuthEnv,
  githubUser: GithubUserResponse
): Promise<TrustedUser | null> {
  const providerUserId = String(githubUser.id);
  const existing = await env.DB.prepare(
    "SELECT users.id, users.identifier, users.group_key FROM external_identities JOIN users ON users.id = external_identities.user_id WHERE external_identities.provider = ? AND external_identities.provider_user_id = ?"
  )
    .bind("github", providerUserId)
    .first<SessionRow>();
  if (!existing) return null;
  await env.DB.prepare(
    "UPDATE external_identities SET provider_login = ?, avatar_url = ?, profile_url = ?, last_verified_at = ? WHERE provider = ? AND provider_user_id = ?"
  )
    .bind(
      githubUser.login,
      githubUser.avatar_url || null,
      githubUser.html_url || null,
      Date.now(),
      "github",
      providerUserId
    )
    .run();
  return { id: existing.id, identifier: existing.identifier, groupKey: existing.group_key };
}

async function createGithubUser(
  env: AuthEnv,
  githubUser: GithubUserResponse
): Promise<TrustedUser> {
  const providerUserId = String(githubUser.id);
  const now = Date.now();
  // This identifier is independent of mutable GitHub account names and never derives from email.
  const user: TrustedUser = {
    id: crypto.randomUUID(),
    identifier: `github-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    groupKey: env.DEFAULT_USER_GROUP,
  };
  const namespaceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, identifier, group_key, password_salt, password_hash, password_auth_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(user.id, user.identifier, user.groupKey, "", "", 0, now),
    env.DB.prepare(
      "INSERT INTO external_identities (provider, provider_user_id, user_id, provider_login, avatar_url, profile_url, created_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      "github",
      providerUserId,
      user.id,
      githubUser.login,
      githubUser.avatar_url || null,
      githubUser.html_url || null,
      now,
      now
    ),
    env.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at) VALUES (?, ?, ?, ?)"
    ).bind(namespaceId, user.identifier, user.id, now),
    env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) VALUES (?, ?, ?, 'owner')"
    ).bind(namespaceId, user.id, now),
  ]);
  return user;
}

export async function startGithubOAuth(request: Request, env: AuthEnv): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
  if (!env.GITHUB_CLIENT_ID || env.GITHUB_CLIENT_ID === "set-with-wrangler-secret-or-vars") {
    logger.error("github-oauth:missing-client-id");
    return errorResponse(503, "bad_request", "GitHub sign-in is not configured.");
  }
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  if (!isSafeReturnTo(returnTo, request))
    return errorResponse(400, "bad_request", "Invalid GitHub sign-in request.");

  const state = createToken();
  const verifier = createPkceVerifier();
  const proof = createToken();
  const now = Date.now();
  await env.DB.prepare("DELETE FROM github_oauth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare(
    "INSERT INTO github_oauth_states (state_hash, code_verifier, return_to, expires_at, created_at, browser_hash) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(
      await hashToken(state),
      verifier,
      returnTo,
      now + GITHUB_STATE_MAX_AGE_MS,
      now,
      await hashToken(proof)
    )
    .run();
  const authorizationUrl = new URL("/login/oauth/authorize", githubOAuthBase(env));
  authorizationUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", githubCallbackUrl(request));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", await createPkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (url.searchParams.get("prompt") === "select_account")
    authorizationUrl.searchParams.set("prompt", "select_account");
  logger.info("github-oauth:started");
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizationUrl.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": `${GITHUB_FLOW_COOKIE}=${proof}; Path=/api/auth/github; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

export async function completeGithubOAuth(request: Request, env: AuthEnv): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
  if (
    !env.GITHUB_CLIENT_ID ||
    env.GITHUB_CLIENT_ID === "set-with-wrangler-secret-or-vars" ||
    !env.GITHUB_CLIENT_SECRET
  ) {
    logger.error("github-oauth:missing-client-config");
    return errorResponse(503, "bad_request", "GitHub sign-in is not configured.");
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const proof = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GITHUB_FLOW_COOKIE}=`))
    ?.slice(GITHUB_FLOW_COOKIE.length + 1);
  if (!state || !proof)
    return errorResponse(400, "bad_request", "Invalid GitHub sign-in response.");
  const oauthState = await env.DB.prepare(
    "DELETE FROM github_oauth_states WHERE state_hash = ? AND expires_at > ? AND browser_hash = ? RETURNING code_verifier, return_to"
  )
    .bind(await hashToken(state), Date.now(), await hashToken(proof))
    .first<GithubOAuthStateRow>();
  if (!oauthState) {
    logger.warn("github-oauth:invalid-state");
    return errorResponse(400, "bad_request", "GitHub sign-in session has expired.");
  }
  if (url.searchParams.has("error")) {
    logger.warn("github-oauth:provider-denied");
    return githubErrorRedirect(oauthState.return_to, "github_oauth_failed");
  }
  const code = url.searchParams.get("code");
  if (!code) return githubErrorRedirect(oauthState.return_to, "github_oauth_failed");
  const tokenResponse = await fetch(
    `${githubOAuthBase(env).replace(/\/$/, "")}/login/oauth/access_token`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: githubCallbackUrl(request),
        code_verifier: oauthState.code_verifier,
      }),
    }
  );
  const tokenPayload = await readGithubJson(tokenResponse);
  if (
    !tokenResponse.ok ||
    !isGithubTokenResponse(tokenPayload) ||
    !grantsNoScopes(tokenPayload.scope)
  ) {
    logger.warn("github-oauth:token-rejected");
    return githubErrorRedirect(oauthState.return_to, "github_oauth_failed");
  }

  const userPayload = await fetchGithubApi(env, tokenPayload.access_token, "/user");
  if (!isGithubUserResponse(userPayload)) {
    logger.warn("github-oauth:user-verification-failed");
    return githubErrorRedirect(oauthState.return_to, "github_oauth_failed");
  }

  const existing = await findGithubUser(env, userPayload);
  if (!existing && env.ALLOW_PUBLIC_SIGNUP !== "true") {
    logger.warn("github-oauth:signup-disabled");
    return githubErrorRedirect(oauthState.return_to, "github_signup_disabled");
  }
  const user = existing ?? (await createGithubUser(env, userPayload));
  const sessionToken = await issueSession(env, user.id);
  logger.info("github-oauth:completed", { userId: user.id });
  return rememberBrowserLogin(
    request,
    env,
    user.id,
    sessionToken,
    new Response(null, {
      status: 302,
      headers: { Location: oauthState.return_to },
    })
  );
}

export default {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/internal/health") return dataResponse({ ok: true });
    let humanSession: Promise<ServiceResult<SessionData>> | undefined;
    const getHumanSession = () => (humanSession ??= session(env, readCookie(request)));
    if (path === "/accounts" || path.startsWith("/accounts/"))
      return handleBrowserAccounts(request, env);
    const browserView = readBrowserView(request);
    const expectedView = request.headers.get("X-GitEdge-Expected-View");
    if (
      expectedView &&
      !["/session", "/browser-session"].includes(path) &&
      expectedView !== (browserView ? "guest" : "account")
    )
      return errorResponse(
        409,
        "conflict",
        "The active perspective changed. Reload before continuing."
      );
    if (
      browserView &&
      ![
        "/session",
        "/browser-session",
        "/logout",
        "/login",
        "/register",
        "/github/start",
        "/github/callback",
        "/sso/providers",
      ].includes(path) &&
      !/^\/sso\/[^/]+\/(start|callback|metadata)$/.test(path) &&
      !/^\/agent-profiles\//.test(path)
    )
      return errorResponse(
        403,
        "forbidden",
        "Return to your account perspective to manage human account settings."
      );
    if (
      ["/login", "/register", "/logout"].includes(path) &&
      request.method === "POST" &&
      request.headers.get("Origin") !== new URL(request.url).origin
    )
      return errorResponse(403, "forbidden", "Same-origin authentication is required.");
    const expectedUser = request.headers.get("X-GitEdge-Expected-User");
    if (expectedUser && !["/session", "/browser-session"].includes(path)) {
      const expectedSession = await getHumanSession();
      if (!expectedSession.ok || expectedSession.data.id !== expectedUser)
        return errorResponse(
          409,
          "conflict",
          "The active account changed. Reload before continuing."
        );
    }
    if (path.startsWith("/sso/")) {
      const active = request.headers.has("Authorization") ? null : await getHumanSession();
      return handleSso(request, env, active?.ok ? active.data : null);
    }
    if (path === "/signing-keys" || path.startsWith("/signing-keys/")) {
      const active = await getHumanSession();
      if (!active.ok) return errorResponse(active.status, active.error.code, active.error.message);
      return handleSigningKeys(request, env, active.data);
    }
    if (request.method === "GET" && path === "/git-session") {
      const result = await authenticateGitToken(request, env);
      if (result.outcome === "granted") return dataResponse(result.grant);
      if (result.outcome === "not_found")
        return result.privateRepository ? repositoryAccessDenied() : repositoryNotFound();
      if (result.outcome === "insufficient_scope")
        return errorResponse(
          403,
          "insufficient_scope",
          "Access token does not grant access to this repository."
        );
      return errorResponse(401, "unauthorized", "Invalid Git credential.");
    }
    if (request.method === "GET" && path === "/github/start") return startGithubOAuth(request, env);
    if (request.method === "GET" && path === "/github/callback")
      return completeGithubOAuth(request, env);
    if (request.method === "POST" && path === "/register") {
      const limited = rateLimited(
        await consumeRateLimit(
          env.RATE_LIMITER,
          `register:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
          REGISTRATIONS_PER_MINUTE
        )
      );
      if (limited) {
        logger.warn("auth:register-rate-limited");
        return limited;
      }
      const result = await register(env, await readJsonLimited(request, SMALL_JSON_BYTES));
      if (!result.ok) return errorResponse(result.status, result.error.code, result.error.message);
      logger.info("auth:registered", { userId: result.data.id });
      return rememberBrowserLogin(
        request,
        env,
        result.data.id,
        result.data.sessionToken,
        dataResponse(
          {
            id: result.data.id,
            identifier: result.data.identifier,
            groupKey: result.data.groupKey,
          },
          201
        )
      );
    }
    if (request.method === "POST" && path === "/login") {
      const body = await readJsonLimited(request, SMALL_JSON_BYTES);
      const parsedLogin = LoginInputSchema.safeParse(body);
      if (parsedLogin.success) {
        const limited = rateLimited(
          await consumeRateLimit(
            env.RATE_LIMITER,
            `login:${parsedLogin.data.identifier.toLowerCase()}`,
            LOGIN_ATTEMPTS_PER_MINUTE
          )
        );
        if (limited) {
          logger.warn("auth:login-rate-limited");
          return limited;
        }
      }
      const result = await login(env, body);
      if (!result.ok) return errorResponse(result.status, result.error.code, result.error.message);
      logger.info("auth:logged-in", { userId: result.data.id });
      return rememberBrowserLogin(
        request,
        env,
        result.data.id,
        result.data.sessionToken,
        dataResponse(
          {
            id: result.data.id,
            identifier: result.data.identifier,
            groupKey: result.data.groupKey,
          },
          200
        )
      );
    }
    if (request.method === "POST" && path === "/logout") {
      return browserAccountLogout(request, env);
    }
    if (path === "/_internal/agent-events" && request.method === "POST") {
      if (new URL(request.url).hostname !== "auth.internal")
        return errorResponse(404, "bad_request", "Endpoint was not found.");
      try {
        const result = await handleAgentEvent(request, env);
        if (result === "invalid") return errorResponse(400, "bad_request", "Invalid agent event.");
        if (result === "full")
          return errorResponse(503, "service_unavailable", "Agent event queue is full.");
        return dataResponse({ accepted: result === "queued" }, 202);
      } catch {
        return errorResponse(503, "service_unavailable", "Agent event could not be queued.");
      }
    }
    if (path === "/_internal/agent-sessions/revoke" && request.method === "POST") {
      if (new URL(request.url).hostname !== "auth.internal")
        return errorResponse(404, "bad_request", "Endpoint was not found.");
      return handleAgentSessionRevocation(request, env);
    }
    if (request.method === "GET" && path === "/browser-session") {
      if (browserView) return dataResponse({ user: null, view: { kind: "guest" } });
      const result = await getHumanSession();
      return dataResponse({ user: result.ok ? result.data : null, view: { kind: "account" } });
    }
    if (request.method === "GET" && path === "/session") {
      if (browserView) return jsonResponse({ data: null, view: "guest" });
      const authorization = request.headers.get("Authorization");
      if (authorization) {
        const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : null;
        const user =
          bearer === null
            ? null
            : isAccessToken(bearer)
              ? await authenticateAccessToken(env, bearer)
              : await authenticateAgentSession(env, bearer);
        return user
          ? dataResponse(user)
          : errorResponse(401, "unauthorized", "Invalid access token or agent session.");
      }
      const result = await getHumanSession();
      if (!result.ok) return errorResponse(result.status, result.error.code, result.error.message);
      return dataResponse(result.data);
    }
    if (/^\/agent-profiles\//.test(path)) {
      const profileSession = browserView ? null : await getHumanSession();
      return handleAgentProfile(request, env, profileSession?.ok ? profileSession.data : null);
    }
    if (/^\/(agents|sessions|tokens|web-sessions)(\/|$)/.test(path)) {
      const authorization = request.headers.get("Authorization");
      const agent = authorization?.startsWith("Bearer ")
        ? await authenticateAgentSession(env, authorization.slice(7))
        : null;
      if (agent)
        return errorResponse(403, "forbidden", "Agent sessions cannot manage human accounts.");
      const active = await getHumanSession();
      if (!active.ok) return errorResponse(active.status, active.error.code, active.error.message);
      if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
        return errorResponse(403, "forbidden", "Same-origin account management is required.");
      const webSessions = await handleWebSessions(
        request,
        env,
        active.data,
        await hashToken(readCookie(request) ?? "")
      );
      if (webSessions) return webSessions;
      const result = await handleAgentManagement(request, env, active.data);
      if (result) return result;
    }
    if (path === "/access-tokens" || path.startsWith("/access-tokens/")) {
      const active = await getHumanSession();
      if (!active.ok) return errorResponse(active.status, active.error.code, active.error.message);
      return handleAccessTokenManagement(request, env, active.data);
    }
    if (path === "/profile") {
      const authorization = request.headers.get("Authorization");
      const agent = authorization?.startsWith("Bearer ")
        ? await authenticateAgentSession(env, authorization.slice(7))
        : null;
      if (agent)
        return errorResponse(403, "forbidden", "Agent sessions cannot manage human accounts.");
      const active = await getHumanSession();
      if (!active.ok) return errorResponse(active.status, active.error.code, active.error.message);
      return handleAccountProfile(request, env, active.data);
    }
    return request.method === "GET" || request.method === "POST"
      ? errorResponse(404, "bad_request", "Unknown auth endpoint.")
      : errorResponse(405, "method_not_allowed", "Method is not allowed.");
  },
  async scheduled(_controller: ScheduledController, env: AuthEnv): Promise<void> {
    await drainAgentEventOutbox(env);
  },
};
