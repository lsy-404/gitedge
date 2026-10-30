import OAuth2Server from "@node-oauth/oauth2-server";
import { z } from "zod";
import {
  GitOAuthConsentSchema,
  GitOAuthRequestSchema,
} from "../../../packages/contracts/src/oauth";
import {
  ACCESS_TOKEN_PREFIX,
  sha256Hex,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { recordAudit } from "../../../src/worker/common/audit";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse, requireRecentAuth } from "../../../src/worker/common/http";
import {
  readJsonLimited,
  readTextLimited,
  SMALL_JSON_BYTES,
} from "../../../src/worker/common/readText";

const client: OAuth2Server.Client = {
  id: "gitedge-gcm",
  grants: ["authorization_code", "refresh_token"],
  redirectUris: ["http://127.0.0.1/"],
};
const scopes = z.array(z.enum(["repo:read", "repo:write"])).min(1);
const OAuthUser = z.object({
  id: z.string(),
  accessId: z.string().optional(),
  refreshHash: z.string().optional(),
});
interface Env {
  DB: D1Database;
  LOG_LEVEL?: string;
}
interface CodeRow {
  userId: string;
  redirectUri: string;
  challenge: string;
  scopesJson: string;
  expiresAt: number;
}
interface RefreshRow {
  userId: string;
  accessId: string;
  scopesJson: string;
  expiresAt: number;
}
function validRedirect(value: string): boolean {
  try {
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?\/?$/.test(value))
      return false;
    const u = new URL(value);
    return (
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      u.pathname === "/" &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
function parsedScopes(value: string): string[] | null {
  const parts = value.split(" ").filter(Boolean);
  const valid = scopes.safeParse(parts);
  return valid.success && new Set(parts).size === parts.length ? parts : null;
}
function model(env: Env): OAuth2Server.AuthorizationCodeModel & OAuth2Server.RefreshTokenModel {
  return {
    async getClient(id, secret) {
      return id === client.id && !secret ? client : false;
    },
    async getAccessToken() {
      return false;
    },
    async validateRedirectUri(uri) {
      return validRedirect(uri);
    },
    async validateScope(_user, _client, scope) {
      const result = scopes.safeParse(scope);
      return result.success ? result.data : false;
    },
    async generateAccessToken() {
      return ACCESS_TOKEN_PREFIX + randomHex(32);
    },
    async saveAuthorizationCode(code, c, user) {
      const u = OAuthUser.parse(user);
      await env.DB.prepare(
        "INSERT INTO auth_git_oauth_codes (code_hash,user_id,redirect_uri,challenge,scopes_json,expires_at) VALUES (?,?,?,?,?,?)"
      )
        .bind(
          await sha256Hex(code.authorizationCode),
          u.id,
          code.redirectUri,
          code.codeChallenge,
          JSON.stringify(code.scope),
          code.expiresAt.getTime()
        )
        .run();
      return { ...code, client: c, user };
    },
    async getAuthorizationCode(value) {
      const row = await env.DB.prepare(
        "SELECT c.user_id AS userId,c.redirect_uri AS redirectUri,c.challenge,c.scopes_json AS scopesJson,c.expires_at AS expiresAt FROM auth_git_oauth_codes c JOIN users u ON u.id=c.user_id WHERE c.code_hash=? AND c.expires_at>? AND u.disabled_at IS NULL"
      )
        .bind(await sha256Hex(value), Date.now())
        .first<CodeRow>();
      if (!row) return false;
      return {
        authorizationCode: value,
        expiresAt: new Date(row.expiresAt),
        redirectUri: row.redirectUri,
        codeChallenge: row.challenge,
        codeChallengeMethod: "S256",
        scope: scopes.parse(JSON.parse(row.scopesJson)),
        client,
        user: { id: row.userId },
      };
    },
    async revokeAuthorizationCode(code) {
      const result = await env.DB.prepare(
        "DELETE FROM auth_git_oauth_codes WHERE code_hash=? AND expires_at>?"
      )
        .bind(await sha256Hex(code.authorizationCode), Date.now())
        .run();
      return result.meta.changes === 1;
    },
    async getRefreshToken(value) {
      const row = await env.DB.prepare(
        "SELECT t.user_id AS userId,t.id AS accessId,t.scopes_json AS scopesJson,r.expires_at AS expiresAt FROM auth_git_oauth_refresh r JOIN auth_access_tokens t ON t.id=r.access_id JOIN users u ON u.id=t.user_id WHERE r.token_hash=? AND r.expires_at>? AND r.consumed_at IS NULL AND t.revoked_at IS NULL AND u.disabled_at IS NULL"
      )
        .bind(await sha256Hex(value), Date.now())
        .first<RefreshRow>();
      if (!row) return false;
      return {
        refreshToken: value,
        refreshTokenExpiresAt: new Date(row.expiresAt),
        scope: scopes.parse(JSON.parse(row.scopesJson)),
        client,
        user: { id: row.userId, accessId: row.accessId, refreshHash: await sha256Hex(value) },
      };
    },
    async revokeToken(token) {
      const result = await env.DB.prepare(
        "UPDATE auth_git_oauth_refresh SET consumed_at=? WHERE token_hash=? AND expires_at>? AND consumed_at IS NULL"
      )
        .bind(Date.now(), await sha256Hex(token.refreshToken), Date.now())
        .run();
      return result.meta.changes === 1;
    },
    async saveToken(token, c, user) {
      const u = OAuthUser.parse(user);
      const now = Date.now();
      if (!token.accessTokenExpiresAt || !token.refreshToken || !token.refreshTokenExpiresAt)
        return false;
      const id = u.accessId ?? crypto.randomUUID();
      const accessHash = await sha256Hex(token.accessToken);
      const refreshHash = await sha256Hex(token.refreshToken);
      if (u.accessId) {
        const result = await env.DB.prepare(
          "UPDATE auth_access_tokens SET token_hash=?,prefix=?,expires_at=?,scopes_json=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)"
        )
          .bind(
            accessHash,
            token.accessToken.slice(0, 12),
            token.accessTokenExpiresAt.getTime(),
            JSON.stringify(token.scope),
            id,
            u.id,
            u.id
          )
          .run();
        if (result.meta.changes !== 1) return false;
      } else {
        const result = await env.DB.prepare(
          "INSERT INTO auth_access_tokens (id,user_id,name,token_hash,prefix,scopes_json,repository_ids_json,expires_at,created_at) SELECT ?,?,'Git Credential Manager',?,?,?,NULL,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL) AND (SELECT COUNT(*) FROM auth_access_tokens WHERE user_id=? AND revoked_at IS NULL AND (expires_at=0 OR expires_at>? OR EXISTS (SELECT 1 FROM auth_git_oauth_refresh r WHERE r.access_id=auth_access_tokens.id AND r.expires_at>?))) < 100"
        )
          .bind(
            id,
            u.id,
            accessHash,
            token.accessToken.slice(0, 12),
            JSON.stringify(token.scope),
            token.accessTokenExpiresAt.getTime(),
            now,
            u.id,
            u.id,
            now,
            now
          )
          .run();
        if (result.meta.changes !== 1) return false;
      }
      const insertRefresh = env.DB.prepare(
        "INSERT INTO auth_git_oauth_refresh (token_hash,access_id,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM auth_access_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=? AND t.revoked_at IS NULL AND u.disabled_at IS NULL)"
      ).bind(refreshHash, id, token.refreshTokenExpiresAt.getTime(), id);
      const inserted = u.refreshHash
        ? (
            await env.DB.batch([
              insertRefresh,
              env.DB.prepare(
                "DELETE FROM auth_git_oauth_refresh WHERE token_hash=? AND consumed_at IS NOT NULL AND changes()=1"
              ).bind(u.refreshHash),
            ])
          )[0]
        : await insertRefresh.run();
      if (inserted.meta.changes !== 1) return false;
      createLogger(env.LOG_LEVEL, { service: "auth" }).info(
        u.accessId ? "auth:git-oauth-refreshed" : "auth:git-oauth-issued",
        { userId: u.id, tokenId: id }
      );
      if (!u.accessId) {
        const owner = await env.DB.prepare("SELECT identifier FROM users WHERE id=?")
          .bind(u.id)
          .first<{ identifier: string }>();
        await recordAudit(env, {
          action: "access_token.created",
          actor: { kind: "user", id: u.id, name: owner?.identifier ?? "", ref: null },
          target: { type: "access_token", id, label: "Git Credential Manager" },
          subjectUserId: u.id,
          metadata: { scopes: token.scope },
        });
      }
      return { ...token, accessToken: token.accessToken, client: c, user };
    },
  };
}
function server(env: Env) {
  return new OAuth2Server({
    model: model(env),
    requirePKCE: true,
    requireClientAuthentication: { authorization_code: false, refresh_token: false },
    authorizationCodeLifetime: 300,
    accessTokenLifetime: 3600,
    refreshTokenLifetime: 2592000,
  });
}
export async function gitOAuthToken(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return Response.json(
      { error: "invalid_request" },
      { status: 405, headers: { "Cache-Control": "no-store" } }
    );
  const text = await readTextLimited(request.body, SMALL_JSON_BYTES);
  if (text === null)
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  const body = Object.fromEntries(new URLSearchParams(text));
  const req = new OAuth2Server.Request({
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body,
    query: {},
  });
  const res = new OAuth2Server.Response();
  try {
    await server(env).token(req, res);
  } catch (error) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("auth:git-oauth-token-failed", {
      error: error instanceof OAuth2Server.OAuthError ? error.name : "server_error",
    });
  }
  return Response.json(res.body ?? { error: "invalid_request" }, {
    status: res.status ?? 400,
    headers: { ...res.headers, "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
export async function gitOAuthAuthorize(
  request: Request,
  env: Env,
  user: TrustedUser
): Promise<Response> {
  if (request.headers.has("Authorization"))
    return errorResponse(403, "forbidden", "A browser session is required.");
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const input =
    request.method === "GET"
      ? GitOAuthRequestSchema.safeParse(query)
      : GitOAuthConsentSchema.safeParse(await readJsonLimited(request, SMALL_JSON_BYTES));
  if (!input.success || !validRedirect(input.data.redirect_uri) || !parsedScopes(input.data.scope))
    return errorResponse(400, "bad_request", "Invalid authorization request.");
  const selected = parsedScopes(input.data.scope);
  if (request.method === "GET")
    return dataResponse({ clientName: "Git Credential Manager", scopes: selected });
  if (request.method !== "POST")
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return errorResponse(403, "forbidden", "Same-origin authorization is required.");
  const recent = requireRecentAuth(user);
  if (recent) return recent;
  const consent = GitOAuthConsentSchema.parse(input.data);
  const { approve, ...params } = consent;
  const req = new OAuth2Server.Request({
    method: "GET",
    headers: {},
    query: { ...params, ...(approve ? {} : { allowed: "false" }) },
    body: {},
  });
  const res = new OAuth2Server.Response();
  try {
    await server(env).authorize(req, res, {
      authenticateHandler: { handle: async () => ({ id: user.id }) },
    });
  } catch (error) {
    createLogger(env.LOG_LEVEL, { service: "auth" }).warn("auth:git-oauth-authorization-failed", {
      error: error instanceof OAuth2Server.OAuthError ? error.name : "server_error",
    });
  }
  if (!res.headers?.location)
    return errorResponse(400, "bad_request", "Invalid authorization request.");
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:git-oauth-consent", {
    userId: user.id,
    approved: approve,
  });
  return dataResponse({ redirectUrl: res.headers.location });
}

export async function expireGitOAuth(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM auth_git_oauth_codes WHERE code_hash IN (SELECT code_hash FROM auth_git_oauth_codes WHERE expires_at <= ? LIMIT 500)"
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM auth_git_oauth_refresh WHERE token_hash IN (SELECT token_hash FROM auth_git_oauth_refresh WHERE expires_at <= ? LIMIT 500)"
    ).bind(now),
  ]);
}
