import { z } from "zod";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { readTextLimited } from "../../../src/worker/common/readText";
import { DeployManifestSchema, type DeployManifest } from "../../../packages/contracts/src/deploy";
import {
  readTrustedUser,
  sha256Hex,
  trustedHeaders,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import type { Logger } from "../../../src/worker/common/logger";
import { base64UrlToBytes, bytesToBase64Url } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";

const API = "https://api.cloudflare.com/client/v4";
const MANIFEST_PATH = "gitedge.deploy.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const COOKIE = "ge_deploy_session";
const SESSION_SECONDS = 15 * 60;
const MAX_CF_BODY_BYTES = 10 * 1024 * 1024;
const MAX_JSON_REQUEST_BYTES = 16 * 1024;
const MAX_MIGRATION_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_MIGRATION_BYTES = 4 * 1024 * 1024;

export interface DeployGitService {
  fetch(request: Request): Promise<Response>;
}
export interface DeployEnv {
  DB: D1Database;
  GIT: DeployGitService;
  DEPLOY_SESSION_KEY: string;
  DEPLOY_ORIGIN?: string;
  LOG_LEVEL?: string;
}
export type DeployLogger = Pick<Logger, "info" | "warn" | "error">;

interface DeploymentSession {
  version: 1;
  ownerId: string;
  repositoryId: string;
  ref: string;
  digest: string;
  sourceDigests: string[];
  token: string;
  nonce: string;
  accountId: string | null;
  resourceNames: Record<string, string>;
  expiresAt: number;
  completed: Record<string, string>;
}
const CfAccountSchema = z.object({ id: z.string(), name: z.string() });
const CfRawResourceSchema = z.object({
  id: z.string().optional(),
  uuid: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
});
const CfBucketListSchema = z.object({ buckets: z.array(CfRawResourceSchema).optional() });
const CfQueryResultSchema = z.array(
  z.object({ results: z.array(z.object({ name: z.string() })).optional() })
);
const WorkerScriptSchema = z.object({
  subdomain: z
    .object({
      enabled: z.boolean().optional(),
      previews_enabled: z.boolean().optional(),
      url: z.string().optional(),
    })
    .optional(),
});
const CfResultInfoSchema = z
  .object({
    cursor: z.string().nullish(),
    total_pages: z.number().optional(),
  })
  .catch({});
const cfEnvelopeSchema = <T>(result: z.ZodType<T>) =>
  z.object({
    success: z.boolean(),
    result,
    result_info: CfResultInfoSchema.optional(),
  });
type CfAccount = z.infer<typeof CfAccountSchema>;
type CfRawResource = z.infer<typeof CfRawResourceSchema>;
type ResourceKind = "d1" | "r2" | "kv";
interface ResourceTarget {
  key: string;
  resourceId: string;
  kind: ResourceKind;
  name: string;
  list: string;
  create: string;
  body: Record<string, string>;
}
interface CfNamedResource {
  id: string;
  name: string;
}
interface CheckedDeploymentPlan {
  manifest: DeployManifest;
  digest: string;
  sourceDigests: Record<string, string>;
}

async function activationFailure(
  env: DeployEnv,
  session: DeploymentSession,
  logger: DeployLogger,
  repositoryId: string,
  workerName: string,
  detail: string
): Promise<Response> {
  logger.warn("deploy:workers-dev-activation-failed", { repositoryId, workerName, detail });
  return jsonResponse(
    {
      error: {
        code: "activation_failed",
        message: "Worker upload succeeded, but workers.dev activation failed. Retry activation.",
        uploadStatus: "upload_succeeded",
        activationStatus: "activation_failed",
      },
    },
    502,
    { "Set-Cookie": cookieHeader(await seal(env, session), SESSION_SECONDS) }
  );
}
function safeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
async function gitFetch(env: DeployEnv, url: URL, user: TrustedUser): Promise<Response> {
  const headers = trustedHeaders(user);
  headers.set("Accept", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await env.GIT.fetch(new Request(url, { headers, signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}
function cookieValue(request: Request): string | null {
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  return cookie ? cookie.slice(COOKIE.length + 1) : null;
}
function cookieHeader(value: string, maxAge: number): string {
  // The public prefix keeps this credential away from unrelated Gateway services.
  return `${COOKIE}=${value}; Path=/api/deploy; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("DEPLOY_SESSION_KEY must contain at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env: DeployEnv, session: DeploymentSession): Promise<string> {
  const serialized = JSON.stringify(session);
  if (new TextEncoder().encode(serialized).byteLength > 2700)
    throw new Error("Deployment session exceeds the cookie size limit");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env.DEPLOY_SESSION_KEY),
    new TextEncoder().encode(serialized)
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64Url(combined);
}
async function unseal(
  env: DeployEnv,
  request: Request,
  user: TrustedUser,
  repositoryId: string,
  ref: string
): Promise<DeploymentSession | null> {
  const value = cookieValue(request);
  if (!value) return null;
  try {
    const bytes = base64UrlToBytes(value);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) },
      await encryptionKey(env.DEPLOY_SESSION_KEY),
      bytes.slice(12)
    );
    const session = JSON.parse(new TextDecoder().decode(plaintext)) as DeploymentSession;
    if (
      session.version !== 1 ||
      session.ownerId !== user.id ||
      session.repositoryId !== repositoryId ||
      session.ref !== ref ||
      session.expiresAt <= Date.now()
    )
      return null;
    return session;
  } catch {
    return null;
  }
}
async function sourceDigest(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 32);
}
function declaredSourcePaths(manifest: DeployManifest): string[] {
  const modules = [manifest.worker.entrypoint, ...manifest.worker.modules];
  const migrations = manifest.resources.d1.flatMap((database) => database.migrations);
  return Array.from(new Set([...modules, ...migrations])).sort();
}
async function repositoryForUser(
  env: DeployEnv,
  userId: string,
  repositoryId: string
): Promise<boolean> {
  if ((await repositoryRole(env.DB, repositoryId, userId)) !== "admin") return false;
  const row = await env.DB.prepare(
    "SELECT id FROM repositories WHERE id=? AND deleted_at IS NULL AND archived=0 AND deployments_enabled=1"
  )
    .bind(repositoryId)
    .first<{ id: string }>();
  return row !== null;
}
function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    !ref.includes("~") &&
    !ref.includes("^") &&
    !ref.includes(":") &&
    !ref.includes("\\") &&
    !ref.includes(" ")
  );
}
async function readManifest(
  env: DeployEnv,
  repositoryId: string,
  ref: string,
  user: TrustedUser
): Promise<{ manifest: DeployManifest; digest: string } | null> {
  const url = new URL(
    `/repositories/${encodeURIComponent(repositoryId)}/raw`,
    "https://git.internal"
  );
  url.searchParams.set("path", MANIFEST_PATH);
  url.searchParams.set("ref", ref);
  const upstream = await gitFetch(env, url, user);
  if (!upstream.ok) return null;
  const length = Number(upstream.headers.get("Content-Length") ?? 0);
  if (length > MAX_MANIFEST_BYTES) return null;
  const text = await readTextLimited(upstream.body, MAX_MANIFEST_BYTES);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = DeployManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { manifest: parsed.data, digest: await sha256Hex(JSON.stringify(parsed.data)) };
}
async function readDeclaredFile(
  env: DeployEnv,
  repositoryId: string,
  ref: string,
  user: TrustedUser,
  path: string,
  maxBytes: number
): Promise<string | null> {
  const fileUrl = new URL(
    `/repositories/${encodeURIComponent(repositoryId)}/raw`,
    "https://git.internal"
  );
  fileUrl.searchParams.set("path", path);
  fileUrl.searchParams.set("ref", ref);
  const response = await gitFetch(env, fileUrl, user);
  if (!response.ok) return null;
  const declaredSize = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredSize > maxBytes) return null;
  const content = await readTextLimited(response.body, maxBytes);
  return content !== null && !content.includes("\0") ? content : null;
}
async function readDeploymentPlan(
  env: DeployEnv,
  repositoryId: string,
  ref: string,
  user: TrustedUser
): Promise<CheckedDeploymentPlan | null> {
  const manifestResult = await readManifest(env, repositoryId, ref, user);
  if (!manifestResult) return null;
  const manifest = manifestResult.manifest;
  const migrationPaths = manifest.resources.d1.flatMap((database) => database.migrations);
  const sourcePaths = declaredSourcePaths(manifest);
  const sourceDigests: Record<string, string> = {};
  let moduleBytes = 0;
  let migrationBytes = 0;
  for (const path of sourcePaths) {
    const isMigration = migrationPaths.includes(path);
    const limit = isMigration ? MAX_MIGRATION_FILE_BYTES : MAX_CF_BODY_BYTES;
    const content = await readDeclaredFile(env, repositoryId, ref, user, path, limit);
    if (content === null) return null;
    const size = new TextEncoder().encode(content).byteLength;
    if (isMigration) migrationBytes += size;
    else moduleBytes += size;
    if (migrationBytes > MAX_TOTAL_MIGRATION_BYTES || moduleBytes > MAX_CF_BODY_BYTES) return null;
    sourceDigests[path] = await sourceDigest(content);
  }
  const sourceEntries = Object.entries(sourceDigests).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const combinedDigest = await sha256Hex(
    `${manifestResult.digest}\n${JSON.stringify(sourceEntries)}`
  );
  return { manifest, digest: combinedDigest, sourceDigests };
}
async function readJsonBody<T>(request: Request): Promise<T | null> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_JSON_REQUEST_BYTES) return null;
  const text = await readTextLimited(request.body, MAX_JSON_REQUEST_BYTES);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
function manifestPermissions(manifest: DeployManifest): string[] {
  const result = [
    "Account: Account Settings Read",
    "Account: Workers Scripts Write",
    "Account: Workers Scripts Read",
  ];
  if (manifest.resources.d1.length) result.push("Account: D1 Write", "Account: D1 Read");
  if (manifest.resources.r2.length)
    result.push("Account: Workers R2 Storage Write", "Account: Workers R2 Storage Read");
  if (manifest.resources.kv.length)
    result.push("Account: Workers KV Storage Write", "Account: Workers KV Storage Read");
  return result;
}
function hasValidNonce(session: DeploymentSession, body: { nonce?: unknown } | null): boolean {
  return typeof body?.nonce === "string" && body.nonce === session.nonce;
}
function isAgent(user: TrustedUser): boolean {
  return user.agentSession !== undefined;
}
function sameOrigin(request: Request, env: DeployEnv): boolean {
  const origin = request.headers.get("Origin");
  const expected = env.DEPLOY_ORIGIN ?? new URL(request.url).origin;
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  if (origin !== null) return origin === expected;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("Sec-Fetch-Site") === "same-origin") return true;
  const referer = request.headers.get("Referer");
  return referer !== null && new URL(referer).origin === expected;
}
async function cfEnvelope<T>(
  token: string,
  path: string,
  resultSchema: z.ZodType<T>,
  init: RequestInit = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const isMultipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body && !isMultipart && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
    const response = await fetch(`${API}${path}`, { ...init, headers, signal: controller.signal });
    if (!response.ok) throw new Error("Cloudflare API request failed");
    const text = await readTextLimited(response.body, MAX_CF_BODY_BYTES);
    if (text === null) throw new Error("Cloudflare API response exceeded limit");
    const parsed = cfEnvelopeSchema(resultSchema).safeParse(JSON.parse(text));
    if (!parsed.success || !parsed.data.success)
      throw new Error("Cloudflare API rejected the request");
    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}
async function cf<T>(
  token: string,
  path: string,
  resultSchema: z.ZodType<T>,
  init: RequestInit = {}
): Promise<T> {
  return (await cfEnvelope(token, path, resultSchema, init)).result;
}
async function listAccounts(token: string): Promise<CfAccount[]> {
  const accounts: CfAccount[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const envelope = await cfEnvelope(
      token,
      `/accounts?per_page=50&page=${page}`,
      z.array(CfAccountSchema)
    );
    accounts.push(...envelope.result);
    if (page >= (envelope.result_info?.total_pages ?? 1)) return accounts;
  }
  throw new Error("Cloudflare account lookup exceeded the page limit");
}
function cfPath(accountId: string, suffix: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/${suffix}`;
}
async function selectedSession(
  env: DeployEnv,
  request: Request,
  user: TrustedUser,
  repositoryId: string,
  ref: string
): Promise<{ session: DeploymentSession; currentManifest: DeployManifest } | Response> {
  const session = await unseal(env, request, user, repositoryId, ref);
  if (!session)
    return errorResponse(401, "deploy_session_required", "Create a deployment session first.");
  const current = await readDeploymentPlan(env, repositoryId, ref, user);
  if (!current || current.digest !== session.digest)
    return errorResponse(
      409,
      "manifest_changed",
      "The deployment manifest changed. Review the plan again."
    );
  if (!(await repositoryForUser(env, user.id, repositoryId)))
    return errorResponse(404, "not_found", "Repository was not found.");
  return { session, currentManifest: current.manifest };
}
function resourceEndpoints(
  manifest: DeployManifest,
  accountId: string,
  names: Record<string, string> = {}
): ResourceTarget[] {
  return [
    ...manifest.resources.d1.map((item): ResourceTarget => {
      const name = names[item.id] ?? item.name;
      return {
        key: `d1:${item.id}`,
        resourceId: item.id,
        kind: "d1",
        name,
        list: `${cfPath(accountId, "d1/database")}?name=${encodeURIComponent(name)}&per_page=1000`,
        create: cfPath(accountId, "d1/database"),
        body: { name, primary_location_hint: "wnam" },
      };
    }),
    ...manifest.resources.r2.map((item): ResourceTarget => {
      const name = names[item.id] ?? item.name;
      return {
        key: `r2:${item.id}`,
        resourceId: item.id,
        kind: "r2",
        name,
        list: `${cfPath(accountId, "r2/buckets")}?name_contains=${encodeURIComponent(name)}&per_page=1000`,
        create: cfPath(accountId, "r2/buckets"),
        body: { name, locationHint: "wnam" },
      };
    }),
    ...manifest.resources.kv.map((item): ResourceTarget => {
      const name = names[item.id] ?? item.name;
      return {
        key: `kv:${item.id}`,
        resourceId: item.id,
        kind: "kv",
        name,
        list: `${cfPath(accountId, "storage/kv/namespaces")}?order=title&per_page=1000&page=1`,
        create: cfPath(accountId, "storage/kv/namespaces"),
        body: { title: name },
      };
    }),
  ];
}
function validResourceNames(
  manifest: DeployManifest,
  input: unknown
): Record<string, string> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const allowed = new Map(
    [...manifest.resources.d1, ...manifest.resources.r2, ...manifest.resources.kv].map(
      (resource) => [resource.id, resource.name]
    )
  );
  const entries = Object.entries(input);
  if (
    entries.length !== allowed.size ||
    entries.some(
      ([id, name]) =>
        !allowed.has(id) || typeof name !== "string" || !/^[a-z][a-z0-9-]{2,62}$/.test(name)
    )
  )
    return null;
  return Object.fromEntries(entries) as Record<string, string>;
}
function normalizeResource(
  kind: ResourceKind,
  item: CfRawResource,
  fallbackName: string
): CfNamedResource {
  const name = kind === "kv" ? (item.title ?? fallbackName) : (item.name ?? fallbackName);
  const id =
    kind === "d1" ? (item.uuid ?? item.id ?? name) : kind === "kv" ? (item.id ?? name) : name;
  return { id, name };
}
async function listResources(token: string, target: ResourceTarget): Promise<CfNamedResource[]> {
  if (target.kind === "d1") {
    const result = await cf(token, target.list, z.array(CfRawResourceSchema));
    return result.map((item) => normalizeResource("d1", item, ""));
  }
  if (target.kind === "r2") {
    const resources: CfNamedResource[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const path = cursor ? `${target.list}&cursor=${encodeURIComponent(cursor)}` : target.list;
      const envelope = await cfEnvelope(token, path, CfBucketListSchema);
      resources.push(
        ...(envelope.result.buckets ?? []).map((item) => normalizeResource("r2", item, ""))
      );
      if (resources.some((item) => item.name === target.name)) return resources;
      cursor = envelope.result_info?.cursor ?? undefined;
      if (!cursor) return resources;
    }
    throw new Error("R2 resource lookup exceeded the page limit");
  }
  const resources: CfNamedResource[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const url = new URL(target.list, API);
    url.searchParams.set("page", String(page));
    const envelope = await cfEnvelope(
      token,
      `${url.pathname}${url.search}`,
      z.array(CfRawResourceSchema)
    );
    resources.push(...envelope.result.map((item) => normalizeResource("kv", item, "")));
    if (resources.some((item) => item.name === target.name)) return resources;
    if (page >= (envelope.result_info?.total_pages ?? 1)) return resources;
  }
  throw new Error("KV resource lookup exceeded the page limit");
}
async function ensureResource(
  session: DeploymentSession,
  target: ResourceTarget,
  existing: CfNamedResource[]
): Promise<CfNamedResource> {
  const match = existing.find((item) => item.name === target.name);
  if (match) {
    session.completed[target.key] = match.id;
    return match;
  }
  const created = normalizeResource(
    target.kind,
    await cf(session.token, target.create, CfRawResourceSchema, {
      method: "POST",
      body: JSON.stringify(target.body),
    }),
    target.name
  );
  session.completed[target.key] = created.id;
  return created;
}
async function applyD1Migrations(
  session: DeploymentSession,
  manifest: DeployManifest,
  repositoryId: string,
  ref: string,
  user: TrustedUser,
  expectedSourceDigests: string[],
  logger: DeployLogger,
  env: DeployEnv
): Promise<void> {
  for (const database of manifest.resources.d1) {
    const databaseId = session.completed[`d1:${database.id}`];
    if (!databaseId) throw new Error("D1 database binding was not provisioned");
    for (const path of database.migrations) {
      const sql = await readDeclaredFile(
        env,
        repositoryId,
        ref,
        user,
        path,
        MAX_MIGRATION_FILE_BYTES
      );
      const sourceIndex = declaredSourcePaths(manifest).indexOf(path);
      if (
        sql === null ||
        sourceIndex < 0 ||
        (await sourceDigest(sql)) !== expectedSourceDigests[sourceIndex]
      )
        throw new Error("D1 migration is invalid or too large");
      const key = `migration:${database.id}:${path}`;
      await cf(
        session.token,
        cfPath(session.accountId!, `d1/database/${encodeURIComponent(databaseId)}/query`),
        z.unknown(),
        {
          method: "POST",
          body: JSON.stringify({
            sql: "CREATE TABLE IF NOT EXISTS _gitedge_deploy_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);",
          }),
        }
      );
      const prior = await cf(
        session.token,
        cfPath(session.accountId!, `d1/database/${encodeURIComponent(databaseId)}/query`),
        CfQueryResultSchema,
        {
          method: "POST",
          body: JSON.stringify({
            sql: "SELECT name FROM _gitedge_deploy_migrations WHERE name = ?",
            params: [key],
          }),
        }
      );
      if (!(prior[0]?.results ?? []).some((row) => row.name === key)) {
        // D1 batches are transactional, so a failed ledger insert rolls back the migration too.
        const statements = sql.trim().replace(/;+\s*$/, "");
        await cf(
          session.token,
          cfPath(session.accountId!, `d1/database/${encodeURIComponent(databaseId)}/query`),
          z.unknown(),
          {
            method: "POST",
            body: JSON.stringify({
              batch: [
                { sql: statements },
                { sql: "INSERT INTO _gitedge_deploy_migrations (name) VALUES (?)", params: [key] },
              ],
            }),
          }
        );
      }
      logger.info("deploy:migration-applied", { repositoryId, databaseId, migration: path });
    }
  }
}

async function handleDeployRequest(
  request: Request,
  env: DeployEnv,
  logger: DeployLogger
): Promise<Response> {
  if (request.headers.has("X-GitEdge-Agent-Session"))
    return errorResponse(
      403,
      "agent_deploy_forbidden",
      "Agent sessions cannot access Cloudflare deployment credentials."
    );
  const user = readTrustedUser(request);
  if (!user) return errorResponse(401, "unauthorized", "Trusted user context is required.");
  if (!sameOrigin(request, env))
    return errorResponse(403, "origin_rejected", "Request origin was rejected.");
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const repositoryId = url.searchParams.get("repositoryId") ?? parts[1] ?? "";
  const ref = url.searchParams.get("ref") ?? "HEAD";
  if (!/^[0-9a-f-]{16,64}$/i.test(repositoryId) || !validRef(ref))
    return errorResponse(400, "bad_request", "A repository and valid ref are required.");
  if (!(await repositoryForUser(env, user.id, repositoryId)))
    return errorResponse(404, "not_found", "Repository was not found.");
  if (request.method === "GET" && parts[0] === "plan") {
    const plan = await readDeploymentPlan(env, repositoryId, ref, user);
    if (!plan)
      return errorResponse(
        404,
        "manifest_not_found",
        "This ref has no valid gitedge.deploy.json manifest."
      );
    return dataResponse({
      repositoryId,
      ref,
      manifestDigest: plan.digest,
      manifest: plan.manifest,
      permissions: manifestPermissions(plan.manifest),
    });
  }
  if (request.method === "POST" && parts[0] === "session") {
    if (isAgent(user))
      return errorResponse(
        403,
        "agent_deploy_forbidden",
        "Agent sessions cannot grant Cloudflare account access."
      );
    const body = await readJsonBody<{ token?: unknown; manifestDigest?: unknown }>(request);
    if (
      !body ||
      typeof body.token !== "string" ||
      body.token.length < 20 ||
      body.token.length > 512 ||
      typeof body.manifestDigest !== "string"
    )
      return errorResponse(
        400,
        "bad_request",
        "A Cloudflare token and manifest digest are required."
      );
    const current = await readDeploymentPlan(env, repositoryId, ref, user);
    if (!current || current.digest !== body.manifestDigest)
      return errorResponse(
        409,
        "manifest_changed",
        "The deployment manifest changed. Review the plan again."
      );
    let accounts: CfAccount[];
    try {
      accounts = await listAccounts(body.token);
    } catch {
      logger.warn("deploy:token-rejected", { repositoryId });
      return errorResponse(403, "token_invalid", "Cloudflare token could not list accounts.");
    }
    if (accounts.length === 0)
      return errorResponse(
        403,
        "account_not_authorized",
        "This token has no available Cloudflare accounts."
      );
    const nonceBytes = crypto.getRandomValues(new Uint8Array(24));
    const session: DeploymentSession = {
      version: 1,
      ownerId: user.id,
      repositoryId,
      ref,
      digest: current.digest,
      sourceDigests: declaredSourcePaths(current.manifest).map(
        (path) => current.sourceDigests[path]
      ),
      token: body.token,
      nonce: bytesToBase64Url(nonceBytes),
      accountId: null,
      resourceNames: {},
      expiresAt: Date.now() + SESSION_SECONDS * 1000,
      completed: {},
    };
    const sealed = await seal(env, session);
    logger.info("deploy:session-created", { repositoryId, accountCount: accounts.length });
    return dataResponse(
      {
        accounts: accounts.map(({ id, name }) => ({ id, name })),
        permissions: manifestPermissions(current.manifest),
        nonce: session.nonce,
      },
      200,
      { "Set-Cookie": cookieHeader(sealed, SESSION_SECONDS) }
    );
  }
  if (request.method === "POST" && parts[0] === "account") {
    if (isAgent(user))
      return errorResponse(
        403,
        "agent_deploy_forbidden",
        "Agent sessions cannot grant Cloudflare account access."
      );
    const session = await unseal(env, request, user, repositoryId, ref);
    if (!session)
      return errorResponse(401, "deploy_session_required", "Create a deployment session first.");
    const current = await readDeploymentPlan(env, repositoryId, ref, user);
    if (!current || current.digest !== session.digest)
      return errorResponse(
        409,
        "manifest_changed",
        "The deployment manifest or source changed. Review the plan again."
      );
    const body = await readJsonBody<{ accountId?: unknown; nonce?: unknown }>(request);
    if (!hasValidNonce(session, body))
      return errorResponse(403, "csrf_rejected", "Deployment session nonce is invalid.");
    if (!body || typeof body.accountId !== "string" || !/^[a-f0-9]{32}$/.test(body.accountId))
      return errorResponse(400, "bad_request", "Select a Cloudflare account.");
    let accounts: CfAccount[];
    try {
      accounts = await listAccounts(session.token);
    } catch {
      logger.warn("deploy:account-lookup-failed", { repositoryId });
      return errorResponse(
        502,
        "account_lookup_failed",
        "Cloudflare account access could not be checked."
      );
    }
    if (!accounts.some((item) => item.id === body.accountId))
      return errorResponse(
        403,
        "account_not_authorized",
        "Selected account is not available to this token."
      );
    session.accountId = body.accountId;
    logger.info("deploy:account-selected", { repositoryId, accountId: body.accountId });
    return dataResponse({ accountId: body.accountId }, 200, {
      "Set-Cookie": cookieHeader(await seal(env, session), SESSION_SECONDS),
    });
  }
  if (request.method === "DELETE" && parts[0] === "session")
    return dataResponse({ cleared: true }, 200, {
      "Set-Cookie": cookieHeader("", 0),
    });
  const selected = await selectedSession(env, request, user, repositoryId, ref);
  if (selected instanceof Response) return selected;
  if (!selected.session.accountId)
    return errorResponse(400, "account_required", "Select a Cloudflare account first.");
  if (request.method === "POST" && parts[0] === "resources") {
    const body = await readJsonBody<{ nonce?: unknown; resourceNames?: unknown }>(request);
    if (!hasValidNonce(selected.session, body))
      return errorResponse(403, "csrf_rejected", "Deployment session nonce is invalid.");
    const selectedNames = validResourceNames(selected.currentManifest, body?.resourceNames);
    if (!selectedNames)
      return errorResponse(
        400,
        "bad_request",
        "Resource names do not match the deployment manifest."
      );
    const targets = resourceEndpoints(
      selected.currentManifest,
      selected.session.accountId,
      selectedNames
    );
    const availability = await Promise.all(
      targets.map(async (item) => {
        const normalized = await listResources(selected.session.token, item);
        return {
          id: item.resourceId,
          key: item.key,
          kind: item.kind,
          name: item.name,
          exists: normalized.some((entry) => entry.name === item.name),
        };
      })
    );
    return dataResponse({ resources: availability });
  }
  if (request.method === "POST" && parts[0] === "provision") {
    const body = await readJsonBody<{ nonce?: unknown; resourceNames?: unknown }>(request);
    if (!hasValidNonce(selected.session, body))
      return errorResponse(403, "csrf_rejected", "Deployment session nonce is invalid.");
    const names = validResourceNames(selected.currentManifest, body?.resourceNames);
    if (!names)
      return errorResponse(
        400,
        "bad_request",
        "Resource names do not match the deployment manifest."
      );
    if (
      Object.keys(selected.session.resourceNames).length &&
      JSON.stringify(names) !== JSON.stringify(selected.session.resourceNames)
    )
      return errorResponse(
        409,
        "resource_names_locked",
        "Resource names are locked after the first provisioning attempt."
      );
    selected.session.resourceNames = names;
    const targets = resourceEndpoints(selected.currentManifest, selected.session.accountId, names);
    const done: Array<{ key: string; id: string; name: string; reused: boolean }> = [];
    for (const target of targets) {
      try {
        const before = await listResources(selected.session.token, target);
        const resource = await ensureResource(selected.session, target, before);
        const reused = before.some((item) => item.id === resource.id);
        done.push({ key: target.key, id: resource.id, name: target.name, reused });
        logger.info("deploy:resource-ready", { kind: target.kind, name: target.name, reused });
      } catch {
        logger.warn("deploy:resource-failed", { kind: target.kind, name: target.name });
        return errorResponse(
          502,
          "resource_provision_failed",
          `Could not create or reuse the declared ${target.kind} resource. Retry to continue safely.`,
          {
            "Set-Cookie": cookieHeader(await seal(env, selected.session), SESSION_SECONDS),
          }
        );
      }
    }
    const envelope = dataResponse({ resources: done }, 200, {
      "Set-Cookie": cookieHeader(await seal(env, selected.session), SESSION_SECONDS),
    });
    return envelope;
  }
  if (request.method === "POST" && parts[0] === "migrate") {
    const body = await readJsonBody<{ nonce?: unknown }>(request);
    if (!hasValidNonce(selected.session, body))
      return errorResponse(403, "csrf_rejected", "Deployment session nonce is invalid.");
    try {
      await applyD1Migrations(
        selected.session,
        selected.currentManifest,
        repositoryId,
        ref,
        user,
        selected.session.sourceDigests,
        logger,
        env
      );
    } catch {
      logger.warn("deploy:migration-failed", { repositoryId });
      return errorResponse(
        502,
        "migration_failed",
        "A declared database migration failed. Completed migrations can be safely retried."
      );
    }
    return dataResponse(
      {
        completed: selected.currentManifest.resources.d1.flatMap((database) =>
          database.migrations.map((path) => `${database.id}:${path}`)
        ),
      },
      200,
      {
        "Set-Cookie": cookieHeader(await seal(env, selected.session), SESSION_SECONDS),
      }
    );
  }
  if (request.method === "POST" && parts[0] === "deploy") {
    if (isAgent(user))
      return errorResponse(
        403,
        "agent_deploy_forbidden",
        "Agent sessions cannot grant Cloudflare account access."
      );
    const manifest = selected.currentManifest;
    const body = await readJsonBody<{
      workerName?: unknown;
      confirmDigest?: unknown;
      nonce?: unknown;
    }>(request);
    if (!hasValidNonce(selected.session, body))
      return errorResponse(403, "csrf_rejected", "Deployment session nonce is invalid.");
    if (
      !body ||
      body.confirmDigest !== selected.session.digest ||
      typeof body.workerName !== "string"
    )
      return errorResponse(
        400,
        "confirmation_required",
        "Confirm the reviewed manifest before deploying."
      );
    const workerName = safeName(body.workerName);
    if (!workerName || workerName.length > 58)
      return errorResponse(400, "bad_request", "Worker name is invalid.");
    const modulePaths = Array.from(
      new Set([manifest.worker.entrypoint, ...manifest.worker.modules])
    );
    const modules: Array<{ path: string; content: string }> = [];
    let moduleBytes = 0;
    for (const modulePath of modulePaths) {
      const content = await readDeclaredFile(
        env,
        repositoryId,
        ref,
        user,
        modulePath,
        MAX_CF_BODY_BYTES
      );
      if (content === null)
        return errorResponse(404, "module_missing", "A declared Worker module was not found.");
      const sourceIndex = declaredSourcePaths(manifest).indexOf(modulePath);
      if (
        sourceIndex < 0 ||
        (await sourceDigest(content)) !== selected.session.sourceDigests[sourceIndex]
      )
        return errorResponse(
          409,
          "source_changed",
          "A declared Worker module changed after review."
        );
      if (typeof content !== "string")
        return errorResponse(
          400,
          "module_invalid",
          "A declared Worker module is binary or invalid."
        );
      moduleBytes += new TextEncoder().encode(content).byteLength;
      if (moduleBytes > MAX_CF_BODY_BYTES)
        return errorResponse(
          413,
          "modules_too_large",
          "Declared Worker modules exceed the upload size limit."
        );
      modules.push({ path: modulePath, content });
    }
    const bindings: Array<Record<string, unknown>> = [];
    for (const item of manifest.resources.d1)
      bindings.push({
        type: "d1",
        name: item.binding,
        id: selected.session.completed[`d1:${item.id}`],
      });
    for (const item of manifest.resources.r2)
      bindings.push({
        type: "r2_bucket",
        name: item.binding,
        bucket_name: selected.session.resourceNames[item.id] ?? item.name,
      });
    for (const item of manifest.resources.kv)
      bindings.push({
        type: "kv_namespace",
        name: item.binding,
        namespace_id: selected.session.completed[`kv:${item.id}`],
      });
    for (const [name, value] of Object.entries(manifest.worker.vars))
      bindings.push({ type: "plain_text", name, text: value });
    const metadata = {
      main_module: manifest.worker.entrypoint,
      compatibility_date: manifest.worker.compatibilityDate,
      compatibility_flags: manifest.worker.compatibilityFlags,
      bindings,
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const module of modules)
      form.append(
        module.path,
        new Blob([module.content], { type: "application/javascript+module" }),
        module.path
      );
    try {
      await cf(
        selected.session.token,
        cfPath(selected.session.accountId, `workers/scripts/${encodeURIComponent(workerName)}`),
        z.unknown(),
        { method: "PUT", body: form }
      );
    } catch {
      logger.warn("deploy:worker-upload-failed", { repositoryId, workerName });
      return errorResponse(
        502,
        "worker_upload_failed",
        "Cloudflare rejected the Worker upload. You can retry this step."
      );
    }
    const subdomainPath = cfPath(
      selected.session.accountId,
      `workers/scripts/${encodeURIComponent(workerName)}/subdomain`
    );
    try {
      await cf(selected.session.token, subdomainPath, z.unknown(), {
        method: "POST",
        headers: { "Cloudflare-Workers-Script-Api-Date": "2025-08-01" },
        body: JSON.stringify({ enabled: true, previews_enabled: false }),
      });
    } catch {
      return activationFailure(
        env,
        selected.session,
        logger,
        repositoryId,
        workerName,
        "activation_api_rejected"
      );
    }
    const script = await cf(
      selected.session.token,
      cfPath(selected.session.accountId, `workers/workers/${encodeURIComponent(workerName)}`),
      WorkerScriptSchema
    ).catch(() => {
      logger.warn("deploy:worker-lookup-failed", { repositoryId, workerName });
      return null;
    });
    const workerUrl = script?.subdomain?.url;
    if (script?.subdomain?.enabled !== true || typeof workerUrl !== "string")
      return activationFailure(
        env,
        selected.session,
        logger,
        repositoryId,
        workerName,
        "activation_not_confirmed"
      );
    let confirmedUrl: URL;
    try {
      confirmedUrl = new URL(workerUrl);
    } catch {
      return activationFailure(
        env,
        selected.session,
        logger,
        repositoryId,
        workerName,
        "workers_dev_url_invalid"
      );
    }
    if (confirmedUrl.protocol !== "https:" || !confirmedUrl.hostname.endsWith(".workers.dev"))
      return activationFailure(
        env,
        selected.session,
        logger,
        repositoryId,
        workerName,
        "workers_dev_url_invalid"
      );
    const result = {
      workerName,
      url: confirmedUrl.toString(),
      resources: Object.entries(selected.session.completed)
        .filter(([key]) => !key.startsWith("migration:"))
        .map(([key, id]) => ({ key, id })),
    };
    logger.info("deploy:worker-deployed", {
      repositoryId,
      workerName,
      hasWorkersDevUrl: true,
    });
    return dataResponse(result, 200, {
      "Set-Cookie": cookieHeader("", 0),
    });
  }
  if (request.method === "POST" && parts[0] === "result") {
    return dataResponse({ completed: Object.keys(selected.session.completed) });
  }
  return errorResponse(404, "not_found", "Deployment endpoint was not found.");
}

export async function handleDeploy(
  request: Request,
  env: DeployEnv,
  logger: DeployLogger
): Promise<Response> {
  try {
    return await handleDeployRequest(request, env, logger);
  } catch {
    logger.error("deploy:request-failed");
    return errorResponse(
      502,
      "deploy_request_failed",
      "The deployment request failed. Retry the current step."
    );
  }
}
