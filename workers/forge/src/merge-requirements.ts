import type {
  ExcludedApproval,
  ExcludedApprovalReason,
  MergeMethod,
  MergeRequirement,
  MergeRequirementId,
} from "../../../packages/contracts/src/index";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import {
  MergeRequirementIds,
  MERGE_REVIEW_LIMIT,
  MERGE_CHECK_LIMIT,
} from "../../../packages/contracts/src/merge-requirements";
import { createLogger } from "../../../src/worker/common/logger";
import { parseActor, type ForgeEnv, type RepositoryRow } from "./common";
import type { MergeBlocker } from "./merge-policy";
import { unresolvedThreadCount } from "./review-comments";

const LISTED_NAMES = 5;

/** A requirement with the blocker direct merge callers receive while it is unsatisfied. */
export interface EvaluatedRequirement extends MergeRequirement {
  readonly blocker: MergeBlocker | null;
}

export interface MergeEvaluation {
  /** Listed in the order the merge gate reports them. */
  readonly requirements: EvaluatedRequirement[];
  readonly excludedApprovals: ExcludedApproval[];
}

export interface MergeEvaluationInput {
  /** Method the caller intends to use; null checks that at least one is enabled. */
  readonly method: MergeMethod | null;
  readonly headOid: string;
}

interface ReviewRow {
  state: string;
  actor_json: string;
  actor_key: string;
  author_id: string;
  member: number;
}

interface CheckRow {
  name: string;
  status: string;
  conclusion: string | null;
  actor_json: string;
}

function met(id: MergeRequirementId, detail: string): EvaluatedRequirement {
  return { id, status: "satisfied", detail, blocker: null };
}

function notApplicable(id: MergeRequirementId, detail: string): EvaluatedRequirement {
  return { id, status: "not_applicable", detail, blocker: null };
}

function atMerge(id: MergeRequirementId, detail: string): EvaluatedRequirement {
  return { id, status: "checked_at_merge", detail, blocker: null };
}

function unmet(
  id: MergeRequirementId,
  detail: string,
  status: number,
  code: string,
  message: string
): EvaluatedRequirement {
  return {
    id,
    status: "unsatisfied",
    detail,
    blockerCode: code,
    blocker: { status, code, message },
  };
}

function historyLimited(
  requirements: EvaluatedRequirement[],
  excludedApprovals: ExcludedApproval[]
): MergeEvaluation {
  for (const id of MergeRequirementIds)
    if (!requirements.some((requirement) => requirement.id === id))
      requirements.push({
        id,
        status: "unavailable",
        detail:
          "The supported history limit was exceeded before this condition could be evaluated.",
        blocker: null,
      });
  return { requirements, excludedApprovals };
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_NAMES).join(", ");
  return names.length > LISTED_NAMES ? `${shown} and ${names.length - LISTED_NAMES} more` : shown;
}

function methodAllowed(repository: RepositoryRow, method: MergeMethod): boolean {
  return method === "merge"
    ? repository.allow_merge_commit !== 0
    : method === "squash"
      ? repository.allow_squash_merge !== 0
      : repository.allow_rebase_merge !== 0;
}

/** Users whose approval is not independent of the pull request's author, keyed by user id. */
async function nonIndependentApprovers(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  headOid: string
): Promise<{
  excluded: Map<string, ExcludedApprovalReason>;
  pusherKnown: boolean;
  truncated: boolean;
}> {
  const excluded = new Map<string, ExcludedApprovalReason>();
  const pullActor = parseActor(pull.actor_json, pull.author_id);
  if (typeof pull.author_id === "string")
    excluded.set(pull.author_id, pullActor.kind === "user" ? "author" : "agent_owner");
  const sessionId = pull.head_session_id ?? pullActor.sessionId;
  if (typeof sessionId === "string") {
    const owner = await env.DB.prepare("SELECT user_id FROM auth_agent_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ user_id: string }>();
    if (owner && !excluded.has(owner.user_id)) excluded.set(owner.user_id, "agent_owner");
  }
  const requesters = await env.DB.prepare(
    "SELECT DISTINCT t.created_by FROM forge_task_links l JOIN forge_tasks t ON t.id = l.task_id WHERE l.target_kind = 'pull_request' AND l.target_id = ? LIMIT 101"
  )
    .bind(pull.id)
    .all<{ created_by: string }>();
  for (const requester of requesters.results)
    if (!excluded.has(requester.created_by)) excluded.set(requester.created_by, "task_requester");
  const pusher = await env.DB.prepare(
    "SELECT pusher_id FROM forge_ref_pushers WHERE repository_id = ? AND session_id = ? AND ref = ? AND oid = ? AND pusher_verified = 1"
  )
    .bind(
      pull.head_repository_id ?? repository.id,
      pull.head_session_id ?? "",
      `refs/heads/${pull.head_ref}`,
      headOid
    )
    .first<{ pusher_id: string }>();
  if (pusher && !excluded.has(pusher.pusher_id)) excluded.set(pusher.pusher_id, "last_pusher");
  return { excluded, pusherKnown: pusher !== null, truncated: requesters.results.length > 100 };
}

/** Evaluates D1 merge requirements at one commit and identifies checks performed by Git. */
export async function evaluateMergeRequirements(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: Record<string, unknown>,
  input: MergeEvaluationInput
): Promise<MergeEvaluation> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });
  const requirements: EvaluatedRequirement[] = [];
  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(pull.base_ref)
  );

  requirements.push(
    repository.archived || repository.pulls_enabled === 0
      ? unmet(
          "repository_open",
          "The repository is archived or has pull requests disabled.",
          409,
          "repository_readonly",
          "Pull requests are unavailable or archived."
        )
      : met("repository_open", "The repository accepts merges.")
  );
  requirements.push(
    pull.state === "open"
      ? met("pull_open", "The pull request is open.")
      : unmet(
          "pull_open",
          "The pull request is closed or merged.",
          409,
          "conflict",
          "Pull request must be open to merge."
        )
  );
  requirements.push(
    pull.draft === 1
      ? unmet(
          "ready_for_review",
          "The pull request is a draft.",
          409,
          "draft",
          "Draft pull requests cannot merge."
        )
      : met("ready_for_review", "The pull request is ready for review.")
  );
  const allowed = input.method
    ? methodAllowed(repository, input.method)
    : (["merge", "squash", "rebase"] as const).some((method) => methodAllowed(repository, method));
  const lockedMessage = "The merge method or target branch is locked.";
  requirements.push(
    allowed
      ? met(
          "merge_method",
          input.method ? `${input.method} is enabled.` : "A merge method is enabled."
        )
      : unmet(
          "merge_method",
          input.method
            ? `${input.method} is disabled for this repository.`
            : "Every merge method is disabled.",
          403,
          "protected_branch",
          lockedMessage
        )
  );
  requirements.push(
    rules.some((rule) => rule.locked)
      ? unmet(
          "branch_unlocked",
          "The target branch is locked.",
          403,
          "protected_branch",
          lockedMessage
        )
      : met("branch_unlocked", "The target branch accepts merges.")
  );

  if (rules.some((rule) => rule.requireConversationResolution)) {
    const unresolved = await unresolvedThreadCount(env, String(pull.id));
    requirements.push(
      unresolved > 0
        ? unmet(
            "conversations_resolved",
            `${unresolved} review conversation${unresolved === 1 ? " is" : "s are"} unresolved.`,
            409,
            "threads_unresolved",
            "All review conversations must be resolved before merging."
          )
        : met("conversations_resolved", "All review conversations are resolved.")
    );
  } else
    requirements.push(notApplicable("conversations_resolved", "Not required by a branch rule."));

  const reviews = await env.DB.prepare(
    "SELECT state,actor_json,actor_key,author_id,(EXISTS(SELECT 1 FROM namespace_memberships m WHERE m.namespace_id=? AND m.user_id=forge_reviews.author_id) OR EXISTS(SELECT 1 FROM repository_collaborators c WHERE c.repository_id=? AND c.user_id=forge_reviews.author_id AND c.role IN ('write','admin'))) AS member FROM forge_reviews WHERE pull_request_id=? AND commit_oid=? ORDER BY created_at DESC,rowid DESC LIMIT 1001"
  )
    .bind(repository.namespace_id, repository.id, pull.id, input.headOid)
    .all<ReviewRow>();
  const required = Math.max(
    repository.required_approvals ?? 0,
    ...rules.map((rule) => rule.requiredApprovals)
  );
  const excludedApprovals: ExcludedApproval[] = [];
  if (reviews.results.length > MERGE_REVIEW_LIMIT) {
    logger.warn("forge:merge-review-limit", { pullRequestId: String(pull.id) });
    const detail = "Review history exceeds the supported merge limit.";
    const exceeded = () => unmet("no_changes_requested", detail, 413, "review_limit", detail);
    requirements.push(exceeded());
    requirements.push({ ...exceeded(), id: "approvals" });
    return historyLimited(requirements, excludedApprovals);
  } else {
    const pullActor = parseActor(pull.actor_json, pull.author_id);
    const independent = rules.some((rule) => rule.requireIndependentApproval);
    const independence = independent
      ? await nonIndependentApprovers(env, repository, pull, input.headOid)
      : null;
    const barred =
      independence?.excluded ??
      new Map<string, ExcludedApprovalReason>(
        pullActor.kind === "user" && typeof pull.author_id === "string"
          ? [[pull.author_id, "author"]]
          : []
      );
    const seen = new Set<string>();
    const changesBy: string[] = [];
    let approvals = 0;
    for (const review of reviews.results) {
      if (seen.has(review.actor_key)) continue;
      seen.add(review.actor_key);
      if (review.member !== 1) continue;
      const reviewer = parseActor(review.actor_json, review.author_id);
      if (review.state === "changes_requested") changesBy.push(reviewer.name);
      if (review.state !== "approved" || reviewer.kind !== "user") continue;
      const reason = barred.get(review.author_id);
      if (reason) excludedApprovals.push({ name: reviewer.name, reason });
      else approvals++;
    }
    requirements.push(
      changesBy.length
        ? unmet(
            "no_changes_requested",
            `Changes requested by ${listNames(changesBy)}.`,
            409,
            "changes_requested",
            "A current review requests changes."
          )
        : met("no_changes_requested", "No current review requests changes.")
    );
    if (required === 0) requirements.push(notApplicable("approvals", "No approvals are required."));
    else {
      const progress = `${approvals} of ${required} required approvals`;
      const skipped = excludedApprovals.length
        ? `; ${excludedApprovals.length} excluded (${listNames(excludedApprovals.map((entry) => `${entry.name}: ${entry.reason}`))})`
        : "";
      const requirement = independence?.truncated
        ? unmet(
            "approvals",
            "Linked task history exceeds the supported limit.",
            413,
            "task_link_limit",
            "Linked task history exceeds the supported limit."
          )
        : independence && !independence.pusherKnown
          ? unmet(
              "approvals",
              "The current head's last pusher cannot be verified.",
              409,
              "independent_approval_unverified",
              "Push a new commit before requesting an independent approval."
            )
          : approvals < required
            ? unmet(
                "approvals",
                `${progress}${skipped}.`,
                409,
                "approvals_required",
                "The current commit needs more human approvals."
              )
            : met("approvals", `${progress}${skipped}.`);
      requirements.push({ ...requirement, actualCount: approvals, requiredCount: required });
    }
  }

  const checks = await env.DB.prepare(
    "SELECT name,status,conclusion,actor_json FROM forge_check_runs WHERE pull_request_id=? AND commit_oid=? LIMIT 101"
  )
    .bind(pull.id, input.headOid)
    .all<CheckRow>();
  const needsPassing =
    repository.require_passing_checks === 1 || rules.some((rule) => rule.requirePassingChecks);
  const named = [...new Set(rules.flatMap((rule) => rule.requiredStatusChecks))];
  if (checks.results.length > MERGE_CHECK_LIMIT) {
    logger.warn("forge:merge-check-limit", { pullRequestId: String(pull.id) });
    const detail = "Check history exceeds the supported merge limit.";
    const exceeded = (id: MergeRequirementId) => unmet(id, detail, 413, "check_limit", detail);
    requirements.push(exceeded("checks_complete"));
    requirements.push(
      needsPassing
        ? exceeded("passing_check")
        : notApplicable("passing_check", "Not required by repository settings or a branch rule.")
    );
    requirements.push(
      named.length
        ? exceeded("required_checks")
        : notApplicable("required_checks", "No named checks are required.")
    );
    return historyLimited(requirements, excludedApprovals);
  } else {
    const failing = checks.results.filter(
      (check) =>
        check.status !== "completed" || !["success", "neutral"].includes(check.conclusion ?? "")
    );
    requirements.push(
      failing.length
        ? unmet(
            "checks_complete",
            `Incomplete or unsuccessful: ${listNames(failing.map((check) => check.name))}.`,
            409,
            "checks_incomplete",
            "Current commit checks are incomplete or unsuccessful."
          )
        : met(
            "checks_complete",
            checks.results.length ? "Every reported check succeeded." : "No checks are reported."
          )
    );
    const pullActor = parseActor(pull.actor_json, pull.author_id);
    const passing = checks.results.filter((check) => {
      if (check.status !== "completed" || check.conclusion !== "success") return false;
      const poster = parseActor(check.actor_json, null);
      return !(poster.kind === pullActor.kind && poster.id === pullActor.id);
    });
    requirements.push(
      !needsPassing
        ? notApplicable("passing_check", "Not required by repository settings or a branch rule.")
        : passing.length
          ? met(
              "passing_check",
              `${passing.length} passing check${passing.length === 1 ? "" : "s"}.`
            )
          : unmet(
              "passing_check",
              "No passing check from someone other than the pull request author.",
              409,
              "checks_required",
              "The current commit needs a passing check."
            )
    );
    const missing = named.filter((name) => !passing.some((check) => check.name === name));
    requirements.push(
      !named.length
        ? notApplicable("required_checks", "No named checks are required.")
        : missing.length
          ? unmet(
              "required_checks",
              `Missing or unsuccessful: ${listNames(missing)}.`,
              409,
              "required_checks_missing",
              "A required named check is missing or unsuccessful."
            )
          : met("required_checks", "Every required named check passed.")
    );
  }

  requirements.push(
    rules.some((rule) => rule.requireMergeQueue)
      ? atMerge("merge_queue", "The merge must run through the branch queue.")
      : notApplicable("merge_queue", "A merge queue is not required.")
  );
  requirements.push(
    atMerge("current_head", "Git verifies both expected refs before updating the base.")
  );
  requirements.push(
    rules.some((rule) => rule.requireLinearHistory)
      ? atMerge("linear_history", "Git verifies the history stays linear when merging.")
      : notApplicable("linear_history", "Not required by a branch rule.")
  );
  requirements.push(
    rules.some((rule) => rule.requireSignedCommits)
      ? atMerge("signed_commits", "Git verifies commit signatures when merging.")
      : notApplicable("signed_commits", "Not required by a branch rule.")
  );
  requirements.push(atMerge("no_conflicts", "Git detects conflicts when merging."));
  return { requirements, excludedApprovals };
}

export function firstBlocker(evaluation: MergeEvaluation): MergeBlocker | null {
  return (
    evaluation.requirements.find((requirement) => requirement.status === "unsatisfied")?.blocker ??
    null
  );
}

export function unmetRequirementIds(evaluation: MergeEvaluation): MergeRequirementId[] {
  return evaluation.requirements
    .filter((requirement) => requirement.status === "unsatisfied")
    .map((requirement) => requirement.id);
}
