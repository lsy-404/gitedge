import { dataResponse as json, errorResponse as fail, readJsonLimited as readJson } from "./http";
import {
  AccountProfileSchema,
  DefaultAccountPreferences,
  ReservedAccountIdentifiers,
  UpdateAccountProfileSchema,
  type AccountProfile,
} from "../../../packages/contracts/src/account";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { createSessionCookie } from "./session";

interface ProfileRow {
  identifier: string;
  displayName: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  preferencesJson: string | null;
}

function preferencesFromJson(value: string | null): AccountProfile["preferences"] {
  if (value) {
    try {
      const parsed: unknown = JSON.parse(value);
      const result = AccountProfileSchema.shape.preferences.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Invalid stored preferences fall back to defaults.
    }
  }
  return { ...DefaultAccountPreferences };
}

function profileFromRow(row: ProfileRow): AccountProfile {
  return AccountProfileSchema.parse({
    identifier: row.identifier,
    displayName: row.displayName || row.identifier,
    bio: row.bio ?? "",
    location: row.location ?? "",
    website: row.website ?? "",
    preferences: preferencesFromJson(row.preferencesJson),
  });
}

async function readProfile(
  env: { DB: D1Database },
  userId: string
): Promise<AccountProfile | null> {
  const row = await env.DB.prepare(
    "SELECT users.identifier, COALESCE(profile.display_name, (SELECT CASE WHEN display_name = email OR instr(display_name, '@') > 0 THEN NULL ELSE display_name END FROM auth_sso_identities WHERE user_id = users.id ORDER BY last_login_at DESC LIMIT 1)) AS displayName, profile.bio, profile.location, profile.website, profile.preferences_json AS preferencesJson FROM users LEFT JOIN auth_account_profiles profile ON profile.user_id = users.id WHERE users.id = ?"
  )
    .bind(userId)
    .first<ProfileRow>();
  return row ? profileFromRow(row) : null;
}

async function identifierAvailable(
  env: { DB: D1Database },
  identifier: string,
  userId: string
): Promise<boolean> {
  if (ReservedAccountIdentifiers.has(identifier)) return false;
  const collision = await env.DB.prepare(
    "SELECT id FROM users WHERE identifier = ? AND id <> ? UNION ALL SELECT id FROM namespaces WHERE slug = ? AND NOT (kind = 'personal' AND created_by = ?) UNION ALL SELECT namespace_id FROM namespace_slug_history WHERE slug = ? AND namespace_id NOT IN (SELECT id FROM namespaces WHERE kind = 'personal' AND created_by = ?) LIMIT 1"
  )
    .bind(identifier, userId, identifier, userId, identifier, userId)
    .first<{ id: string }>();
  return collision === null;
}

export async function handleAccountProfile(
  request: Request,
  env: { DB: D1Database; LOG_LEVEL?: string },
  user: TrustedUser
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "auth" });
  if (user.agentSession || request.headers.has("Authorization"))
    return fail(403, "forbidden", "Agent sessions cannot change human account settings.");
  if (request.method === "GET") {
    const profile = await readProfile(env, user.id);
    return profile ? json(profile) : fail(404, "not_found", "Account was not found.");
  }
  if (request.method !== "PATCH") return fail(405, "method_not_allowed", "Method is not allowed.");
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    return fail(403, "forbidden", "Same-origin account management is required.");
  const parsed = UpdateAccountProfileSchema.safeParse(await readJson(request));
  if (!parsed.success) return fail(400, "bad_request", "Invalid account profile payload.");
  if (parsed.data.website) {
    let website: URL;
    try {
      website = new URL(parsed.data.website);
    } catch {
      return fail(400, "bad_request", "Website must be a valid HTTP or HTTPS URL.");
    }
    if (website.protocol !== "https:" && website.protocol !== "http:")
      return fail(400, "bad_request", "Website must be a valid HTTP or HTTPS URL.");
  }

  const current = await readProfile(env, user.id);
  if (!current) return fail(404, "not_found", "Account was not found.");
  const identifier = parsed.data.identifier?.toLowerCase() ?? current.identifier;
  if (identifier !== current.identifier) {
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(identifier))
      return fail(400, "bad_request", "Identifier must be a valid namespace name.");
    if (!(await identifierAvailable(env, identifier, user.id)))
      return fail(409, "conflict", "Identifier is already in use or reserved.");
  }
  const updated: AccountProfile = {
    identifier,
    displayName: parsed.data.displayName ?? current.displayName,
    bio: parsed.data.bio ?? current.bio,
    location: parsed.data.location ?? current.location,
    website: parsed.data.website ?? current.website,
    preferences: { ...current.preferences, ...parsed.data.preferences },
  };
  const profile = AccountProfileSchema.parse(updated);
  const now = Date.now();
  try {
    const statements: D1PreparedStatement[] = [];
    if (identifier !== current.identifier) {
      statements.push(
        env.DB.prepare(
          "UPDATE namespaces SET slug = ? WHERE kind = 'personal' AND created_by = ?"
        ).bind(identifier, user.id),
        env.DB.prepare("UPDATE users SET identifier = ? WHERE id = ?").bind(identifier, user.id)
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO auth_account_profiles (user_id, display_name, bio, location, website, preferences_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, bio = excluded.bio, location = excluded.location, website = excluded.website, preferences_json = excluded.preferences_json, updated_at = excluded.updated_at"
      ).bind(
        user.id,
        profile.displayName,
        profile.bio,
        profile.location,
        profile.website,
        JSON.stringify(profile.preferences),
        now
      )
    );
    await env.DB.batch(statements);
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.message.includes("UNIQUE constraint") ||
        cause.message.includes("namespace slug is retired"))
    )
      return fail(
        409,
        "conflict",
        "Account settings could not be saved because the name is in use."
      );
    logger.error("account:profile-update-failed", { userId: user.id });
    return fail(500, "internal_error", "Account settings could not be saved.");
  }
  logger.info("account:profile-updated", {
    userId: user.id,
    identifierChanged: identifier !== current.identifier,
  });
  return json(profile);
}

export async function handleWebSessions(
  request: Request,
  env: { DB: D1Database; LOG_LEVEL?: string },
  user: TrustedUser,
  currentTokenHash: string
): Promise<Response | null> {
  if (user.agentSession || request.headers.has("Authorization"))
    return fail(403, "forbidden", "Agent sessions cannot manage human login sessions.");
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "web-sessions") return null;
  if (parts.length === 1 && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, created_at AS createdAt, expires_at AS expiresAt, token_hash = ? AS isCurrent FROM auth_sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 100"
    )
      .bind(currentTokenHash, user.id, Date.now())
      .all<{ id: string; createdAt: number; expiresAt: number; isCurrent: number }>();
    return json(rows.results.map((row) => ({ ...row, isCurrent: row.isCurrent === 1 })));
  }
  if (parts.length === 2 && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "DELETE FROM auth_sessions WHERE id = ? AND user_id = ? RETURNING id, token_hash AS tokenHash"
    )
      .bind(parts[1], user.id)
      .first<{ id: string; tokenHash: string }>();
    if (!result) return fail(404, "not_found", "Session was not found.");
    const isCurrent = result.tokenHash === currentTokenHash;
    createLogger(env.LOG_LEVEL, { service: "auth" }).info("account:web-session-revoked", {
      userId: user.id,
      sessionId: result.id,
      isCurrent,
    });
    return Response.json(
      { data: { revoked: true, isCurrent } },
      {
        headers: {
          "Cache-Control": "no-store",
          ...(isCurrent ? { "Set-Cookie": createSessionCookie("", 0) } : {}),
        },
      }
    );
  }
  return fail(405, "method_not_allowed", "Method is not allowed.");
}
