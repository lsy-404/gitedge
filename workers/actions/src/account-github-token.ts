import { z } from "zod";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { readJsonLimited } from "../../../src/worker/common/readText";
import { accountScope } from "./github-quota";
import { storedSourceCredential } from "./signing/services";

export interface AccountGithubTokenEnv {
  DB: D1Database;
  LOG_LEVEL?: string;
  SIGNING_ENCRYPTION_KEY?: string;
}

const InputSchema = z.object({ ownerId: z.string().min(1).max(100) }).strict();

// Service-binding only: returns the account's shared GitHub token to Forge.
export async function accountGithubToken(
  request: Request,
  env: AccountGithubTokenEnv
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).hostname !== "actions.internal")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const input = InputSchema.safeParse(await readJsonLimited(request, 1024));
  if (!input.success) return errorResponse(400, "bad_request", "An owner id is required.");
  if (!env.SIGNING_ENCRYPTION_KEY)
    return errorResponse(503, "github_token_unavailable", "Credential encryption is unavailable.");
  const scope = await accountScope(env.DB, input.data.ownerId);
  const token = scope?.runnerRepositoryId
    ? await storedSourceCredential(
        { DB: env.DB, SIGNING_ENCRYPTION_KEY: env.SIGNING_ENCRYPTION_KEY },
        input.data.ownerId,
        scope.runnerRepositoryId
      )
    : null;
  if (!token) {
    createLogger(env.LOG_LEVEL, { service: "account-github-token" }).warn(
      "account-github-token:missing",
      { ownerId: input.data.ownerId }
    );
    return errorResponse(
      404,
      "github_token_missing",
      "The account GitHub token is not configured."
    );
  }
  return dataResponse({ token });
}
