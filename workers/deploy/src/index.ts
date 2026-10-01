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
    if (!env.DEPLOY_SESSION_KEY || env.DEPLOY_SESSION_KEY.length < 32) {
      return Promise.resolve(
        Response.json(
          { error: { code: "internal_error", message: "Deployment service is not configured." } },
          { status: 503 }
        )
      );
    }
    return handleDeploy(request, env, logger);
  },
};
