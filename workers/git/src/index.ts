import { GitWriteConflict } from "./write";
import { createLogger } from "../../../src/worker/common/logger";
import { handleGitApi } from "./api";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { proxyGitTransport } from "./transport";
import { GitResourceLimitError } from "./http";
import type { GitEnv } from "./access";

export default {
  async fetch(request: Request, env: GitEnv, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/internal/health")
      return dataResponse({ ok: true });
    try {
      return new URL(request.url).pathname.includes(".git/")
        ? await proxyGitTransport(request, env, ctx)
        : await handleGitApi(request, env, ctx);
    } catch (error) {
      const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git" });
      if (error instanceof GitWriteConflict)
        return errorResponse(409, "merge_changed", error.message);
      if (error instanceof GitResourceLimitError) {
        logger.warn("artifacts:operation-limit", {});
        return errorResponse(413, "operation_limit", error.message);
      }
      logger.error("artifacts:operation-failed", {});
      return errorResponse(503, "service_unavailable", "Artifacts operation failed.");
    }
  },
};
