import {
  LoginInputSchema,
  RegisterInputSchema,
  type ServiceResult,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { authenticateAgentSession, authenticateGitToken, handleAgentManagement } from "./agents";

type AuthEnv = {
  readonly DB: D1Database;
  readonly ARTIFACTS: Artifacts;
  readonly LOG_LEVEL?: string;
  readonly ALLOW_PUBLIC_SIGNUP: string;
  readonly DEFAULT_USER_GROUP: string;
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
  access_level: "identity" | "read" | null;
  emails_json: string | null;
  organizations_json: string | null;
};
type ExternalIdentitySummary = {
  readonly provider: "github";
  readonly login: string;
  readonly avatarUrl?: string;
  readonly profileUrl?: string;
  readonly accessLevel: "identity" | "read";
  readonly emails?: readonly string[];
  readonly organizations?: readonly GithubOrganizationSummary[];
};
type SessionData = TrustedUser & { readonly externalIdentity?: ExternalIdentitySummary };
type GithubOAuthStateRow = {
  code_verifier: string;
  access_level: "identity" | "read";
  return_to: string;
};
type GithubTokenResponse = { access_token: string; token_type: string; scope: string };
type GithubUserResponse = { id: number; login: string; avatar_url: string; html_url: string };
type GithubEmail = { email: string; verified: boolean };
type GithubOrganization = { id: number; login: string; avatar_url: string };
type GithubOrganizationSummary = {
  readonly id: number;
  readonly login: string;
  readonly avatarUrl: string;
};

const SESSION_COOKIE = "gitedge_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const GITHUB_STATE_MAX_AGE_MS = 10 * 60 * 1000;
const GITHUB_READ_SCOPES = ["read:user", "user:email", "read:org"] as const;
export const PBKDF2_ITERATIONS = 100_000;

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

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
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

async function hashToken(token: string): Promise<string> {
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))
  );
}

function createToken(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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

function splitScopes(value: string): Set<string> {
  return new Set(value.split(/[,\s]+/).filter((scope) => scope.length > 0));
}

function scopesMatch(accessLevel: "identity" | "read", value: string): boolean {
  const actual = splitScopes(value);
  const expected = accessLevel === "identity" ? [] : GITHUB_READ_SCOPES;
  return actual.size === expected.length && expected.every((scope) => actual.has(scope));
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

function createSessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const entry = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return entry ? entry.slice(SESSION_COOKIE.length + 1) : null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function issueSession(env: AuthEnv, userId: string): Promise<string> {
  const token = createToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(await hashToken(token), userId, now + SESSION_MAX_AGE_SECONDS * 1000, now)
    .run();
  return token;
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
  await env.DB.prepare(
    "INSERT INTO users (id, identifier, group_key, password_salt, password_hash, password_auth_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      user.id,
      identifier,
      user.groupKey,
      bytesToBase64(salt),
      await derivePasswordHash(parsed.data.password, salt),
      1,
      Date.now()
    )
    .run();
  const namespaceId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at) VALUES (?, ?, ?, ?)"
    ).bind(namespaceId, identifier, user.id, now),
    env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at) VALUES (?, ?, ?)"
    ).bind(namespaceId, user.id, now),
  ]);
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
    passwordMatches = crypto.subtle.timingSafeEqual(
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

function parseStringArray(value: string | null): readonly string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseOrganizations(
  value: string | null
): readonly GithubOrganizationSummary[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const organizations: GithubOrganizationSummary[] = [];
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !("id" in entry) ||
        typeof entry.id !== "number" ||
        !Number.isSafeInteger(entry.id) ||
        !("login" in entry) ||
        typeof entry.login !== "string" ||
        !("avatarUrl" in entry) ||
        typeof entry.avatarUrl !== "string"
      )
        return undefined;
      organizations.push({ id: entry.id, login: entry.login, avatarUrl: entry.avatarUrl });
    }
    return organizations;
  } catch {
    return undefined;
  }
}

function externalIdentityFromRow(
  row: SessionWithExternalIdentityRow
): ExternalIdentitySummary | undefined {
  if (
    row.provider !== "github" ||
    !row.provider_login ||
    (row.access_level !== "identity" && row.access_level !== "read")
  )
    return undefined;
  const emails = row.access_level === "read" ? parseStringArray(row.emails_json) : undefined;
  const organizations =
    row.access_level === "read" ? parseOrganizations(row.organizations_json) : undefined;
  return {
    provider: "github",
    login: row.provider_login,
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    ...(row.profile_url ? { profileUrl: row.profile_url } : {}),
    accessLevel: row.access_level,
    ...(emails ? { emails } : {}),
    ...(organizations ? { organizations } : {}),
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
    "SELECT users.id, users.identifier, users.group_key, external_identities.provider, external_identities.provider_login, external_identities.avatar_url, external_identities.profile_url, external_identities.access_level, external_identities.emails_json, external_identities.organizations_json FROM auth_sessions JOIN users ON users.id = auth_sessions.user_id LEFT JOIN external_identities ON external_identities.user_id = users.id AND external_identities.provider = 'github' WHERE auth_sessions.token_hash = ? AND auth_sessions.expires_at > ?"
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

async function fetchGithubApi(
  env: AuthEnv,
  token: string,
  path: string,
  accessLevel: "identity" | "read"
): Promise<unknown | null> {
  const response = await fetch(githubApiUrl(env, path), { headers: githubHeaders(token) });
  const grantedScopes = response.headers.get("X-OAuth-Scopes");
  if (!response.ok || grantedScopes === null || !scopesMatch(accessLevel, grantedScopes))
    return null;
  return readGithubJson(response);
}

function isGithubEmailsResponse(value: unknown): value is GithubEmail[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        "email" in entry &&
        typeof entry.email === "string" &&
        "verified" in entry &&
        typeof entry.verified === "boolean"
    )
  );
}

function isGithubOrganizationsResponse(value: unknown): value is GithubOrganization[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        "id" in entry &&
        typeof entry.id === "number" &&
        Number.isSafeInteger(entry.id) &&
        entry.id > 0 &&
        "login" in entry &&
        typeof entry.login === "string" &&
        "avatar_url" in entry &&
        typeof entry.avatar_url === "string"
    )
  );
}

async function findOrCreateGithubUser(
  env: AuthEnv,
  githubUser: GithubUserResponse,
  accessLevel: "identity" | "read",
  emails: readonly string[] | undefined,
  organizations: readonly GithubOrganizationSummary[] | undefined
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
      "UPDATE external_identities SET provider_login = ?, avatar_url = ?, profile_url = ?, access_level = ?, emails_json = ?, organizations_json = ?, last_verified_at = ? WHERE provider = ? AND provider_user_id = ?"
    )
      .bind(
        githubUser.login,
        githubUser.avatar_url || null,
        githubUser.html_url || null,
        accessLevel,
        emails ? JSON.stringify(emails) : null,
        organizations ? JSON.stringify(organizations) : null,
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
    identifier: `github-${createToken().slice(0, 24).toLowerCase()}`,
    groupKey: env.DEFAULT_USER_GROUP,
  };
  const namespaceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, identifier, group_key, password_salt, password_hash, password_auth_enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(user.id, user.identifier, user.groupKey, "", "", 0, now),
    env.DB.prepare(
      "INSERT INTO external_identities (provider, provider_user_id, user_id, provider_login, avatar_url, profile_url, access_level, emails_json, organizations_json, created_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      "github",
      providerUserId,
      user.id,
      githubUser.login,
      githubUser.avatar_url || null,
      githubUser.html_url || null,
      accessLevel,
      emails ? JSON.stringify(emails) : null,
      organizations ? JSON.stringify(organizations) : null,
      now,
      now
    ),
    env.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at) VALUES (?, ?, ?, ?)"
    ).bind(namespaceId, user.identifier, user.id, now),
    env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at) VALUES (?, ?, ?)"
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
  const access = url.searchParams.get("access");
  const returnTo = url.searchParams.get("returnTo");
  if ((access !== "identity" && access !== "read") || !isSafeReturnTo(returnTo, request))
    return fail(400, "bad_request", "Invalid GitHub sign-in request.");

  const state = createToken();
  const verifier = createPkceVerifier();
  const now = Date.now();
  await env.DB.prepare("DELETE FROM github_oauth_states WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare(
    "INSERT INTO github_oauth_states (state_hash, code_verifier, access_level, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(await hashToken(state), verifier, access, returnTo, now + GITHUB_STATE_MAX_AGE_MS, now)
    .run();
  const authorizationUrl = new URL("/login/oauth/authorize", githubOAuthBase(env));
  authorizationUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", githubCallbackUrl(request));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", await createPkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (access === "read") authorizationUrl.searchParams.set("scope", GITHUB_READ_SCOPES.join(" "));
  logger.info("github-oauth:started", { access });
  return Response.redirect(authorizationUrl.toString(), 302);
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
  if (!state) return fail(400, "bad_request", "Invalid GitHub sign-in response.");
  const oauthState = await env.DB.prepare(
    "DELETE FROM github_oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING code_verifier, access_level, return_to"
  )
    .bind(await hashToken(state), Date.now())
    .first<GithubOAuthStateRow>();
  if (!oauthState) {
    logger.warn("github-oauth:invalid-state");
    return fail(400, "bad_request", "GitHub sign-in session has expired.");
  }
  if (url.searchParams.has("error")) {
    logger.warn("github-oauth:provider-denied", { access: oauthState.access_level });
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
    !scopesMatch(oauthState.access_level, tokenPayload.scope)
  ) {
    logger.warn("github-oauth:token-rejected", { access: oauthState.access_level });
    return githubErrorRedirect(oauthState.return_to);
  }

  const userPayload = await fetchGithubApi(
    env,
    tokenPayload.access_token,
    "/user",
    oauthState.access_level
  );
  if (!isGithubUserResponse(userPayload)) {
    logger.warn("github-oauth:user-verification-failed", { access: oauthState.access_level });
    return githubErrorRedirect(oauthState.return_to);
  }
  let emails: readonly string[] | undefined;
  let organizations: readonly GithubOrganizationSummary[] | undefined;
  if (oauthState.access_level === "read") {
    const [emailsResponse, organizationsResponse] = await Promise.all([
      fetchGithubApi(env, tokenPayload.access_token, "/user/emails", oauthState.access_level),
      fetchGithubApi(env, tokenPayload.access_token, "/user/orgs", oauthState.access_level),
    ]);
    if (!isGithubEmailsResponse(emailsResponse)) {
      logger.warn("github-oauth:read-verification-failed");
      return githubErrorRedirect(oauthState.return_to);
    }
    if (!isGithubOrganizationsResponse(organizationsResponse)) {
      logger.warn("github-oauth:read-verification-failed");
      return githubErrorRedirect(oauthState.return_to);
    }
    emails = emailsResponse.filter((email) => email.verified).map((email) => email.email);
    organizations = organizationsResponse.map((organization) => ({
      id: organization.id,
      login: organization.login,
      avatarUrl: organization.avatar_url,
    }));
  }

  const user = await findOrCreateGithubUser(
    env,
    userPayload,
    oauthState.access_level,
    emails,
    organizations
  );
  const sessionToken = await issueSession(env, user.id);
  logger.info("github-oauth:completed", { userId: user.id, access: oauthState.access_level });
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
    if (/^\/(agents|sessions|tokens)(\/|$)/.test(path)) {
      const active = await session(env, readCookie(request));
      if (!active.ok) return json({ error: active.error }, active.status);
      if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
        return fail(403, "forbidden", "Same-origin account management is required.");
      const result = await handleAgentManagement(request, env, active.data);
      if (result) return result;
    }
    return request.method === "GET" || request.method === "POST"
      ? fail(404, "bad_request", "Unknown auth endpoint.")
      : fail(405, "method_not_allowed", "Method is not allowed.");
  },
};
