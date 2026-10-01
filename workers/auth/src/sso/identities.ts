import type { TrustedUser, SsoIdentity } from "../../../../packages/contracts/src/index";
import type { SsoEnvironment, SsoIdentityClaims, SsoProvider } from "./types";

export interface SsoIdentityRow {
  id: string;
  userId: string;
  identifier: string;
  groupKey: string;
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
    "SELECT i.id, i.user_id AS userId, u.identifier, u.group_key AS groupKey FROM auth_sso_identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = ? AND i.issuer = ? AND i.subject = ?"
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
    const identifier =
      linkUser?.identifier ??
      `sso-${provider.id}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
        ).bind(namespaceId, userId, now)
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO auth_sso_identities (id, provider_id, protocol, issuer, subject, user_id, display_name, email, email_verified, session_index, name_id_format, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        now
      )
    );
    try {
      await env.DB.batch(statements);
      existing = { id: identityId, userId, identifier, groupKey };
    } catch {
      // Concurrent first logins may race; the unique subject determines the one owner.
      existing = await findIdentity(env, provider, claims.subject);
      if (!existing) throw new Error("SSO account creation failed.");
      if (linkUser && existing.userId !== linkUser.id)
        return { ok: false, reason: "identity_in_use" };
    }
  }
  await env.DB.prepare(
    "UPDATE auth_sso_identities SET display_name = ?, email = ?, email_verified = ?, session_index = ?, name_id_format = ?, last_login_at = ? WHERE id = ?"
  )
    .bind(
      claims.displayName,
      claims.email ?? null,
      claims.emailVerified ? 1 : 0,
      claims.sessionIndex ?? null,
      claims.nameIdFormat ?? null,
      Date.now(),
      existing.id
    )
    .run();
  return { ok: true, identity: existing };
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
