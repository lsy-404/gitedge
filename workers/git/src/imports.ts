import {
  GitImportInputSchema,
  validateImportUrl,
  type GitImportResult,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { readJsonLimited } from "../../../src/worker/common/readText";

interface ImportEnv {
  ARTIFACTS: Artifacts;
  LOG_LEVEL?: string;
}

function isArtifactsError(error: unknown): error is ArtifactsError {
  return error instanceof Error && error.name === "ArtifactsError" && "code" in error;
}

function failure(error: unknown): Response {
  const code = isArtifactsError(error) ? error.code : "INTERNAL_ERROR";
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

/** Streams a public remote into a new Artifacts repository using the native import. */
export async function importRepository(request: Request, env: ImportEnv): Promise<Response> {
  const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git" });
  const input = GitImportInputSchema.safeParse(await readJsonLimited(request, 8_192));
  if (!input.success) return errorResponse(400, "bad_request", "Invalid import payload.");
  const source = validateImportUrl(input.data.sourceUrl);
  if (!source.ok) {
    logger.warn("git:import-rejected", { reason: source.reason });
    return errorResponse(422, "invalid_url", "The URL is not a public https Git repository.");
  }
  let created: ArtifactsCreateRepoResult;
  try {
    created = await env.ARTIFACTS.import({
      source: { url: source.url },
      target: { name: input.data.name, opts: { description: input.data.description } },
    });
  } catch (cause) {
    const code = isArtifactsError(cause) ? cause.code : "INTERNAL_ERROR";
    logger.error("git:import-failed", { name: input.data.name, code });
    if (code !== "ALREADY_EXISTS") await discard(env, input.data.name, logger);
    return failure(cause);
  }
  try {
    using repo = await env.ARTIFACTS.get(created.name);
    if (!(await repo.revokeToken(created.token)))
      throw new Error("Initial repository token could not be revoked.");
  } catch (cause) {
    logger.error("git:import-token-revoke-failed", {
      name: created.name,
      error: cause instanceof Error ? cause.message : "unknown",
    });
    await discard(env, created.name, logger);
    return errorResponse(503, "import_failed", "The import failed.");
  }
  logger.info("git:import-completed", { name: created.name });
  const result: GitImportResult = {
    name: created.name,
    remote: created.remote,
    defaultBranch: created.defaultBranch,
  };
  return dataResponse(result, 201);
}

async function discard(env: ImportEnv, name: string, logger: Logger): Promise<void> {
  try {
    await env.ARTIFACTS.delete(name);
  } catch (cause) {
    logger.warn("git:import-cleanup-failed", {
      name,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
}
