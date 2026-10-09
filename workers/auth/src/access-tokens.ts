import {
  ACCESS_TOKEN_PREFIX,
  AccessTokenScopeSchema,
  CreateAccessTokenInputSchema,
  sha256Hex,
  type AccessToken,
  type AccessTokenIdentity,
  type AccessTokenRepository,
  type AccessTokenScope,
  type CreatedAccessToken,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { z } from "zod";

export interface AccessTokenEnv {
  DB: D1Database;
  LOG_LEVEL?: string;
}

interface AccessTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopesJson: string;
  repositoryIdsJson: string | null;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}
interface AuthenticatedAccessTokenRow {
  id: string;
  scopesJson: string;
  repositoryIdsJson: string | null;
  userId: string;
  identifier: string;
  groupKey: string;
}
interface TokenRepositoryRow extends AccessTokenRepository {
  tokenId: string;
}

const MAX_ACTIVE_TOKENS = 100;
const LAST_USED_RESOLUTION_MS = 60_000;
const DISPLAY_PREFIX_LENGTH = ACCESS_TOKEN_PREFIX.length + 8;
const TOKEN_PATTERN = new RegExp(`^${ACCESS_TOKEN_PREFIX}[0-9a-f]{64}$`);
const ScopesJsonSchema = z.array(AccessTokenScopeSchema);
const RepositoryIdsJsonSchema = z.array(z.string().min(1));

export function isAccessToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

function parseScopes(json: string): AccessTokenScope[] {
  const parsed = ScopesJsonSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : [];
}

function parseRepositoryIds(json: string | null): string[] | undefined {
  if (json === null) return undefined;
  const parsed = RepositoryIdsJsonSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : [];
}

/** Resolves a plaintext token to its owner; returns null for unknown, revoked or expired tokens. */
export async function authenticateAccessToken(
  env: AccessTokenEnv,
  token: string
): Promise<TrustedUser | null> {
  if (!isAccessToken(token)) return null;
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT t.id, t.scopes_json AS scopesJson, t.repository_ids_json AS repositoryIdsJson, u.id AS userId, u.identifier, u.group_key AS groupKey FROM auth_access_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?"
  )
    .bind(await sha256Hex(token), now)
    .first<AuthenticatedAccessTokenRow>();
  if (!row) return null;
  const scopes = parseScopes(row.scopesJson);
  if (scopes.length === 0) return null;
  const repositoryIds = parseRepositoryIds(row.repositoryIdsJson);
  await env.DB.prepare(
    "UPDATE auth_access_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)"
  )
    .bind(now, row.id, now - LAST_USED_RESOLUTION_MS)
    .run()
    .catch(() => {
      createLogger(env.LOG_LEVEL, { service: "auth" }).warn("auth:access-token-touch-failed", {
        tokenId: row.id,
      });
    });
  const identity: AccessTokenIdentity = {
    id: row.id,
    scopes,
    ...(repositoryIds ? { repositoryIds } : {}),
  };
  return { id: row.userId, identifier: row.identifier, groupKey: row.groupKey, token: identity };
}

function tokenResponse(
  row: AccessTokenRow,
  repositories: Map<string, AccessTokenRepository[]>
): AccessToken {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopesJson),
    repositories: row.repositoryIdsJson === null ? null : (repositories.get(row.id) ?? []),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

async function listTokens(env: AccessTokenEnv, userId: string): Promise<AccessToken[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, prefix, scopes_json AS scopesJson, repository_ids_json AS repositoryIdsJson, created_at AS createdAt, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt FROM auth_access_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 200"
  )
    .bind(userId)
    .all<AccessTokenRow>();
  const repositoryRows = await env.DB.prepare(
    "SELECT t.id AS tokenId, r.id, n.slug AS owner, r.slug FROM auth_access_tokens t, json_each(t.repository_ids_json) j JOIN repositories r ON r.id = j.value JOIN namespaces n ON n.id = r.namespace_id WHERE t.user_id = ? AND t.repository_ids_json IS NOT NULL"
  )
    .bind(userId)
    .all<TokenRepositoryRow>();
  const repositories = new Map<string, AccessTokenRepository[]>();
  for (const { tokenId, ...repository } of repositoryRows.results)
    repositories.set(tokenId, [...(repositories.get(tokenId) ?? []), repository]);
  return rows.results.map((row) => tokenResponse(row, repositories));
}

async function createToken(
  request: Request,
  env: AccessTokenEnv,
  user: TrustedUser
): Promise<Response> {
  const parsed = CreateAccessTokenInputSchema.safeParse(
    await readJsonLimited(request, SMALL_JSON_BYTES)
  );
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid access token payload.");
  const input = parsed.data;
  for (const repositoryId of input.repositoryIds ?? [])
    if ((await repositoryRole(env.DB, repositoryId, user.id)) === null)
      return errorResponse(404, "not_found", "Repository was not found.");
  const now = Date.now();
  const active = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM auth_access_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?"
  )
    .bind(user.id, now)
    .first<{ total: number }>();
  if ((active?.total ?? 0) >= MAX_ACTIVE_TOKENS)
    return errorResponse(409, "conflict", "Revoke an existing token before creating another.");
  const token = ACCESS_TOKEN_PREFIX + randomHex(32);
  const id = crypto.randomUUID();
  const expiresAt = now + input.expiresInDays * 86_400_000;
  const prefix = token.slice(0, DISPLAY_PREFIX_LENGTH);
  await env.DB.prepare(
    "INSERT INTO auth_access_tokens (id, user_id, name, token_hash, prefix, scopes_json, repository_ids_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      id,
      user.id,
      input.name,
      await sha256Hex(token),
      prefix,
      JSON.stringify(input.scopes),
      input.repositoryIds ? JSON.stringify(input.repositoryIds) : null,
      expiresAt,
      now
    )
    .run();
  createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:access-token-created", {
    userId: user.id,
    tokenId: id,
    scopes: input.scopes,
  });
  const created = (await listTokens(env, user.id)).find((item) => item.id === id);
  const response: CreatedAccessToken = {
    id,
    name: input.name,
    prefix,
    scopes: input.scopes,
    repositories: created?.repositories ?? null,
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    token,
  };
  return dataResponse(response, 201);
}

/** Token management requires an interactive browser session; tokens and agents cannot mint tokens. */
export async function handleAccessTokenManagement(
  request: Request,
  env: AccessTokenEnv,
  user: TrustedUser
): Promise<Response> {
  if (user.agentSession || request.headers.has("Authorization"))
    return errorResponse(
      403,
      "forbidden",
      "Access tokens can only be managed from a signed-in browser session."
    );
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length === 1 && request.method === "GET")
    return dataResponse(await listTokens(env, user.id));
  if (request.method !== "GET" && request.headers.get("Origin") !== new URL(request.url).origin)
    return errorResponse(403, "forbidden", "Same-origin account management is required.");
  if (parts.length === 1 && request.method === "POST") return createToken(request, env, user);
  if (parts.length === 2 && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE auth_access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL"
    )
      .bind(Date.now(), parts[1], user.id)
      .run();
    if (!result.meta.changes) return errorResponse(404, "not_found", "Token was not found.");
    createLogger(env.LOG_LEVEL, { service: "auth" }).info("auth:access-token-revoked", {
      userId: user.id,
      tokenId: parts[1],
    });
    return dataResponse({ revoked: true });
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed.");
}
