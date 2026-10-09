import { trustedHeaders, type TrustedUser } from "../../../packages/contracts/src/index";
import { errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import type { ForgeEnv, RepositoryRow } from "./common";

/** Service-binding base URL for requests that do not originate from an inbound request. */
export const INTERNAL_GIT_ORIGIN = "https://git.internal";

export function compareRequest(
  requestUrl: string,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser,
  range?: { base: string; head: string }
): Request {
  const merged = pull.state === "merged";
  const gitUrl = new URL(`/repositories/${repository.id}/compare`, requestUrl);
  gitUrl.searchParams.set(
    "base",
    range?.base ?? String(merged ? pull.merge_base_oid : pull.base_ref)
  );
  gitUrl.searchParams.set(
    "head",
    range?.head ?? String(merged ? pull.merge_head_oid : pull.head_ref)
  );
  if (pull.head_session_id) gitUrl.searchParams.set("headSessionId", String(pull.head_session_id));
  return new Request(gitUrl, { headers: trustedHeaders(user) });
}

/** Resolves the tip commit of a branch, optionally inside an agent session fork. */
export async function branchTipOid(
  env: ForgeEnv,
  requestUrl: string,
  repository: RepositoryRow,
  ref: string,
  sessionId: string | null,
  user: TrustedUser
): Promise<string | Response> {
  const gitUrl = new URL(`/repositories/${repository.id}/pull-head`, requestUrl);
  gitUrl.searchParams.set("head", ref);
  if (sessionId) gitUrl.searchParams.set("headSessionId", sessionId);
  const response = await env.GIT.fetch(new Request(gitUrl, { headers: trustedHeaders(user) }));
  if (response.status === 404) {
    await response.body?.cancel();
    return errorResponse(409, "stale_commit", "The pull request head is no longer available.");
  }
  const body: unknown = response.ok ? await response.json().catch(() => null) : null;
  const data = body && typeof body === "object" && "data" in body ? body.data : null;
  const oid =
    data && typeof data === "object" && "oid" in data && typeof data.oid === "string"
      ? data.oid
      : null;
  if (!oid) {
    createLogger(env.LOG_LEVEL, { service: "forge" }).warn("forge:branch-tip-unresolved", {
      repositoryId: repository.id,
      ref,
      status: response.status,
    });
    if (!response.ok) await response.body?.cancel();
    return errorResponse(502, "git_unavailable", "The pull request head could not be resolved.");
  }
  return oid;
}

export function pullRequestHeadOid(
  env: ForgeEnv,
  requestUrl: string,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  user: TrustedUser
): Promise<string | Response> {
  return branchTipOid(
    env,
    requestUrl,
    repository,
    String(pull.head_ref),
    pull.head_session_id ? String(pull.head_session_id) : null,
    user
  );
}

export function mergeResultOid(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = value.data;
  if (!data || typeof data !== "object" || !("oid" in data) || typeof data.oid !== "string")
    return null;
  return /^[0-9a-f]{40}$/.test(data.oid) ? data.oid : null;
}

export function gitFailureMessage(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    value.error &&
    typeof value.error === "object" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  )
    return value.error.message.slice(0, 500);
  return "Git merge failed.";
}

export function gitFailureCode(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    value.error &&
    typeof value.error === "object" &&
    "code" in value.error &&
    typeof value.error.code === "string"
  )
    return value.error.code;
  return null;
}
