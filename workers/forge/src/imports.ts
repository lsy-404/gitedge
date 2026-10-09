import {
  CreateRepositoryImportInputSchema,
  GitImportResultSchema,
  REPOSITORY_IMPORT_ERROR_CODES,
  REPOSITORY_IMPORT_STALE_MS,
  parseUserGroupLimits,
  validateImportUrl,
  type RepositoryImport,
  type RepositoryImportErrorCode,
  type RepositoryImportStatus,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { parseJson, type ForgeEnv } from "./common";

export interface ImportOwner {
  readonly id: string;
  readonly slug: string;
  readonly canCreate: boolean;
}

export interface ImportContext {
  readonly request: Request;
  readonly env: ForgeEnv;
  readonly user: TrustedUser;
  readonly parts: string[];
  readonly resolveOwner: (slug: string) => Promise<ImportOwner | null>;
  readonly defer: (task: Promise<unknown>) => void;
}

type ImportRow = {
  id: string;
  namespace_id: string;
  owner: string;
  created_by: string;
  slug: string;
  visibility: "public" | "private";
  description: string;
  source_url: string;
  status: RepositoryImportStatus;
  progress: string;
  error_code: RepositoryImportErrorCode | null;
  error: string | null;
  attempt: number;
  repository_id: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

const SELECT_IMPORT =
  "SELECT i.*, n.slug AS owner FROM repository_imports i JOIN namespaces n ON n.id = i.namespace_id";

/** Legal job transitions; every write is a conditional update on the previous status. */
export const IMPORT_TRANSITIONS: Readonly<
  Record<RepositoryImportStatus, readonly RepositoryImportStatus[]>
> = {
  queued: ["running"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: ["queued"],
};

export function canTransition(from: RepositoryImportStatus, to: RepositoryImportStatus): boolean {
  return IMPORT_TRANSITIONS[from].includes(to);
}

const ERROR_MESSAGES: Readonly<Record<RepositoryImportErrorCode, string>> = {
  invalid_url: "The URL is not a public https Git repository.",
  remote_auth_required: "The source repository is not public.",
  remote_not_found: "The source repository was not found.",
  upstream_unavailable: "The source host could not be reached.",
  size_limit: "The source repository is too large to import.",
  name_taken: "Repository name is already used or reserved by a rename.",
  timed_out: "The import did not finish in time.",
  import_failed: "The import failed.",
};

function errorCode(value: unknown): RepositoryImportErrorCode {
  return REPOSITORY_IMPORT_ERROR_CODES.find((code) => code === value) ?? "import_failed";
}

function response(row: ImportRow): RepositoryImport {
  return {
    id: row.id,
    owner: row.owner,
    slug: row.slug,
    visibility: row.visibility,
    description: row.description,
    sourceUrl: row.source_url,
    status: row.status,
    progress: row.progress,
    errorCode: row.error_code,
    error: row.error,
    attempt: row.attempt,
    repositoryId: row.repository_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

async function loadImport(env: ForgeEnv, id: string, userId: string): Promise<ImportRow | null> {
  const row = await env.DB.prepare(`${SELECT_IMPORT} WHERE i.id = ? AND i.created_by = ?`)
    .bind(id, userId)
    .first<ImportRow>();
  if (!row) return null;
  if (row.status !== "running" || row.updated_at > Date.now() - REPOSITORY_IMPORT_STALE_MS)
    return row;
  const now = Date.now();
  await failImport(env, row.id, "timed_out", now);
  return (
    (await env.DB.prepare(`${SELECT_IMPORT} WHERE i.id = ?`).bind(id).first<ImportRow>()) ?? row
  );
}

async function failImport(
  env: ForgeEnv,
  id: string,
  code: RepositoryImportErrorCode,
  now: number
): Promise<void> {
  await env.DB.prepare(
    "UPDATE repository_imports SET status='failed', progress='', error_code=?, error=?, finished_at=?, updated_at=? WHERE id=? AND status='running'"
  )
    .bind(code, ERROR_MESSAGES[code], now, now, id)
    .run();
}

/** Claims a queued job and runs it to a terminal state. Safe to call twice: only one caller wins. */
export async function runImport(env: ForgeEnv, id: string): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const claimedAt = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE repository_imports SET status='running', progress='importing', attempt=attempt+1, error_code=NULL, error=NULL, started_at=?, finished_at=NULL, updated_at=? WHERE id=? AND status='queued' RETURNING namespace_id, created_by, slug, visibility, description, source_url, attempt"
  )
    .bind(claimedAt, claimedAt, id)
    .first<{
      namespace_id: string;
      created_by: string;
      slug: string;
      visibility: "public" | "private";
      description: string;
      source_url: string;
      attempt: number;
    }>();
  if (!claimed) return;
  const repositoryId = crypto.randomUUID();
  const artifactName = `repo-${repositoryId}`;
  logger.info("forge:repository-import-started", { importId: id, attempt: claimed.attempt });
  try {
    const gitResponse = await env.GIT.fetch(
      new Request("https://git.internal/internal/imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: artifactName,
          sourceUrl: claimed.source_url,
          description: claimed.description,
        }),
      })
    );
    const payload: unknown = await gitResponse.json().catch(() => null);
    if (!gitResponse.ok) {
      const code =
        payload && typeof payload === "object" && "error" in payload
          ? errorCode(
              payload.error && typeof payload.error === "object" && "code" in payload.error
                ? payload.error.code
                : null
            )
          : "import_failed";
      logger.warn("forge:repository-import-failed", { importId: id, code });
      await failImport(env, id, code, Date.now());
      return;
    }
    const result = GitImportResultSchema.safeParse(
      payload && typeof payload === "object" && "data" in payload ? payload.data : null
    );
    if (!result.success) {
      await failImport(env, id, "import_failed", Date.now());
      return;
    }
    const now = Date.now();
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          repositoryId,
          claimed.namespace_id,
          claimed.created_by,
          claimed.slug,
          `repo:${repositoryId}`,
          result.data.name,
          result.data.remote,
          result.data.defaultBranch,
          claimed.visibility,
          claimed.description,
          now,
          now
        ),
        env.DB.prepare("INSERT INTO forge_counters (repository_id) VALUES (?)").bind(repositoryId),
        env.DB.prepare(
          "UPDATE repository_imports SET status='succeeded', progress='', repository_id=?, finished_at=?, updated_at=? WHERE id=? AND status='running'"
        ).bind(repositoryId, now, now, id),
      ]);
    } catch (cause) {
      logger.error("forge:repository-import-record-failed", {
        importId: id,
        error: cause instanceof Error ? cause.message : "unknown",
      });
      await env.ARTIFACTS.delete(result.data.name).catch(() => false);
      await failImport(env, id, "name_taken", Date.now());
      return;
    }
    logger.info("forge:repository-import-succeeded", { importId: id, repositoryId });
  } catch (cause) {
    logger.error("forge:repository-import-error", {
      importId: id,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    await failImport(env, id, "import_failed", Date.now());
  }
}

async function createImport(context: ImportContext): Promise<Response> {
  const { env, user } = context;
  const parsed = CreateRepositoryImportInputSchema.safeParse(await parseJson(context.request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid import payload.");
  const source = validateImportUrl(parsed.data.sourceUrl);
  if (!source.ok) return errorResponse(422, "invalid_url", ERROR_MESSAGES.invalid_url);
  const owner = await context.resolveOwner(parsed.data.owner);
  if (!owner) return errorResponse(404, "not_found", "Repository owner was not found.");
  if (!owner.canCreate)
    return errorResponse(403, "forbidden", "Repository creation requires namespace owner access.");
  const limits = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
  const maxRepositories = (limits[user.groupKey] ?? limits.free).maxRepositories;
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM repositories WHERE created_by = ?1) + (SELECT COUNT(*) FROM repository_imports WHERE created_by = ?1 AND status IN ('queued','running')) AS count"
  )
    .bind(user.id)
    .first<{ count: number }>();
  if ((counts?.count ?? 0) >= maxRepositories)
    return errorResponse(403, "forbidden", "Repository limit reached for this user group.");
  const taken = await env.DB.prepare(
    "SELECT 1 AS taken FROM repository_paths WHERE namespace_id = ? AND slug = ?"
  )
    .bind(owner.id, parsed.data.slug)
    .first();
  if (taken)
    return errorResponse(
      409,
      "conflict",
      "Repository name is already used or reserved by a rename."
    );
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO repository_imports (id, namespace_id, created_by, slug, visibility, description, source_url, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)"
    )
      .bind(
        id,
        owner.id,
        user.id,
        parsed.data.slug,
        parsed.data.visibility,
        parsed.data.description,
        source.url,
        now,
        now
      )
      .run();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("UNIQUE"))
      return errorResponse(
        409,
        "conflict",
        "An import to this repository name is already running."
      );
    throw cause;
  }
  createLogger(env.LOG_LEVEL, { service: "forge" }).info("forge:repository-import-queued", {
    importId: id,
    namespaceId: owner.id,
    userId: user.id,
  });
  context.defer(runImport(env, id));
  const row = await loadImport(env, id, user.id);
  return row
    ? dataResponse(response(row), 202)
    : errorResponse(503, "internal_error", "Import was not recorded.");
}

async function retryImport(context: ImportContext, id: string): Promise<Response> {
  const { env, user } = context;
  const row = await loadImport(env, id, user.id);
  if (!row) return errorResponse(404, "not_found", "Import was not found.");
  if (!canTransition(row.status, "queued"))
    return errorResponse(409, "conflict", "Only failed imports can be retried.");
  const owner = await context.resolveOwner(row.owner);
  if (!owner?.canCreate)
    return errorResponse(403, "forbidden", "Repository creation requires namespace owner access.");
  const now = Date.now();
  try {
    const changed = await env.DB.prepare(
      "UPDATE repository_imports SET status='queued', progress='queued', error_code=NULL, error=NULL, finished_at=NULL, updated_at=? WHERE id=? AND status='failed'"
    )
      .bind(now, id)
      .run();
    if (!changed.meta.changes)
      return errorResponse(409, "conflict", "Only failed imports can be retried.");
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("UNIQUE"))
      return errorResponse(
        409,
        "conflict",
        "An import to this repository name is already running."
      );
    throw cause;
  }
  context.defer(runImport(env, id));
  const next = await loadImport(env, id, user.id);
  return next
    ? dataResponse(response(next), 202)
    : errorResponse(404, "not_found", "Import was not found.");
}

/** Routes /repository-imports requests; returns null for other paths. */
export async function handleRepositoryImports(context: ImportContext): Promise<Response | null> {
  const { request, parts, user, env } = context;
  if (parts[0] !== "repository-imports") return null;
  if (user.agentSession) return errorResponse(403, "forbidden", "Agent sessions cannot import.");
  const id = parts[1];
  if (!id && request.method === "POST") return createImport(context);
  if (!id && request.method === "GET") {
    const rows = await env.DB.prepare(
      `${SELECT_IMPORT} WHERE i.created_by = ? AND i.status != 'succeeded' ORDER BY i.created_at DESC LIMIT 50`
    )
      .bind(user.id)
      .all<ImportRow>();
    return dataResponse(rows.results.map(response));
  }
  if (id && parts.length === 2 && request.method === "GET") {
    const row = await loadImport(env, id, user.id);
    return row
      ? dataResponse(response(row))
      : errorResponse(404, "not_found", "Import was not found.");
  }
  if (id && parts.length === 3 && parts[2] === "retry" && request.method === "POST")
    return retryImport(context, id);
  return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
}
