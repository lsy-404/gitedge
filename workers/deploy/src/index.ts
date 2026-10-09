import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { handleDeploy } from "./deploy";

type WorkerEnv = Cloudflare.Env & {
  DEPLOY_SESSION_KEY: string;
  DEPLOY_ORIGIN?: string;
  LOG_LEVEL?: string;
};

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const logger = createLogger(env.LOG_LEVEL, { service: "deploy" });
    if (request.method === "GET" && new URL(request.url).pathname === "/internal/health")
      return Promise.resolve(dataResponse({ ok: true }));
    if (!env.DEPLOY_SESSION_KEY || env.DEPLOY_SESSION_KEY.length < 32) {
      return Promise.resolve(
        errorResponse(503, "internal_error", "Deployment service is not configured.")
      );
    }
    return handleDeploy(request, env, logger);
  },
};
