import { createLogger } from "../../../src/worker/common/logger";
import { errorResponse } from "../../../src/worker/common/http";

export interface SigningRuntimeEnv {
  LOG_LEVEL?: string;
  SIGNING_ARTIFACTS?: R2Bucket;
  SIGNING_RUNTIME_DIGEST?: string;
}

export interface SigningRuntime {
  digest: string;
  size: number;
}

const digestPattern = /^sha256:([a-f0-9]{64})$/;

export async function currentSigningRuntime(
  env: SigningRuntimeEnv
): Promise<SigningRuntime | null> {
  const logger = createLogger(env.LOG_LEVEL, { service: "runner-dispatch" });
  const digest = env.SIGNING_RUNTIME_DIGEST;
  const hex = digest ? digestPattern.exec(digest)?.[1] : undefined;
  if (!digest || !hex || !env.SIGNING_ARTIFACTS) {
    logger.warn("signing-runtime:not-configured");
    return null;
  }
  const head = await env.SIGNING_ARTIFACTS.head(`signing-runtime/${hex}`);
  if (!head) {
    logger.warn("signing-runtime:object-missing", { digest });
    return null;
  }
  return { digest, size: head.size };
}

export async function serveSigningRuntime(env: SigningRuntimeEnv, hex: string): Promise<Response> {
  if (!env.SIGNING_ARTIFACTS || env.SIGNING_RUNTIME_DIGEST !== `sha256:${hex}`)
    return errorResponse(404, "not_found", "The signing runtime is not published.");
  const object = await env.SIGNING_ARTIFACTS.get(`signing-runtime/${hex}`);
  if (!object) return errorResponse(404, "not_found", "The signing runtime is not published.");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
    },
  });
}
