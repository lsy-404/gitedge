import {
  actorForUser,
  trustedHeaders,
  type MergeMethod,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { createLogger } from "../../../src/worker/common/logger";
import { pullRequestEvent } from "./agent-events";
import type { ForgeEnv, RepositoryRow } from "./common";
import { comparisonMessages, mergeClosingStatements } from "./issue-links";
import { authorizeMerge, type MergeBlocker } from "./merge-policy";
import { outcomeNotificationStatement } from "./notifications";
import { compareRequest, gitFailureCode, gitFailureMessage, mergeResultOid } from "./pull-git";
import { mergeBindingStatements, mergeCompletionStatements, type MergedPullRequest } from "./tasks";
import { pullRequestWebhook, queueWebhookEvent } from "./webhook-events";

const MERGE_LEASE_MS = 300_000;

export type MergeTrigger = "manual" | "auto_merge" | "queue";

export interface MergeAttempt {
  readonly env: ForgeEnv;
  readonly repository: RepositoryRow;
  /** Identity the merge commit, notifications and audit event are attributed to. */
  readonly user: TrustedUser;
  /** A pull request row joined with its author's `author` identifier. */
  readonly pull: Record<string, unknown>;
  readonly requestUrl: string;
  readonly trigger: MergeTrigger;
}

export interface MergeInput {
  readonly method: MergeMethod;
  readonly expectedBaseOid: string;
  readonly expectedHeadOid: string;
}

export type MergeOutcome =
  | { readonly ok: true; readonly oid: string }
  | { readonly ok: false; readonly blocker: MergeBlocker };

export function hasActiveMergeLease(resource: Record<string, unknown>): boolean {
  return (
    typeof resource.merge_started_at === "number" &&
    resource.merge_started_at >= Date.now() - MERGE_LEASE_MS
  );
}

export function mergeMethodAllowed(repository: RepositoryRow, method: MergeMethod): boolean {
  return method === "merge"
    ? repository.allow_merge_commit !== 0
    : method === "squash"
      ? repository.allow_squash_merge !== 0
      : repository.allow_rebase_merge !== 0;
}

function failed(status: number, code: string, message: string): MergeOutcome {
  return { ok: false, blocker: { status, code, message } };
}

export const PULL_WITH_AUTHOR_SQL =
  "SELECT pull.*, users.identifier AS author FROM forge_pull_requests AS pull JOIN users ON users.id = pull.author_id";

/** Merges one pull request through Git under a lease; the queue is the only way into queue-protected branches. */
export async function executeMerge(
  attempt: MergeAttempt,
  input: MergeInput
): Promise<MergeOutcome> {
  const { env, repository, user, pull: current, requestUrl, trigger } = attempt;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge" });
  const number = Number(current.number);
  const actor = actorForUser(user);
  if (current.state !== "open" || current.draft)
    return failed(409, "conflict", "Pull request must be open and ready to merge.");

  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(current.base_ref)
  );
  if (rules.some((rule) => rule.locked))
    return failed(403, "protected_branch", "The base branch is locked.");
  if (trigger !== "queue" && rules.some((rule) => rule.requireMergeQueue))
    return failed(
      409,
      "merge_queue_required",
      "This branch requires pull requests to merge through the merge queue."
    );
  if (!mergeMethodAllowed(repository, input.method))
    return failed(403, "merge_method_disabled", "This merge method is disabled.");

  const leaseAt = Date.now();
  const lease = await env.DB.prepare(
    "UPDATE forge_pull_requests SET merge_started_at = ?, merge_base_oid = ?, merge_head_oid = ? WHERE id = ? AND state = 'open' AND draft = 0 AND (merge_started_at IS NULL OR merge_started_at < ?) RETURNING id"
  )
    .bind(
      leaseAt,
      input.expectedBaseOid,
      input.expectedHeadOid,
      current.id,
      leaseAt - MERGE_LEASE_MS
    )
    .first<{ id: string }>();
  if (!lease) return failed(409, "conflict", "Another merge is in progress for this pull request.");
  const releaseLease = async (): Promise<void> => {
    await env.DB.prepare(
      "UPDATE forge_pull_requests SET merge_started_at = NULL, merge_base_oid = NULL, merge_head_oid = NULL WHERE id = ? AND merge_started_at = ?"
    )
      .bind(current.id, leaseAt)
      .run();
  };

  const rejected = await authorizeMerge(env, repository, user, current, input);
  if (rejected) {
    await releaseLease();
    return { ok: false, blocker: rejected };
  }
  let commitMessages: string[] = [];
  // Only merges into the default branch close issues, so other targets skip the comparison.
  if (current.base_ref === (repository.default_branch ?? "main")) {
    const comparison = await env.GIT.fetch(
      compareRequest(requestUrl, repository, current, user, {
        base: input.expectedBaseOid,
        head: input.expectedHeadOid,
      })
    );
    if (comparison.ok)
      commitMessages = comparisonMessages(await comparison.json().catch(() => null));
    else {
      await comparison.body?.cancel();
      logger.warn("forge:merge-commit-messages-unavailable", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        status: comparison.status,
      });
    }
  }
  const gitUrl = new URL(`/repositories/${repository.id}/merge`, requestUrl);
  const headSessionId = current.head_session_id == null ? null : String(current.head_session_id);
  const headRepositoryId =
    current.head_repository_id == null ? null : String(current.head_repository_id);
  const gitHeaders = trustedHeaders(user);
  gitHeaders.set("Content-Type", "application/json");
  const gitResponse = await env.GIT.fetch(
    new Request(gitUrl, {
      method: "POST",
      headers: gitHeaders,
      body: JSON.stringify({
        pullRequestId: String(current.id),
        leaseAt,
        method: input.method,
        baseRef: current.base_ref,
        headRef: current.head_ref,
        headSessionId,
        headRepositoryId,
        expectedBaseOid: input.expectedBaseOid,
        expectedHeadOid: input.expectedHeadOid,
        author: { name: user.identifier, email: `${user.identifier}@users.gitedge.invalid` },
        message: `${current.title}`,
      }),
    })
  );
  const payload: unknown = await gitResponse.json().catch(() => null);
  const oid = mergeResultOid(payload);
  if (!gitResponse.ok || !oid) {
    await releaseLease();
    logger.warn("forge:pull-request-git-merge-failed", {
      repositoryId: repository.id,
      pullRequestNumber: number,
      status: gitResponse.status,
      trigger,
    });
    return {
      ok: false,
      blocker: {
        status: gitResponse.status === 409 ? 409 : 502,
        code: "conflict",
        message: gitFailureMessage(payload),
        cause: gitFailureCode(payload) ?? undefined,
      },
    };
  }
  const now = Date.now();
  const mergeApplied = {
    sql: "EXISTS (SELECT 1 FROM forge_pull_requests WHERE id = ? AND state = 'merged' AND merged_oid = ? AND updated_at = ?)",
    binds: [current.id, oid, now],
  };
  const mergedPull: MergedPullRequest = {
    repositoryId: repository.id,
    pullRequestId: String(current.id),
    number,
    oid,
    baseRef: String(current.base_ref),
    summary: String(current.title),
    author: user.identifier,
    actor,
    now,
  };
  // Task binding, task completion and the progress entries share the batch with the merge record; statements after the merge update depend on its change count.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE forge_pull_requests SET state = 'merged', merged_oid = ?, updated_at = ?, merge_started_at = NULL WHERE id = ? AND state = 'open' AND merge_started_at = ? AND merge_base_oid = ? AND merge_head_oid = ?"
    ).bind(oid, now, current.id, leaseAt, input.expectedBaseOid, input.expectedHeadOid),
    ...mergeBindingStatements(env, mergedPull),
    ...mergeCompletionStatements(env, mergedPull, repository.default_branch ?? "main"),
    outcomeNotificationStatement(
      env.DB,
      repository,
      user.id,
      { kind: "pull_request", id: String(current.id), number },
      "merged",
      "participants",
      mergeApplied
    ),
    queueWebhookEvent(
      env.DB,
      repository.id,
      pullRequestWebhook(repository, user, "closed", {
        number,
        title: String(current.title),
        body: String(current.body),
        state: "merged",
        author: String(current.author),
        baseRef: String(current.base_ref),
        headRef: String(current.head_ref),
        draft: false,
        merged: true,
        mergedOid: oid,
      }),
      mergeApplied
    ),
    ...mergeClosingStatements(
      env,
      repository,
      {
        id: String(current.id),
        baseRef: String(current.base_ref),
        title: String(current.title),
        body: String(current.body),
        mergedOid: oid,
      },
      commitMessages,
      actor,
      now
    ),
    env.DB.prepare("DELETE FROM forge_auto_merges WHERE pull_request_id = ?").bind(current.id),
  ]);
  const merged = await env.DB.prepare(
    "SELECT state, merged_oid FROM forge_pull_requests WHERE id = ?"
  )
    .bind(current.id)
    .first<{ state: string; merged_oid: string | null }>();
  if (merged?.state !== "merged" || !merged.merged_oid)
    return failed(409, "conflict", "Pull request state changed after Git merge.");

  await pullRequestEvent(env, repository, user, String(current.id), {
    number,
    state: "merged",
    oid,
  });
  await recordAudit(env, {
    action: "pull_request.merged",
    actor: auditActor(user),
    target: { type: "pull_request", id: String(current.id), label: `#${number}` },
    repositoryId: repository.id,
    namespaceId: repository.namespace_id,
    metadata: {
      number,
      oid,
      method: input.method,
      baseRef: String(current.base_ref),
      headRef: String(current.head_ref),
      trigger,
    },
  });
  if (
    repository.delete_branch_on_merge === 1 &&
    !headSessionId &&
    !headRepositoryId &&
    current.head_ref !== repository.default_branch &&
    current.head_ref !== current.base_ref
  ) {
    const deletion = await env.GIT.fetch(
      new Request(new URL(`/repositories/${repository.id}/branches`, requestUrl), {
        method: "DELETE",
        headers: gitHeaders,
        body: JSON.stringify({
          name: current.head_ref,
          expectedOid: input.expectedHeadOid,
        }),
      })
    );
    if (!deletion.ok)
      logger.warn("forge:merged-branch-cleanup-skipped", {
        repositoryId: repository.id,
        pullRequestNumber: number,
        status: deletion.status,
      });
    await deletion.body?.cancel();
  }
  logger.info("forge:pull-request-merged", {
    repositoryId: repository.id,
    pullRequestNumber: number,
    mergedOid: merged.merged_oid,
    trigger,
  });
  return { ok: true, oid };
}
