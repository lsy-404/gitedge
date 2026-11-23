import { createLogger } from "../../../src/worker/common/logger";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";

export interface RunnerKitEnv {
  LOG_LEVEL?: string;
  SIGNING_ARTIFACTS?: R2Bucket;
  RUNNER_KIT_DIGEST?: string;
}

export interface RunnerKit {
  digest: string;
  size: number;
}

const digestPattern = /^sha256:([a-f0-9]{64})$/;
const objectKey = (hex: string): string => `runner-kit/${hex}`;

export async function currentRunnerKit(env: RunnerKitEnv): Promise<RunnerKit | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "runner-dispatch" });
  const digest = env.RUNNER_KIT_DIGEST;
  const hex = digest ? digestPattern.exec(digest)?.[1] : undefined;
  if (!digest || !hex || !env.SIGNING_ARTIFACTS) {
    logger.warn("runner-kit:not-configured");
    return null;
  }
  const head = await env.SIGNING_ARTIFACTS.head(objectKey(hex));
  if (!head) {
    logger.warn("runner-kit:object-missing", { digest });
    return null;
  }
  return { digest, size: head.size };
}

export async function serveCurrentRunnerKit(env: RunnerKitEnv): Promise<Response> {
  const kit = await currentRunnerKit(env);
  return kit ? dataResponse(kit) : errorResponse(404, "not_found", "No runner kit is published.");
}

// Any published kit stays downloadable: VM guests fetch the kit their host runs, which may predate the current one.
export async function serveRunnerKit(env: RunnerKitEnv, hex: string): Promise<Response> {
  const object = env.SIGNING_ARTIFACTS ? await env.SIGNING_ARTIFACTS.get(objectKey(hex)) : null;
  if (!object) return errorResponse(404, "not_found", "The runner kit is not published.");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
    },
  });
}
