import type { MergeMethod, TrustedUser } from "../../../packages/contracts/src/index";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { parseActor, type ForgeEnv, type RepositoryRow } from "./common";
import { errorResponse } from "../../../src/worker/common/http";
import { unresolvedThreadCount } from "./review-comments";

export interface MergePolicyInput {
  method: MergeMethod;
  expectedHeadOid: string;
}
/** A reason a pull request cannot merge yet, with the HTTP status direct callers report. */
export interface MergeBlocker {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Machine-readable reason reported by Git when the merge itself failed. */
  readonly cause?: string;
}
export function blockerResponse(blocker: MergeBlocker): Response {
  return errorResponse(blocker.status, blocker.code, blocker.message);
}
function blocked(status: number, code: string, message: string): MergeBlocker {
  return { status, code, message };
}
export async function authorizeMerge(
  env: ForgeEnv,
  repository: RepositoryRow,
  user: TrustedUser,
  pull: Record<string, unknown>,
  input: MergePolicyInput
): Promise<MergeBlocker | null> {
  if (user.agentSession || !writableRole(await repositoryRole(env.DB, repository.id, user.id)))
    return blocked(403, "forbidden", "Only a human repository member may merge.");
  if (repository.archived || repository.pulls_enabled === 0)
    return blocked(409, "repository_readonly", "Pull requests are unavailable or archived.");
  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(pull.base_ref)
  );
  const allowed =
    input.method === "merge"
      ? repository.allow_merge_commit !== 0
      : input.method === "squash"
        ? repository.allow_squash_merge !== 0
        : repository.allow_rebase_merge !== 0;
  if (!allowed || rules.some((rule) => rule.locked))
    return blocked(403, "protected_branch", "The merge method or target branch is locked.");
  if (
    rules.some((rule) => rule.requireConversationResolution) &&
    (await unresolvedThreadCount(env, String(pull.id))) > 0
  )
    return blocked(
      409,
      "threads_unresolved",
      "All review conversations must be resolved before merging."
    );
  const reviews = await env.DB.prepare(
    "SELECT state,actor_json,actor_key,author_id,(EXISTS(SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=? AND m.user_id=forge_reviews.author_id) OR EXISTS(SELECT 1 FROM repository_collaborators c WHERE c.repository_id=? AND c.user_id=forge_reviews.author_id AND c.role IN ('write','admin'))) AS member FROM forge_reviews WHERE pull_request_id=? AND commit_oid=? ORDER BY created_at DESC,rowid DESC LIMIT 1001"
  )
    .bind(repository.namespace_id, repository.id, pull.id, input.expectedHeadOid)
    .all<{
      state: string;
      actor_json: string;
      actor_key: string;
      author_id: string;
      member: number;
    }>();
  if (reviews.results.length > 1000)
    return blocked(413, "review_limit", "Review history exceeds the supported merge limit.");
  const seen = new Set<string>();
  let approvals = 0;
  const pullActor = parseActor(pull.actor_json, pull.author_id);
  for (const review of reviews.results) {
    if (seen.has(review.actor_key)) continue;
    seen.add(review.actor_key);
    if (review.member !== 1) continue;
    if (review.state === "changes_requested")
      return blocked(409, "changes_requested", "A current review requests changes.");
    if (
      review.state === "approved" &&
      parseActor(review.actor_json, review.author_id).kind === "user" &&
      !(pullActor.kind === "user" && review.author_id === pull.author_id)
    )
      approvals++;
  }
  if (
    approvals <
    Math.max(repository.required_approvals ?? 0, ...rules.map((rule) => rule.requiredApprovals))
  )
    return blocked(409, "approvals_required", "The current commit needs more human approvals.");
  const checks = await env.DB.prepare(
    "SELECT name,status,conclusion,actor_json FROM forge_check_runs WHERE pull_request_id=? AND commit_oid=? LIMIT 101"
  )
    .bind(pull.id, input.expectedHeadOid)
    .all<{ name: string; status: string; conclusion: string | null; actor_json: string }>();
  if (checks.results.length > 100)
    return blocked(413, "check_limit", "Check history exceeds the supported merge limit.");
  if (
    checks.results.some(
      (check) =>
        check.status !== "completed" || !["success", "neutral"].includes(check.conclusion ?? "")
    )
  )
    return blocked(
      409,
      "checks_incomplete",
      "Current commit checks are incomplete or unsuccessful."
    );
  const passing = checks.results.filter((check) => {
    if (check.status !== "completed" || check.conclusion !== "success") return false;
    const poster = parseActor(check.actor_json, null);
    return !(poster.kind === pullActor.kind && poster.id === pullActor.id);
  });
  if (
    (repository.require_passing_checks === 1 || rules.some((rule) => rule.requirePassingChecks)) &&
    !passing.length
  )
    return blocked(409, "checks_required", "The current commit needs a passing check.");
  if (
    rules
      .flatMap((rule) => rule.requiredStatusChecks)
      .some((name) => !passing.some((check) => check.name === name))
  )
    return blocked(
      409,
      "required_checks_missing",
      "A required named check is missing or unsuccessful."
    );
  return null;
}
