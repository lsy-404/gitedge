import { ReservedAccountIdentifiers } from "../../../packages/contracts/src/account";
import { handleSigningKeys } from "./signing-keys";
import { timingSafeEqual } from "node:crypto";
import { handleSso } from "./sso/routes";
import {
  LoginInputSchema,
  RegisterInputSchema,
  type ServiceResult,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import {
  bytesToBase64,
  createSessionCookie,
  readCookie,
  issueSession,
  hashToken,
  createToken,
  SESSION_MAX_AGE_SECONDS,
} from "./session";
import { PBKDF2_ITERATIONS } from "./password";
import {
  authenticateAgentSession,
  authenticateGitToken,
  handleAgentManagement,
  handleAgentProfile,
} from "./agents";
import { handleAccountProfile, handleWebSessions } from "./profile";
import { handleAgentEvent } from "./agent-webhooks";

export type AuthEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: Artifacts;
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

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function fail(
  status: number,
  code: "bad_request" | "unauthorized" | "forbidden" | "conflict" | "method_not_allowed",
  message: string
): Response {
  return json({ error: { code, message } }, status);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
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

function githubErrorRedirect(returnTo: string): Response {
  const destination = new URL(returnTo, "https://gitedge.invalid");
  destination.searchParams.set("error", "github_oauth_failed");
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
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
  const existing = await env.DB.prepare("SELECT id FROM users WHERE identifier = ?")
    .bind(identifier)
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
      "SELECT id FROM namespaces WHERE slug = ? UNION ALL SELECT id FROM users WHERE identifier = ? LIMIT 1"
    )
      .bind(identifier, identifier)
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

async function findOrCreateGithubUser(
  env: AuthEnv,
  githubUser: GithubUserResponse
): Promise<TrustedUser> {
  const providerUserId = String(githubUser.id);
  const existing = await env.DB.prepare(
    "SELECT users.id, users.identifier, users.group_key FROM external_identities JOIN users ON users.id = external_identities.user_id WHERE external_identities.provider = ? AND external_identities.provider_user_id = ?"
  )
    .bind("github", providerUserId)
    .first<SessionRow>();
  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      "UPDATE external_identities SET provider_login = ?, avatar_url = ?, profile_url = ?, last_verified_at = ? WHERE provider = ? AND provider_user_id = ?"
    )
      .bind(
        githubUser.login,
        githubUser.avatar_url || null,
        githubUser.html_url || null,
        now,
        "github",
        providerUserId
      )
      .run();
    return { id: existing.id, identifier: existing.identifier, groupKey: existing.group_key };
  }

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
    return fail(503, "bad_request", "GitHub sign-in is not configured.");
  }
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  if (!isSafeReturnTo(returnTo, request))
    return fail(400, "bad_request", "Invalid GitHub sign-in request.");

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
    return fail(503, "bad_request", "GitHub sign-in is not configured.");
  }
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const proof = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${GITHUB_FLOW_COOKIE}=`))
    ?.slice(GITHUB_FLOW_COOKIE.length + 1);
  if (!state || !proof) return fail(400, "bad_request", "Invalid GitHub sign-in response.");
  const oauthState = await env.DB.prepare(
    "DELETE FROM github_oauth_states WHERE state_hash = ? AND expires_at > ? AND browser_hash = ? RETURNING code_verifier, return_to"
  )
    .bind(await hashToken(state), Date.now(), await hashToken(proof))
    .first<GithubOAuthStateRow>();
  if (!oauthState) {
    logger.warn("github-oauth:invalid-state");
    return fail(400, "bad_request", "GitHub sign-in session has expired.");
  }
  if (url.searchParams.has("error")) {
    logger.warn("github-oauth:provider-denied");
    return githubErrorRedirect(oauthState.return_to);
  }
  const code = url.searchParams.get("code");
  if (!code) return githubErrorRedirect(oauthState.return_to);
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
    return githubErrorRedirect(oauthState.return_to);
  }

  const userPayload = await fetchGithubApi(env, tokenPayload.access_token, "/user");
  if (!isGithubUserResponse(userPayload)) {
    logger.warn("github-oauth:user-verification-failed");
    return githubErrorRedirect(oauthState.return_to);
  }

  const user = await findOrCreateGithubUser(env, userPayload);
  const sessionToken = await issueSession(env, user.id);
  logger.info("github-oauth:completed", { userId: user.id });
  return new Response(null, {
    status: 302,
    headers: {
      Location: oauthState.return_to,
      "Set-Cookie": createSessionCookie(sessionToken, SESSION_MAX_AGE_SECONDS),
    },
  });
}

export default {
  async fetch(request: Request, env: AuthEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
    const path = new URL(request.url).pathname;
    if (path.startsWith("/sso/")) {
      const active = request.headers.has("Authorization")
        ? null
        : await session(env, readCookie(request));
      return handleSso(request, env, active?.ok ? active.data : null);
    }
    if (path === "/signing-keys" || path.startsWith("/signing-keys/")) {
      const active = await session(env, readCookie(request));
      if (!active.ok) return json({ error: active.error }, active.status);
      return handleSigningKeys(request, env, active.data);
    }
    if (request.method === "GET" && path === "/git-session") {
      const authenticated = await authenticateGitToken(request, env);
      return authenticated
        ? json({ data: authenticated }, 200, { "Cache-Control": "no-store" })
        : fail(401, "unauthorized", "Invalid Git credential.");
    }
    if (request.method === "GET" && path === "/github/start") return startGithubOAuth(request, env);
    if (request.method === "GET" && path === "/github/callback")
      return completeGithubOAuth(request, env);
    if (request.method === "POST" && path === "/register") {
      const result = await register(env, await readJson(request));
      if (!result.ok) return json({ error: result.error }, result.status);
      logger.info("auth:registered", { userId: result.data.id });
      return json(
        {
          data: {
            id: result.data.id,
            identifier: result.data.identifier,
            groupKey: result.data.groupKey,
          },
        },
        201,
        {
          "Set-Cookie": createSessionCookie(result.data.sessionToken, SESSION_MAX_AGE_SECONDS),
        }
      );
    }
    if (request.method === "POST" && path === "/login") {
      const result = await login(env, await readJson(request));
      if (!result.ok) return json({ error: result.error }, result.status);
      logger.info("auth:logged-in", { userId: result.data.id });
      return json(
        {
          data: {
            id: result.data.id,
            identifier: result.data.identifier,
            groupKey: result.data.groupKey,
          },
        },
        200,
        {
          "Set-Cookie": createSessionCookie(result.data.sessionToken, SESSION_MAX_AGE_SECONDS),
        }
      );
    }
    if (request.method === "POST" && path === "/logout") {
      await logout(env, readCookie(request));
      return json({ data: { loggedOut: true } }, 200, { "Set-Cookie": createSessionCookie("", 0) });
    }
    if (path === "/_internal/agent-events" && request.method === "POST") {
      await handleAgentEvent(request, env);
      return json({ data: { accepted: true } }, 202);
    }
    if (request.method === "GET" && path === "/session") {
      const authorization = request.headers.get("Authorization");
      if (authorization) {
        const user = authorization.startsWith("Bearer ")
          ? await authenticateAgentSession(env, authorization.slice(7))
          : null;
        return user
          ? json({ data: user }, 200, { "Cache-Control": "no-store" })
          : fail(401, "unauthorized", "Invalid agent session.");
      }
      const result = await session(env, readCookie(request));
      return result.ok ? json({ data: result.data }) : json({ error: result.error }, result.status);
    }
    if (/^\/agent-profiles\//.test(path)) {
      const profileSession = await session(env, readCookie(request));
      return handleAgentProfile(request, env, profileSession.ok ? profileSession.data : null);
    }
    if (/^\/(agents|sessions|tokens|web-sessions)(\/|$)/.test(path)) {
      const authorization = request.headers.get("Authorization");
      const agent = authorization?.startsWith("Bearer ")
        ? await authenticateAgentSession(env, authorization.slice(7))
        : null;
      if (agent) return fail(403, "forbidden", "Agent sessions cannot manage human accounts.");
      const active = await session(env, readCookie(request));
      if (!active.ok) return json({ error: active.error }, active.status);
      if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
        return fail(403, "forbidden", "Same-origin account management is required.");
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
    if (path === "/profile") {
      const authorization = request.headers.get("Authorization");
      const agent = authorization?.startsWith("Bearer ")
        ? await authenticateAgentSession(env, authorization.slice(7))
        : null;
      if (agent) return fail(403, "forbidden", "Agent sessions cannot manage human accounts.");
      const active = await session(env, readCookie(request));
      if (!active.ok) return json({ error: active.error }, active.status);
      return handleAccountProfile(request, env, active.data);
    }
    return request.method === "GET" || request.method === "POST"
      ? fail(404, "bad_request", "Unknown auth endpoint.")
      : fail(405, "method_not_allowed", "Method is not allowed.");
  },
};
