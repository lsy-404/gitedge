import {
  GitImportInputSchema,
  GitImportTargetSchema,
  validateImportUrl,
  type GitImportState,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { resolvePublicHost, type HostResolver } from "../../../src/worker/common/public-host";

interface ImportEnv {
  ARTIFACTS: Artifacts;
  LOG_LEVEL?: string;
}

const MAX_INITIAL_TOKENS = 20;

function isArtifactsError(error: unknown): error is ArtifactsError {
  return error instanceof Error && error.name === "ArtifactsError" && "code" in error;
}

function artifactsCode(error: unknown): ArtifactsErrorCode {
  return isArtifactsError(error) ? error.code : "INTERNAL_ERROR";
}

function failure(code: ArtifactsErrorCode): Response {
  switch (code) {
    case "INVALID_INPUT":
    case "INVALID_URL":
      return errorResponse(422, "invalid_url", "The URL is not a public Git repository.");
    case "REMOTE_AUTH_REQUIRED":
      return errorResponse(422, "remote_auth_required", "The source repository is not public.");
    case "NOT_FOUND":
      return errorResponse(422, "remote_not_found", "The source repository was not found.");
    case "UPSTREAM_UNAVAILABLE":
      return errorResponse(502, "upstream_unavailable", "The source host could not be reached.");
    case "MEMORY_LIMIT":
      return errorResponse(413, "size_limit", "The source repository is too large to import.");
    default:
      return errorResponse(503, "import_failed", "The import failed.");
  }
}

/**
 * Revokes every token on a freshly imported repository and reports whether it is ready.
 * Artifacts can still be copying the remote after `import()` resolves; `get()` then throws
 * IMPORT_IN_PROGRESS and Forge polls again later.
 */
async function finalize(env: ImportEnv, name: string, logger: Logger): Promise<Response> {
  let repo: ArtifactsRepo;
  try {
    repo = await env.ARTIFACTS.get(name);
  } catch (cause) {
    const code = artifactsCode(cause);
    if (code === "IMPORT_IN_PROGRESS" || code === "CREATE_IN_PROGRESS")
      return dataResponse({ state: "importing" } satisfies GitImportState, 202);
    logger.warn("git:import-finalize-unavailable", { name, code });
    return code === "NOT_FOUND"
      ? errorResponse(422, "import_failed", "The imported repository no longer exists.")
      : errorResponse(503, "import_pending", "Repository status is temporarily unavailable.");
  }
  using handle = repo;
  try {
    const { tokens, total } = await handle.listTokens();
    if (total > MAX_INITIAL_TOKENS || total > tokens.length)
      throw new Error("Imported repository has unexpected tokens.");
    for (const token of tokens)
      if (token.state === "active" && !(await handle.revokeToken(token.id)))
        throw new Error("Initial repository token could not be revoked.");
    const info = await handle.info();
    logger.info("git:import-ready", { name });
    return dataResponse({
      state: "ready",
      name: info.name,
      remote: info.remote,
      defaultBranch: info.defaultBranch,
    } satisfies GitImportState);
  } catch (cause) {
    logger.error("git:import-finalize-failed", {
      name,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    return errorResponse(503, "import_pending", "Repository status is temporarily unavailable.");
  }
}

async function discard(env: ImportEnv, name: string, logger: Logger): Promise<boolean> {
  try {
    return await env.ARTIFACTS.delete(name);
  } catch (cause) {
    logger.warn("git:import-cleanup-failed", {
      name,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    return false;
  }
}

async function start(
  request: Request,
  env: ImportEnv,
  resolveHost: HostResolver,
  logger: Logger
): Promise<Response> {
  const input = GitImportInputSchema.safeParse(await readJsonLimited(request, 8_192));
  if (!input.success) return errorResponse(400, "bad_request", "Invalid import payload.");
  const source = validateImportUrl(input.data.sourceUrl);
  if (!source.ok) {
    logger.warn("git:import-rejected", { reason: source.reason });
    return errorResponse(422, "invalid_url", "The URL is not a public https Git repository.");
  }
  const host = await resolveHost(new URL(source.url).hostname);
  if (!host.ok) {
    logger.warn("git:import-rejected", { reason: host.reason });
    return host.reason === "resolver_error"
      ? errorResponse(502, "upstream_unavailable", "The source host could not be resolved.")
      : errorResponse(422, "invalid_url", "The URL does not resolve to a public address.");
  }
  try {
    // The initial token is revoked through listTokens() in finalize, so its plaintext is dropped here.
    await env.ARTIFACTS.import({
      source: { url: source.url },
      target: { name: input.data.name, opts: { description: input.data.description } },
    });
  } catch (cause) {
    const code = artifactsCode(cause);
    logger.error("git:import-failed", { name: input.data.name, code });
    if (code !== "ALREADY_EXISTS") await discard(env, input.data.name, logger);
    return failure(code);
  }
  logger.info("git:import-accepted", { name: input.data.name });
  return finalize(env, input.data.name, logger);
}

/**
 * Internal endpoints for Forge: start an import, poll it until ready (revoking the initial
 * token), and discard an attempt that Forge did not record.
 */
export async function handleInternalImports(
  request: Request,
  env: ImportEnv,
  resolveHost: HostResolver = resolvePublicHost
): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git" });
  const url = new URL(request.url);
  if (request.method !== "POST" || url.hostname !== "git.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  if (url.pathname === "/internal/imports") return start(request, env, resolveHost, logger);
  const target = GitImportTargetSchema.safeParse(await readJsonLimited(request, 1_024));
  if (!target.success) return errorResponse(400, "bad_request", "Invalid import target.");
  if (url.pathname === "/internal/imports/status") return finalize(env, target.data.name, logger);
  if (url.pathname === "/internal/imports/discard") {
    const deleted = await discard(env, target.data.name, logger);
    logger.info("git:import-discarded", { name: target.data.name, deleted });
    return dataResponse({ deleted });
  }
  return errorResponse(404, "not_found", "Endpoint was not found.");
}
