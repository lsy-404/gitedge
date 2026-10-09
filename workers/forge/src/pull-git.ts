import { trustedHeaders, type TrustedUser } from "../../../packages/contracts/src/index";
import { errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import type { ForgeEnv, RepositoryRow } from "./common";

/** Service-binding base URL for requests that do not originate from an inbound request. */
export const INTERNAL_GIT_ORIGIN = "https://git.internal";

/** Pull request head location: an agent session fork, a user fork, or neither for the base repository. */
export interface PullHead {
  sessionId: string | null;
  repositoryId: string | null;
}

export function pullHead(pull: Record<string, unknown>): PullHead {
  return {
    sessionId: pull.head_session_id ? String(pull.head_session_id) : null,
    repositoryId: pull.head_repository_id ? String(pull.head_repository_id) : null,
  };
}

export function setHeadParams(url: URL, head: PullHead | null): void {
  if (head?.sessionId) url.searchParams.set("headSessionId", head.sessionId);
  if (head?.repositoryId) url.searchParams.set("headRepositoryId", head.repositoryId);
}

/** Git comparison of a pull request as `user`; merged pull requests compare their recorded OIDs. */
export function compareRequest(
  requestUrl: string,
  repository: Pick<RepositoryRow, "id">,
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
  setHeadParams(gitUrl, pullHead(pull));
  return new Request(gitUrl, { headers: trustedHeaders(user) });
}

/** Resolves the tip commit of a branch, optionally inside an agent session fork or user fork. */
export async function branchTipOid(
  env: ForgeEnv,
  requestUrl: string,
  repository: RepositoryRow,
  ref: string,
  head: PullHead | null,
  user: TrustedUser
): Promise<string | Response> {
  const gitUrl = new URL(`/repositories/${repository.id}/pull-head`, requestUrl);
  gitUrl.searchParams.set("head", ref);
  setHeadParams(gitUrl, head);
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
    pullHead(pull),
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
