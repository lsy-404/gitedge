import {
  CreateRepositoryImportInputSchema,
  GitImportStateSchema,
  REPOSITORY_IMPORT_ERROR_CODES,
  REPOSITORY_IMPORT_MAX_MS,
  REPOSITORY_IMPORT_STALE_MS,
  parseUserGroupLimits,
  validateImportUrl,
  type GitImportState,
  type RepositoryImport,
  type RepositoryImportErrorCode,
  type RepositoryImportProgress,
  type RepositoryImportStatus,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
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
  progress: RepositoryImportProgress;
  error_code: RepositoryImportErrorCode | null;
  error: string | null;
  attempt: number;
  artifact_name: string | null;
  repository_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type GitOutcome =
  | { readonly kind: "state"; readonly state: GitImportState }
  | { readonly kind: "failed"; readonly code: RepositoryImportErrorCode }
  | { readonly kind: "pending" };

const SELECT_IMPORT =
  "SELECT i.*, n.slug AS owner FROM repository_imports i JOIN namespaces n ON n.id = i.namespace_id";
/** Binds (userId, namespaceId, userId): the creator may still create repositories in the namespace. */
const OWNER_ACCESS =
  "EXISTS (SELECT 1 FROM namespaces n LEFT JOIN namespace_memberships m ON m.namespace_id = n.id AND m.user_id = ? WHERE n.id = ? AND ((n.kind = 'organization' AND m.role = 'owner') OR (n.kind <> 'organization' AND n.created_by = ?)))";
/** Minimum spacing between status checks of one job, which also stops concurrent pollers. */
const STATUS_CHECK_INTERVAL_MS = 1000;

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
  access_revoked: "Namespace owner access was removed during the import.",
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

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown";
}

async function callGit(env: ForgeEnv, path: string, body: unknown): Promise<GitOutcome> {
  const gitResponse = await env.GIT.fetch(
    new Request(`https://git.internal${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  const payload: unknown = await gitResponse.json().catch(() => null);
  if (gitResponse.ok) {
    const state = GitImportStateSchema.safeParse(
      payload && typeof payload === "object" && "data" in payload ? payload.data : null
    );
    return state.success ? { kind: "state", state: state.data } : { kind: "pending" };
  }
  const code =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "code" in payload.error
      ? payload.error.code
      : null;
  return code === "import_pending"
    ? { kind: "pending" }
    : { kind: "failed", code: errorCode(code) };
}

async function discardArtifact(env: ForgeEnv, name: string, logger: Logger): Promise<void> {
  try {
    const discarded = await env.GIT.fetch(
      new Request("https://git.internal/internal/imports/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    await discarded.body?.cancel();
    if (!discarded.ok)
      logger.warn("forge:repository-import-discard-failed", { name, status: discarded.status });
  } catch (cause) {
    logger.warn("forge:repository-import-discard-failed", { name, error: errorText(cause) });
  }
}

/** Fails the attempt that owns `artifactName`; returns false when another writer finished it. */
async function failImport(
  env: ForgeEnv,
  id: string,
  artifactName: string,
  code: RepositoryImportErrorCode
): Promise<boolean> {
  const now = Date.now();
  const changed = await env.DB.prepare(
    "UPDATE repository_imports SET status='failed', progress='', error_code=?, error=?, finished_at=?, updated_at=? WHERE id=? AND status='running' AND artifact_name=?"
  )
    .bind(code, ERROR_MESSAGES[code], now, now, id, artifactName)
    .run();
  return changed.meta.changes > 0;
}

async function failAndDiscard(
  env: ForgeEnv,
  id: string,
  artifactName: string,
  code: RepositoryImportErrorCode,
  logger: Logger
): Promise<void> {
  logger.warn("forge:repository-import-failed", { importId: id, code });
  if (await failImport(env, id, artifactName, code))
    await discardArtifact(env, artifactName, logger);
}

type ClaimedImport = Pick<
  ImportRow,
  "id" | "namespace_id" | "created_by" | "slug" | "visibility" | "description"
> & { artifact_name: string };

/** Inserts the repository and completes the job in one batch, only while this attempt is running. */
async function recordImport(
  env: ForgeEnv,
  job: ClaimedImport,
  ready: Extract<GitImportState, { state: "ready" }>,
  logger: Logger
): Promise<void> {
  const ownerAccess = env.DB.prepare(`SELECT 1 AS allowed WHERE ${OWNER_ACCESS}`).bind(
    job.created_by,
    job.namespace_id,
    job.created_by
  );
  if (!(await ownerAccess.first())) {
    await failAndDiscard(env, job.id, job.artifact_name, "access_revoked", logger);
    return;
  }
  const repositoryId = crypto.randomUUID();
  const now = Date.now();
  const running = `EXISTS (SELECT 1 FROM repository_imports WHERE id = ? AND status = 'running' AND artifact_name = ?) AND ${OWNER_ACCESS}`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO repositories (id, namespace_id, created_by, slug, do_name, artifact_name, remote, default_branch, visibility, description, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${running}`
      ).bind(
        repositoryId,
        job.namespace_id,
        job.created_by,
        job.slug,
        `repo:${repositoryId}`,
        job.artifact_name,
        ready.remote,
        ready.defaultBranch,
        job.visibility,
        job.description,
        now,
        now,
        job.id,
        job.artifact_name,
        job.created_by,
        job.namespace_id,
        job.created_by
      ),
      env.DB.prepare(
        "INSERT INTO forge_counters (repository_id) SELECT ? WHERE EXISTS (SELECT 1 FROM repositories WHERE id = ?)"
      ).bind(repositoryId, repositoryId),
      env.DB.prepare(
        "UPDATE repository_imports SET status='succeeded', progress='', repository_id=?, finished_at=?, updated_at=? WHERE id=? AND status='running' AND artifact_name=? AND EXISTS (SELECT 1 FROM repositories WHERE id = ?)"
      ).bind(repositoryId, now, now, job.id, job.artifact_name, repositoryId),
    ]);
  } catch (cause) {
    const message = errorText(cause);
    logger.error("forge:repository-import-record-failed", { importId: job.id, error: message });
    // Other D1 errors are transient: the job stays running and the next status check retries.
    if (message.includes("UNIQUE") || message.includes("repository path"))
      await failAndDiscard(env, job.id, job.artifact_name, "name_taken", logger);
    return;
  }
  logger.info("forge:repository-import-recorded", { importId: job.id, repositoryId });
}

async function applyOutcome(
  env: ForgeEnv,
  job: ClaimedImport,
  outcome: GitOutcome,
  logger: Logger
): Promise<void> {
  if (outcome.kind === "failed") {
    await failAndDiscard(env, job.id, job.artifact_name, outcome.code, logger);
    return;
  }
  if (outcome.kind === "state" && outcome.state.state === "ready") {
    await recordImport(env, job, outcome.state, logger);
    return;
  }
  const changed = await env.DB.prepare(
    "UPDATE repository_imports SET progress='importing', updated_at=? WHERE id=? AND status='running' AND artifact_name=?"
  )
    .bind(Date.now(), job.id, job.artifact_name)
    .run();
  if (!changed.meta.changes) await discardArtifact(env, job.artifact_name, logger);
}

/** Claims a queued job and starts its Artifacts import. Safe to call twice: only one caller wins. */
export async function runImport(env: ForgeEnv, id: string): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const claimedAt = Date.now();
  const artifactName = `repo-${crypto.randomUUID()}`;
  const claimed = await env.DB.prepare(
    "UPDATE repository_imports SET status='running', progress='starting', artifact_name=?, attempt=attempt+1, error_code=NULL, error=NULL, started_at=?, finished_at=NULL, updated_at=? WHERE id=? AND status='queued' RETURNING id, namespace_id, created_by, slug, visibility, description, source_url, attempt"
  )
    .bind(artifactName, claimedAt, claimedAt, id)
    .first<ClaimedImport & Pick<ImportRow, "source_url" | "attempt">>();
  if (!claimed) return;
  const job: ClaimedImport = { ...claimed, artifact_name: artifactName };
  logger.info("forge:repository-import-started", { importId: id, attempt: claimed.attempt });
  try {
    const outcome = await callGit(env, "/internal/imports", {
      name: artifactName,
      sourceUrl: claimed.source_url,
      description: claimed.description,
    });
    await applyOutcome(env, job, outcome, logger);
  } catch (cause) {
    logger.error("forge:repository-import-error", { importId: id, error: errorText(cause) });
    await failAndDiscard(env, id, artifactName, "import_failed", logger);
  }
}

/** Times out lost attempts and, at most once per interval, asks Git whether the import is ready. */
async function advanceImport(env: ForgeEnv, row: ImportRow, logger: Logger): Promise<void> {
  if (row.status !== "running" || !row.artifact_name) return;
  const job: ClaimedImport = { ...row, artifact_name: row.artifact_name };
  const now = Date.now();
  const lostRunner =
    row.progress === "starting" && row.updated_at < now - REPOSITORY_IMPORT_STALE_MS;
  const overdue = (row.started_at ?? row.updated_at) < now - REPOSITORY_IMPORT_MAX_MS;
  if (lostRunner || overdue) {
    await failAndDiscard(env, row.id, row.artifact_name, "timed_out", logger);
    return;
  }
  if (row.progress !== "importing") return;
  const lease = await env.DB.prepare(
    "UPDATE repository_imports SET updated_at=? WHERE id=? AND status='running' AND progress='importing' AND artifact_name=? AND updated_at<=?"
  )
    .bind(now, row.id, row.artifact_name, now - STATUS_CHECK_INTERVAL_MS)
    .run();
  if (!lease.meta.changes) return;
  const outcome = await callGit(env, "/internal/imports/status", { name: row.artifact_name });
  if (outcome.kind !== "pending") await applyOutcome(env, job, outcome, logger);
}

async function loadImport(env: ForgeEnv, id: string, userId: string): Promise<ImportRow | null> {
  const select = env.DB.prepare(`${SELECT_IMPORT} WHERE i.id = ? AND i.created_by = ?`).bind(
    id,
    userId
  );
  const row = await select.first<ImportRow>();
  if (!row || row.status !== "running") return row;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  try {
    await advanceImport(env, row, logger);
  } catch (cause) {
    logger.error("forge:repository-import-advance-failed", {
      importId: id,
      error: errorText(cause),
    });
  }
  return (await select.first<ImportRow>()) ?? row;
}

async function quotaReached(env: ForgeEnv, user: TrustedUser): Promise<boolean> {
  const limits = parseUserGroupLimits(env.USER_GROUP_LIMITS_JSON);
  const maxRepositories = (limits[user.groupKey] ?? limits.free).maxRepositories;
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM repositories WHERE created_by = ?1) + (SELECT COUNT(*) FROM repository_imports WHERE created_by = ?1 AND status IN ('queued','running')) AS count"
  )
    .bind(user.id)
    .first<{ count: number }>();
  return (counts?.count ?? 0) >= maxRepositories;
}

async function pathTaken(env: ForgeEnv, namespaceId: string, slug: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 AS taken FROM repository_paths WHERE namespace_id = ? AND slug = ?"
    )
      .bind(namespaceId, slug)
      .first()
  );
}

/** True while a queued or running import reserves this repository path. */
export async function activeImportPath(
  env: ForgeEnv,
  namespaceId: string,
  slug: string
): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 AS active FROM repository_imports WHERE namespace_id = ? AND slug = ? AND status IN ('queued','running')"
    )
      .bind(namespaceId, slug)
      .first()
  );
}

function activeConflict(cause: unknown): Response {
  if (cause instanceof Error && cause.message.includes("UNIQUE"))
    return errorResponse(409, "conflict", "An import to this repository name is already running.");
  throw cause;
}

const nameTaken = () =>
  errorResponse(409, "conflict", "Repository name is already used or reserved by a rename.");
const quotaExceeded = () =>
  errorResponse(403, "forbidden", "Repository limit reached for this user group.");
const ownerRequired = () =>
  errorResponse(403, "forbidden", "Repository creation requires namespace owner access.");

async function createImport(context: ImportContext): Promise<Response> {
  const { env, user } = context;
  const parsed = CreateRepositoryImportInputSchema.safeParse(await parseJson(context.request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid import payload.");
  const source = validateImportUrl(parsed.data.sourceUrl);
  if (!source.ok) return errorResponse(422, "invalid_url", ERROR_MESSAGES.invalid_url);
  const owner = await context.resolveOwner(parsed.data.owner);
  if (!owner) return errorResponse(404, "not_found", "Repository owner was not found.");
  if (!owner.canCreate) return ownerRequired();
  if (await quotaReached(env, user)) return quotaExceeded();
  if (await pathTaken(env, owner.id, parsed.data.slug)) return nameTaken();
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
    return activeConflict(cause);
  }
  createLogger(env.LOG_LEVEL, { service: "forge" }).info("forge:repository-import-queued", {
    importId: id,
    namespaceId: owner.id,
    userId: user.id,
  });
  context.defer(runImport(env, id));
  const row = await env.DB.prepare(`${SELECT_IMPORT} WHERE i.id = ?`).bind(id).first<ImportRow>();
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
  if (!owner?.canCreate) return ownerRequired();
  if (await quotaReached(env, user)) return quotaExceeded();
  if (await pathTaken(env, row.namespace_id, row.slug)) return nameTaken();
  try {
    const changed = await env.DB.prepare(
      "UPDATE repository_imports SET status='queued', progress='queued', error_code=NULL, error=NULL, finished_at=NULL, updated_at=? WHERE id=? AND status='failed'"
    )
      .bind(Date.now(), id)
      .run();
    if (!changed.meta.changes)
      return errorResponse(409, "conflict", "Only failed imports can be retried.");
  } catch (cause) {
    return activeConflict(cause);
  }
  context.defer(runImport(env, id));
  const next = await env.DB.prepare(`${SELECT_IMPORT} WHERE i.id = ?`).bind(id).first<ImportRow>();
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
  if (parts.length === 1 && request.method === "POST") return createImport(context);
  if (parts.length === 1 && request.method === "GET") {
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
