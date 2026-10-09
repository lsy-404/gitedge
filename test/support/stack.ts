import { env } from "cloudflare:workers";
import { Secret, TOTP } from "otpauth";
import auth from "../../workers/auth/src/index";
import forge from "../../workers/forge/src/index";
import { RECENT_AUTH_WINDOW_MS } from "../../packages/contracts/src/index";
import { trustedHeaders } from "../../packages/contracts/src/trust";
import { bytesToBase64 } from "../../src/worker/common/encoding";
import { issueSession } from "../../workers/auth/src/session";
import { FixtureArtifacts } from "./artifacts";
import { runSqlScript } from "./database";
import { unlimitedRateLimiter } from "./rate-limiter";

const migrations = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const origin = "https://stack.test";
export const artifacts = new FixtureArtifacts();
export const authEnv: Parameters<typeof auth.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  RATE_LIMITER: unlimitedRateLimiter,
  ALLOW_PUBLIC_SIGNUP: "true",
  DEFAULT_USER_GROUP: "free",
  SITE_ADMINS: "root, other-root",
  TOTP_ENCRYPTION_KEY: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))),
  LOG_LEVEL: "error",
};
export const forgeEnv: Parameters<typeof forge.fetch>[1] = {
  DB: env.DB,
  ARTIFACTS: artifacts,
  GIT: { fetch: async () => Response.json({ data: [] }) },
  AUTH: { fetch: async () => Response.json({ data: { revoked: 0 } }) },
  LOG_LEVEL: "error",
};

export interface Person {
  id: string;
  identifier: string;
  groupKey: string;
  cookie: string;
}

export async function migrate(): Promise<void> {
  for (const path of Object.keys(migrations).sort()) await runSqlScript(env.DB, migrations[path]);
}

/** Creates an account with a personal namespace and a fresh signed-in browser session. */
export async function createPerson(identifier: string): Promise<Person> {
  const id = crypto.randomUUID();
  const namespaceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, identifier, group_key, password_salt, password_hash, password_auth_enabled, created_at) VALUES (?, ?, 'free', '', '', 0, ?)"
    ).bind(id, identifier, Date.now()),
    env.DB.prepare(
      "INSERT INTO namespaces (id, slug, created_by, created_at, kind) VALUES (?, ?, ?, ?, 'personal')"
    ).bind(namespaceId, identifier, id, Date.now()),
    env.DB.prepare(
      "INSERT INTO namespace_memberships (namespace_id, user_id, created_at, role) VALUES (?, ?, ?, 'owner')"
    ).bind(namespaceId, id, Date.now()),
  ]);
  const token = await issueSession(env, id);
  return { id, identifier, groupKey: "free", cookie: `gitedge_session=${token}` };
}

export function authCall(
  person: Pick<Person, "cookie"> | null,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return auth.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(person ? { Cookie: person.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    authEnv
  );
}

export function forgeCall(
  person: Pick<Person, "id" | "identifier" | "groupKey"> | null,
  path: string,
  method = "GET",
  body?: unknown,
  recentAuthAt: number | null = Date.now()
): Promise<Response> {
  const headers = trustedHeaders(
    person
      ? {
          id: person.id,
          identifier: person.identifier,
          groupKey: person.groupKey,
          ...(recentAuthAt === null ? {} : { recentAuthAt }),
        }
      : undefined
  );
  headers.set("Content-Type", "application/json");
  return forge.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    forgeEnv
  );
}

export async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

export async function expireRecentAuth(person: Person): Promise<void> {
  await env.DB.prepare("UPDATE auth_sessions SET recent_auth_at = ? WHERE user_id = ?")
    .bind(Date.now() - RECENT_AUTH_WINDOW_MS - 1000, person.id)
    .run();
}

export function totpFor(secret: string): string {
  return new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
}

export async function createRepository(
  owner: Person,
  slug: string,
  visibility: "public" | "private" = "private",
  ownerSlug = owner.identifier
): Promise<string> {
  const response = await forgeCall(owner, "/repositories", "POST", {
    owner: ownerSlug,
    slug,
    visibility,
  });
  if (response.status !== 201) throw new Error(`Repository creation failed: ${response.status}`);
  return (await data<{ id: string }>(response)).id;
}
