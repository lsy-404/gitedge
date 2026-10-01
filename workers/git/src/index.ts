import { createLogger } from "../../../src/worker/common/logger";
import { handleGitApi, fail } from "./api";
import { proxyGitTransport } from "./transport";
import { GitResourceLimitError } from "./http";
import type { GitEnv } from "./access";

export default {
  async fetch(request: Request, env: GitEnv): Promise<Response> {
    try {
      return new URL(request.url).pathname.includes(".git/")
        ? await proxyGitTransport(request, env)
        : await handleGitApi(request, env);
    } catch (error) {
      const logger = createLogger(env.LOG_LEVEL, { service: "artifacts-git" });
      if (error instanceof GitResourceLimitError) {
        logger.warn("artifacts:operation-limit", {});
        return fail(413, "operation_limit", error.message);
      }
      logger.error("artifacts:operation-failed", {});
      return fail(503, "service_unavailable", "Artifacts operation failed.");
    }
  },
};
