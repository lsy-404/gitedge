import {
  ACCOUNT_EXPORT_SECTION_LIMIT,
  AccountDeletionInputSchema,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, auditStatement, recordAudit } from "../../../src/worker/common/audit";
import { errorResponse, jsonResponse, requireRecentAuth } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import { revokeUserAgentSessions, type AgentAuthEnv } from "./agents";

const EXPORT_PAGE = 100;

interface Section {
  key: string;
  select: string;
  from: string;
  owner: string;
  created: string;
  id: string;
}

// Every section selects `id` and `createdAt` so one keyset loop can page through it.
const SECTIONS: readonly Section[] = [
  {
    key: "repositories",
    select:
      "r.id, n.slug AS owner, COALESCE(r.deleted_slug, r.slug) AS name, r.visibility, r.description, r.archived, r.default_branch AS defaultBranch, r.created_at AS createdAt, r.deleted_at AS deletedAt",
    from: "repositories r JOIN namespaces n ON n.id = r.namespace_id",
    owner: "r.created_by",
    created: "r.created_at",
    id: "r.id",
  },
  {
    key: "organizations",
    select: "n.id, n.slug, n.display_name AS displayName, m.role, m.created_at AS createdAt",
    from: "namespace_memberships m JOIN namespaces n ON n.id = m.namespace_id AND n.kind = 'organization'",
    owner: "m.user_id",
    created: "m.created_at",
    id: "n.id",
  },
  {
    key: "issues",
    select:
      "id, repository_id AS repositoryId, number, title, body, state, created_at AS createdAt",
    from: "forge_issues",
    owner: "author_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "pullRequests",
    select:
      "id, repository_id AS repositoryId, number, title, body, state, base_ref AS baseRef, head_ref AS headRef, created_at AS createdAt",
    from: "forge_pull_requests",
    owner: "author_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "discussions",
    select:
      "id, repository_id AS repositoryId, number, title, body, category, state, created_at AS createdAt",
    from: "forge_discussions",
    owner: "author_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "comments",
    select:
      "id, repository_id AS repositoryId, target_kind AS targetKind, target_id AS targetId, body, created_at AS createdAt",
    from: "forge_comments",
    owner: "author_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "reviews",
    select:
      "id, repository_id AS repositoryId, pull_request_id AS pullRequestId, state, body, commit_oid AS commitOid, created_at AS createdAt",
    from: "forge_reviews",
    owner: "author_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "accessTokens",
    select:
      "id, name, prefix, scopes_json AS scopes, expires_at AS expiresAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt, created_at AS createdAt",
    from: "auth_access_tokens",
    owner: "user_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "gitCredentials",
    select:
      "id, repository_id AS repositoryId, name, permission, expires_at AS expiresAt, revoked_at AS revokedAt, created_at AS createdAt",
    from: "auth_git_tokens",
    owner: "user_id",
    created: "created_at",
    id: "id",
  },
  {
    key: "agents",
    select: "id, name, description, disabled_at AS disabledAt, created_at AS createdAt",
    from: "auth_agents",
    owner: "user_id",
    created: "created_at",
    id: "id",
  },
];

type Row = { id: string; createdAt: number } & Record<string, unknown>;

async function profile(env: AgentAuthEnv, userId: string): Promise<unknown> {
  const account = await env.DB.prepare(
    "SELECT u.identifier, u.group_key AS groupKey, u.created_at AS createdAt, p.display_name AS displayName, p.bio, p.location, p.website, p.preferences_json AS preferences, e.email, e.verified_at AS emailVerifiedAt FROM users u LEFT JOIN auth_account_profiles p ON p.user_id = u.id LEFT JOIN auth_emails e ON e.user_id = u.id WHERE u.id = ?"
  )
    .bind(userId)
    .first<Record<string, unknown>>();
  const identities = await env.DB.prepare(
    "SELECT provider, provider_login AS login FROM external_identities WHERE user_id = ? LIMIT 20"
  )
    .bind(userId)
    .all();
  const preferences =
    typeof account?.preferences === "string" ? parseObject(account.preferences) : null;
  return { id: userId, ...account, preferences, externalIdentities: identities.results };
}

function parseObject(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function* exportChunks(env: AgentAuthEnv, user: TrustedUser): AsyncGenerator<string> {
  const truncated: string[] = [];
  yield `{"schemaVersion":1,"exportedAt":${Date.now()},"profile":${JSON.stringify(await profile(env, user.id))}`;
  for (const section of SECTIONS) {
    yield `,${JSON.stringify(section.key)}:[`;
    let cursor: { at: number; id: string } = { at: -1, id: "" };
    let count = 0;
    let first = true;
    while (count < ACCOUNT_EXPORT_SECTION_LIMIT) {
      const take = Math.min(EXPORT_PAGE, ACCOUNT_EXPORT_SECTION_LIMIT - count);
      const rows = await env.DB.prepare(
        `SELECT ${section.select} FROM ${section.from} WHERE ${section.owner} = ?1 AND (${section.created}, ${section.id}) > (?2, ?3) ORDER BY ${section.created}, ${section.id} LIMIT ?4`
      )
        .bind(user.id, cursor.at, cursor.id, take + 1)
        .all<Row>();
      const page = rows.results.slice(0, take);
      for (const row of page) {
        yield `${first ? "" : ","}${JSON.stringify(row)}`;
        first = false;
      }
      count += page.length;
      const last = page.at(-1);
      if (rows.results.length <= take || !last) break;
      if (count >= ACCOUNT_EXPORT_SECTION_LIMIT) {
        truncated.push(section.key);
        break;
      }
      cursor = { at: last.createdAt, id: last.id };
    }
    yield "]";
  }
  yield `,"truncated":${JSON.stringify(truncated)},"sectionLimit":${ACCOUNT_EXPORT_SECTION_LIMIT}}`;
}

/** Streams a JSON archive of the signed-in user's data; sections are capped and listed in `truncated`. */
export async function exportAccount(env: AgentAuthEnv, user: TrustedUser): Promise<Response> {
  const reauth = requireRecentAuth(user);
  if (reauth) return reauth;
  const logger = createLogger(env.LOG_LEVEL, { service: "account-export" });
  const chunks = exportChunks(env, user);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (cause) {
        logger.error("account:export-failed", {
          userId: user.id,
          error: cause instanceof Error ? cause.message : "unknown",
        });
        controller.error(cause);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  await recordAudit(env, {
    action: "account.exported",
    actor: auditActor(user),
    target: { type: "user", id: user.id, label: user.identifier },
    subjectUserId: user.id,
  });
  logger.info("account:export-started", { userId: user.id });
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="gitedge-${user.identifier}-export.json"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Revokes everything the account owns and soft-deletes its repositories through the purge lifecycle. */
export async function deleteAccount(
  request: Request,
  env: AgentAuthEnv,
  user: TrustedUser
): Promise<Response> {
  const reauth = requireRecentAuth(user);
  if (reauth) return reauth;
  const parsed = AccountDeletionInputSchema.safeParse(
    await readJsonLimited(request, SMALL_JSON_BYTES)
  );
  if (!parsed.success || parsed.data.confirm !== user.identifier)
    return errorResponse(
      400,
      "confirmation_mismatch",
      "The confirmation text does not match your username."
    );
  const logger = createLogger(env.LOG_LEVEL, { service: "account-delete" });
  const blocking = await env.DB.prepare(
    "SELECT n.slug FROM namespace_memberships m JOIN namespaces n ON n.id = m.namespace_id WHERE m.user_id = ?1 AND m.role = 'owner' AND n.kind = 'organization' AND NOT EXISTS (SELECT 1 FROM namespace_memberships o WHERE o.namespace_id = n.id AND o.role = 'owner' AND o.user_id <> ?1) AND (EXISTS (SELECT 1 FROM namespace_memberships x WHERE x.namespace_id = n.id AND x.user_id <> ?1) OR EXISTS (SELECT 1 FROM repositories r WHERE r.namespace_id = n.id)) ORDER BY n.slug LIMIT 11"
  )
    .bind(user.id)
    .all<{ slug: string }>();
  if (blocking.results.length > 0) {
    logger.info("account:delete-blocked", { userId: user.id });
    return jsonResponse(
      {
        error: {
          code: "organization_ownership",
          message:
            "Transfer ownership of, or delete, the organizations you solely own before deleting your account.",
          organizations: blocking.results.slice(0, 10).map((row) => row.slug),
        },
      },
      409
    );
  }
  if (!(await revokeUserAgentSessions(env, user.id, true))) {
    logger.warn("account:delete-revocation-incomplete", { userId: user.id });
    return errorResponse(503, "service_unavailable", "Agent sessions could not be revoked yet.");
  }
  const now = Date.now();
  const id = user.id;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE repositories SET deleted_at = ?1, deleted_by = ?2, deleted_slug = slug, purge_after = ?1, purge_state = NULL, slug = 'deleted~' || id, updated_at = ?1 WHERE deleted_at IS NULL AND namespace_id IN (SELECT id FROM namespaces WHERE kind = 'personal' AND created_by = ?2)"
    ).bind(now, id),
    env.DB.prepare(
      "DELETE FROM repository_paths WHERE repository_id IN (SELECT id FROM repositories WHERE deleted_at = ?1 AND deleted_by = ?2) AND slug != 'deleted~' || repository_id"
    ).bind(now, id),
    // Repositories already awaiting purge must not stay restorable under a deleted owner.
    env.DB.prepare(
      "UPDATE repositories SET purge_after = MIN(purge_after, ?1) WHERE deleted_at IS NOT NULL AND namespace_id IN (SELECT id FROM namespaces WHERE kind = 'personal' AND created_by = ?2)"
    ).bind(now, id),
    env.DB.prepare(
      "DELETE FROM namespaces WHERE kind = 'organization' AND id IN (SELECT namespace_id FROM namespace_memberships WHERE user_id = ?1 AND role = 'owner') AND NOT EXISTS (SELECT 1 FROM namespace_memberships x WHERE x.namespace_id = namespaces.id AND x.user_id <> ?1) AND NOT EXISTS (SELECT 1 FROM repositories r WHERE r.namespace_id = namespaces.id)"
    ).bind(id),
    env.DB.prepare(
      "DELETE FROM namespace_memberships WHERE user_id = ?1 AND namespace_id IN (SELECT id FROM namespaces WHERE kind = 'organization')"
    ).bind(id),
    env.DB.prepare("DELETE FROM repository_collaborators WHERE user_id = ?").bind(id),
    env.DB.prepare(
      "UPDATE invitations SET status = 'cancelled', resolved_at = ?1 WHERE status = 'pending' AND (invitee_user_id = ?2 OR inviter_id = ?2)"
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE auth_access_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE auth_git_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL"
    ).bind(now, id),
    env.DB.prepare(
      "UPDATE auth_agents SET disabled_at = ? WHERE user_id = ? AND disabled_at IS NULL"
    ).bind(now, id),
    env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_passkeys WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_totp WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_recovery_codes WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_emails WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_one_time_tokens WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_challenges WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM external_identities WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_sso_identities WHERE user_id = ?").bind(id),
    env.DB.prepare("DELETE FROM auth_account_profiles WHERE user_id = ?").bind(id),
    env.DB.prepare(
      "UPDATE users SET disabled_at = ?1, deleted_at = ?1, password_salt = '', password_hash = '', password_auth_enabled = 0, is_site_admin = 0 WHERE id = ?2"
    ).bind(now, id),
    auditStatement(
      env.DB,
      {
        action: "account.deleted",
        actor: auditActor(user),
        target: { type: "user", id, label: user.identifier },
        subjectUserId: id,
      },
      now
    ),
  ]);
  logger.info("account:deleted", { userId: id });
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": "gitedge_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}
