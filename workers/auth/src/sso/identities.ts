import type { TrustedUser, SsoIdentity } from "../../../../packages/contracts/src/index";
import {
  DefaultAccountPreferences,
  ReservedAccountIdentifiers,
} from "../../../../packages/contracts/src/account";
import { createLogger } from "../../../../src/worker/common/logger";
import type { SsoEnvironment, SsoIdentityClaims, SsoProvider } from "./types";

export interface SsoIdentityRow {
  id: string;
  userId: string;
  identifier: string;
  groupKey: string;
  passwordAuthEnabled: number;
  preferredUsername: string | null;
}
export type IdentityResolution =
  | { ok: true; identity: SsoIdentityRow }
  | { ok: false; reason: "identity_in_use" | "signup_disabled" };

async function findIdentity(
  env: SsoEnvironment,
  provider: SsoProvider,
  subject: string
): Promise<SsoIdentityRow | null> {
  return env.DB.prepare(
    "SELECT i.id, i.user_id AS userId, u.identifier, u.group_key AS groupKey, u.password_auth_enabled AS passwordAuthEnabled, i.preferred_username AS preferredUsername FROM auth_sso_identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = ? AND i.issuer = ? AND i.subject = ?"
  )
    .bind(provider.id, provider.issuer, subject)
    .first<SsoIdentityRow>();
}

export async function resolveSsoIdentity(
  env: SsoEnvironment,
  provider: SsoProvider,
  claims: SsoIdentityClaims,
  linkUser: TrustedUser | null
): Promise<IdentityResolution> {
  let existing = await findIdentity(env, provider, claims.subject);
  if (existing && linkUser && existing.userId !== linkUser.id)
    return { ok: false, reason: "identity_in_use" };
  if (!existing) {
    if (!linkUser && !provider.allowSignup) return { ok: false, reason: "signup_disabled" };
    const identityId = crypto.randomUUID();
    const userId = linkUser?.id ?? crypto.randomUUID();
    const namespaceId = crypto.randomUUID();
    let identifier = linkUser?.identifier ?? (await readableIdentifier(env, claims, null));
    const groupKey = linkUser?.groupKey ?? (env.DEFAULT_USER_GROUP.trim().toLowerCase() || "free");
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    if (!linkUser) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO users (id, identifier, password_salt, password_hash, password_auth_enabled, group_key, created_at) VALUES (?, ?, '', '', 0, ?, ?)"
        ).bind(userId, identifier, groupKey, now),
        env.DB.prepare(
          "INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES (?, ?, ?, ?, 'personal', ?, '')"
        ).bind(namespaceId, identifier, userId, now, claims.displayName),
        env.DB.prepare(
          "INSERT INTO namespace_memberships (namespace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)"
        ).bind(namespaceId, userId, now),
        env.DB.prepare(
          "INSERT INTO auth_account_profiles (user_id, display_name, bio, location, website, preferences_json, updated_at) VALUES (?, ?, '', '', '', ?, ?)"
        ).bind(
          userId,
          profileDisplayName(claims, identifier),
          JSON.stringify(DefaultAccountPreferences),
          now
        )
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO auth_sso_identities (id, provider_id, protocol, issuer, subject, user_id, display_name, email, email_verified, session_index, name_id_format, created_at, last_login_at, preferred_username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        identityId,
        provider.id,
        provider.protocol,
        provider.issuer,
        claims.subject,
        userId,
        claims.displayName,
        claims.email ?? null,
        claims.emailVerified ? 1 : 0,
        claims.sessionIndex ?? null,
        claims.nameIdFormat ?? null,
        now,
        now,
        claims.preferredUsername ?? null
      )
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await env.DB.batch(statements);
        existing = {
          id: identityId,
          userId,
          identifier,
          groupKey,
          passwordAuthEnabled: linkUser ? 1 : 0,
          preferredUsername: claims.preferredUsername ?? null,
        };
        break;
      } catch {
        // Concurrent first logins may race; the unique subject determines the one owner.
        existing = await findIdentity(env, provider, claims.subject);
        if (existing) {
          if (linkUser && existing.userId !== linkUser.id)
            return { ok: false, reason: "identity_in_use" };
          break;
        }
        if (linkUser) throw new Error("SSO identity linking failed.");
        const nextIdentifier = await readableIdentifier(env, claims, null);
        if (nextIdentifier === identifier || attempt === 3)
          throw new Error("SSO account creation failed.");
        identifier = nextIdentifier;
        statements[0] = env.DB.prepare(
          "INSERT INTO users (id, identifier, password_salt, password_hash, password_auth_enabled, group_key, created_at) VALUES (?, ?, '', '', 0, ?, ?)"
        ).bind(userId, identifier, groupKey, now);
        statements[1] = env.DB.prepare(
          "INSERT INTO namespaces (id, slug, created_by, created_at, kind, display_name, description) VALUES (?, ?, ?, ?, 'personal', ?, '')"
        ).bind(namespaceId, identifier, userId, now, claims.displayName);
      }
    }
    if (!existing) throw new Error("SSO account creation failed.");
  }
  const migratingGeneratedHandle =
    existing.passwordAuthEnabled === 0 &&
    existing.preferredUsername === null &&
    isGeneratedSsoIdentifier(existing.identifier, provider.id);
  const profileFallback = migratingGeneratedHandle
    ? await readableIdentifier(env, claims, existing.userId)
    : existing.identifier;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE auth_sso_identities SET display_name = ?, email = ?, email_verified = ?, session_index = ?, name_id_format = ?, last_login_at = ?, preferred_username = ? WHERE id = ?"
    ).bind(
      claims.displayName,
      claims.email ?? null,
      claims.emailVerified ? 1 : 0,
      claims.sessionIndex ?? null,
      claims.nameIdFormat ?? null,
      now,
      claims.preferredUsername ?? null,
      existing.id
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO auth_account_profiles (user_id, display_name, bio, location, website, preferences_json, updated_at) VALUES (?, ?, '', '', '', ?, ?)"
    ).bind(
      existing.userId,
      profileDisplayName(claims, profileFallback),
      JSON.stringify(DefaultAccountPreferences),
      now
    ),
  ]);
  if (migratingGeneratedHandle) {
    const logger = createLogger(env.LOG_LEVEL, { service: "sso" });
    const identifier = await readableIdentifier(env, claims, existing.userId);
    if (identifier && identifier !== existing.identifier) {
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE namespaces SET slug = ? WHERE kind = 'personal' AND created_by = ?"
          ).bind(identifier, existing.userId),
          env.DB.prepare("UPDATE users SET identifier = ? WHERE id = ?").bind(
            identifier,
            existing.userId
          ),
        ]);
        existing = { ...existing, identifier };
      } catch {
        logger.warn("sso:legacy-handle-rename-conflict", { userId: existing.userId });
      }
    }
  }
  return { ok: true, identity: existing };
}

function profileDisplayName(claims: SsoIdentityClaims, identifier: string): string {
  if (claims.email && claims.displayName.trim() === claims.email.trim()) return identifier;
  return claims.displayName.trim().slice(0, 100) || identifier;
}

function usernameCandidate(value: string | undefined, email: string | undefined): string | null {
  if (!value?.trim() || value.includes("@") || value.trim() === email) return null;
  const candidate = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return candidate.length >= 3 ? candidate : null;
}

function isGeneratedSsoIdentifier(identifier: string, providerId: string): boolean {
  const escapedProviderId = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^sso-${escapedProviderId}-[a-f0-9]{12}$`, "i").test(identifier);
}

async function readableIdentifier(
  env: SsoEnvironment,
  claims: SsoIdentityClaims,
  userId: string | null
): Promise<string> {
  const preferred = usernameCandidate(claims.preferredUsername, claims.email);
  const displayName = usernameCandidate(claims.displayName, claims.email);
  const base = preferred ?? displayName ?? "member";
  for (let suffix = 1; ; suffix += 1) {
    const identifier =
      suffix === 1 ? base : `${base.slice(0, 62 - String(suffix).length)}-${suffix}`;
    if (ReservedAccountIdentifiers.has(identifier)) continue;
    const collision = await env.DB.prepare(
      "SELECT id FROM users WHERE identifier = ? AND (? IS NULL OR id <> ?) UNION ALL SELECT id FROM namespaces WHERE slug = ? AND NOT (kind = 'personal' AND created_by = ?) LIMIT 1"
    )
      .bind(identifier, userId, userId, identifier, userId)
      .first<{ id: string }>();
    if (!collision) return identifier;
  }
}

export async function listSsoIdentities(
  env: SsoEnvironment,
  user: TrustedUser,
  providers: SsoProvider[]
): Promise<SsoIdentity[]> {
  const rows = await env.DB.prepare(
    "SELECT id, provider_id AS providerId, protocol, display_name AS displayName, email, email_verified AS emailVerified, created_at AS createdAt, last_login_at AS lastLoginAt FROM auth_sso_identities WHERE user_id = ? ORDER BY created_at"
  )
    .bind(user.id)
    .all<Omit<SsoIdentity, "providerLabel" | "emailVerified"> & { emailVerified: number }>();
  return rows.results.map((row) => ({
    ...row,
    providerLabel:
      providers.find((provider) => provider.id === row.providerId)?.label ?? row.providerId,
    emailVerified: row.emailVerified === 1,
  }));
}

export async function unlinkSsoIdentity(
  env: SsoEnvironment,
  user: TrustedUser,
  identityId: string,
  providers: SsoProvider[]
): Promise<boolean> {
  const enabledProviders =
    providers.map(() => "(other.provider_id = ? AND other.issuer = ?)").join(" OR ") || "0";
  // The remaining-method check and deletion share one statement, including concurrent unlinks.
  const result = await env.DB.prepare(
    `DELETE FROM auth_sso_identities WHERE id = ? AND user_id = ? AND (
      EXISTS (SELECT 1 FROM users WHERE id = ? AND password_auth_enabled = 1)
      OR (? = 1 AND EXISTS (SELECT 1 FROM external_identities WHERE user_id = ?))
      OR EXISTS (SELECT 1 FROM auth_sso_identities other WHERE other.user_id = ? AND other.id <> ? AND (${enabledProviders}))
    ) RETURNING id`
  )
    .bind(
      identityId,
      user.id,
      user.id,
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? 1 : 0,
      user.id,
      user.id,
      identityId,
      ...providers.flatMap((provider) => [provider.id, provider.issuer])
    )
    .first<{ id: string }>();
  return result !== null;
}
