import {
  type AutoMergeDisabledReason,
  type MergeMethod,
  type PushEventInput,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { type AuditActor, recordAudit } from "../../../src/worker/common/audit";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import { repositoryById, type ForgeEnv, type RepositoryRow } from "./common";
import {
  executeMerge,
  hasActiveMergeLease,
  mergeMethodAllowed,
  PULL_WITH_AUTHOR_SQL,
} from "./merge-execution";
import { authorizeMerge, type MergeBlocker } from "./merge-policy";
import type { QueueEntry } from "./merge-queue";
import { automationNotificationStatement } from "./notifications";
import { branchTipOid, INTERNAL_GIT_ORIGIN, pullRequestHeadOid } from "./pull-git";
import { pullRequestWebhook, queueWebhookEvent } from "./webhook-events";

/** Merges one pass may run: each loads the repository into memory, so passes stay small. */
const REPOSITORY_PASS_MERGES = 2;
const SWEEP_MERGES = 2;
const SWEEP_AUTO_MERGES = 10;
const SWEEP_QUEUES = 5;
const REPOSITORY_AUTO_MERGES = 5;
const REPOSITORY_QUEUES = 5;

const SYSTEM_ACTOR: AuditActor = { kind: "system", id: null, name: "merge-automation", ref: null };
const AUTOMATION_SENDER = { id: "merge-automation", identifier: "merge-automation" } as const;
/** Git failures that cannot succeed on retry because the proposal itself no longer merges. */
const TERMINAL_MERGE_CAUSES = new Set([
  "merge_conflict",
  "nonlinear_history",
  "unsigned_commits",
  "commit_limit",
  "already_merged",
]);

export interface AutomationBudget {
  merges: number;
}

export interface AutoMergeRow {
  pull_request_id: string;
  repository_id: string;
  enabled_by: string;
  method: MergeMethod;
  expected_head_oid: string;
  enabled_at: number;
}

export type AutoMergeOutcome = "gone" | "disabled" | "waiting" | "queued" | "merged" | "deferred";

type PullRow = Record<string, unknown>;
type ActingUser = Pick<TrustedUser, "id" | "identifier" | "groupKey">;

export function mergeQueueStub(env: ForgeEnv, repositoryId: string, baseRef: string) {
  return env.MERGE_QUEUE.get(env.MERGE_QUEUE.idFromName(`${repositoryId}:${baseRef}`));
}

/** The user an automated merge runs as; null when the account is gone or disabled. */
export async function actingUser(env: ForgeEnv, userId: string): Promise<ActingUser | null> {
  return env.DB.prepare(
    "SELECT id, identifier, group_key AS groupKey FROM users WHERE id = ? AND disabled_at IS NULL"
  )
    .bind(userId)
    .first<ActingUser>();
}

export async function loadPull(env: ForgeEnv, pullRequestId: string): Promise<PullRow | null> {
  return env.DB.prepare(`${PULL_WITH_AUTHOR_SQL} WHERE pull.id = ?`)
    .bind(pullRequestId)
    .first<PullRow>();
}

function webhookFields(pull: PullRow) {
  return {
    number: Number(pull.number),
    title: String(pull.title),
    body: String(pull.body),
    state: String(pull.state),
    author: String(pull.author),
    baseRef: String(pull.base_ref),
    headRef: String(pull.head_ref),
    draft: pull.draft === 1,
    merged: pull.state === "merged",
    mergedOid: typeof pull.merged_oid === "string" ? pull.merged_oid : null,
  };
}

/** Whether the branch queue may hold entries; unregistered queues are never read, so no Durable Object is created for them. */
export async function queueRegistered(
  env: ForgeEnv,
  repositoryId: string,
  baseRef: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS present FROM forge_merge_queues WHERE repository_id = ? AND base_ref = ?"
  )
    .bind(repositoryId, baseRef)
    .first<{ present: number }>();
  return row !== null;
}

export function queueRequired(rules: ReturnType<typeof matchingBranchRules>): boolean {
  return rules.some((rule) => rule.requireMergeQueue);
}

async function baseRules(env: ForgeEnv, repositoryId: string, baseRef: string) {
  return matchingBranchRules(await branchRules(env.DB, repositoryId), baseRef);
}

export async function reportAutoMergeEnabled(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow,
  user: TrustedUser,
  input: { method: MergeMethod; expectedHeadOid: string }
): Promise<void> {
  await queueWebhookEvent(
    env.DB,
    repository.id,
    pullRequestWebhook(repository, user, "auto_merge_enabled", webhookFields(pull), {
      merge_method: input.method,
      expected_head_sha: input.expectedHeadOid,
    })
  ).run();
}

/** Removes the setting and reports it once; concurrent callers see only one winner. */
export async function disableAutoMerge(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow,
  row: AutoMergeRow,
  reason: AutoMergeDisabledReason,
  actor: { id: string; identifier: string } | null
): Promise<boolean> {
  const deleted = await env.DB.prepare(
    "DELETE FROM forge_auto_merges WHERE pull_request_id = ? AND enabled_at = ? RETURNING enabled_by"
  )
    .bind(row.pull_request_id, row.enabled_at)
    .first<{ enabled_by: string }>();
  if (!deleted) return false;
  const number = Number(pull.number);
  const sender = actor ?? AUTOMATION_SENDER;
  await env.DB.batch([
    ...(reason === "manual" && actor?.id === row.enabled_by
      ? []
      : [
          automationNotificationStatement(
            env.DB,
            repository,
            { kind: "pull_request", id: String(pull.id), number },
            "auto_merge_disabled",
            [row.enabled_by]
          ),
        ]),
    queueWebhookEvent(
      env.DB,
      repository.id,
      pullRequestWebhook(repository, sender, "auto_merge_disabled", webhookFields(pull), { reason })
    ),
  ]);
  await recordAudit(env, {
    action: "pull_request.auto_merge_disabled",
    actor: actor ? { kind: "user", id: actor.id, name: actor.identifier, ref: null } : SYSTEM_ACTOR,
    target: { type: "pull_request", id: String(pull.id), label: `#${number}` },
    repositoryId: repository.id,
    namespaceId: repository.namespace_id,
    metadata: { number, reason },
  });
  createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id }).info(
    "forge:auto-merge-disabled",
    { pullRequestNumber: number, reason }
  );
  return true;
}

export type EnqueueOutcome =
  { status: "queued"; position: number; created: boolean } | { status: "full" };

/** Adds the pull request to its branch queue and registers the queue for sweeping. */
export async function enqueueForMerge(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow,
  user: ActingUser,
  input: { method: MergeMethod; expectedHeadOid: string }
): Promise<EnqueueOutcome> {
  const baseRef = String(pull.base_ref);
  const register = env.DB.prepare(
    "INSERT OR IGNORE INTO forge_merge_queues (repository_id, base_ref, checked_at) VALUES (?, ?, 0)"
  ).bind(repository.id, baseRef);
  // Registering before the enqueue keeps a crash from hiding entries; the second insert covers a processor that unregistered the queue in between.
  await register.run();
  const result = await mergeQueueStub(env, repository.id, baseRef).enqueue({
    pullRequestId: String(pull.id),
    pullRequestNumber: Number(pull.number),
    userId: user.id,
    method: input.method,
    expectedHeadOid: input.expectedHeadOid,
  });
  if (result.status === "full") return result;
  await register.run();
  if (result.created) {
    await queueWebhookEvent(
      env.DB,
      repository.id,
      pullRequestWebhook(repository, user, "enqueued", webhookFields(pull), {
        position: result.position,
      })
    ).run();
    await recordAudit(env, {
      action: "pull_request.queued",
      actor: { kind: "user", id: user.id, name: user.identifier, ref: null },
      target: { type: "pull_request", id: String(pull.id), label: `#${pull.number}` },
      repositoryId: repository.id,
      namespaceId: repository.namespace_id,
      metadata: { number: Number(pull.number), baseRef, method: input.method },
    });
  }
  return result;
}

/** Records that a pull request left the queue without merging. */
export async function reportDequeued(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow,
  entryUserId: string,
  reason: string,
  message: string,
  actor: { id: string; identifier: string } | null
): Promise<void> {
  const number = Number(pull.number);
  const system = actor === null;
  await env.DB.batch([
    ...(system
      ? [
          automationNotificationStatement(
            env.DB,
            repository,
            { kind: "pull_request", id: String(pull.id), number },
            "queue_ejected",
            [entryUserId, String(pull.author_id)]
          ),
        ]
      : []),
    queueWebhookEvent(
      env.DB,
      repository.id,
      pullRequestWebhook(repository, actor ?? AUTOMATION_SENDER, "dequeued", webhookFields(pull), {
        reason,
        message,
      })
    ),
  ]);
  await recordAudit(env, {
    action: "pull_request.dequeued",
    actor: actor ? { kind: "user", id: actor.id, name: actor.identifier, ref: null } : SYSTEM_ACTOR,
    target: { type: "pull_request", id: String(pull.id), label: `#${number}` },
    repositoryId: repository.id,
    namespaceId: repository.namespace_id,
    metadata: { number, reason },
  });
}

async function dropAutoMerge(env: ForgeEnv, pullRequestId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM forge_auto_merges WHERE pull_request_id = ?")
    .bind(pullRequestId)
    .run();
}

/** Applies the auto-merge policy once: disables, queues, merges or leaves the pull request waiting. */
export async function evaluateAutoMerge(
  env: ForgeEnv,
  row: AutoMergeRow,
  budget: AutomationBudget
): Promise<AutoMergeOutcome> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: row.repository_id });
  const repository = await repositoryById(env, row.repository_id);
  const pull = repository ? await loadPull(env, row.pull_request_id) : null;
  if (!repository || !pull || pull.state !== "open") {
    await dropAutoMerge(env, row.pull_request_id);
    return "gone";
  }
  const user = await actingUser(env, row.enabled_by);
  if (!user || !writableRole(await repositoryRole(env.DB, repository.id, user.id))) {
    await disableAutoMerge(env, repository, pull, row, "permission_lost", null);
    return "disabled";
  }
  if (pull.draft === 1 || hasActiveMergeLease(pull)) return "waiting";
  if (!mergeMethodAllowed(repository, row.method)) {
    await disableAutoMerge(env, repository, pull, row, "method_disabled", null);
    return "disabled";
  }
  const head = await pullRequestHeadOid(env, INTERNAL_GIT_ORIGIN, repository, pull, user);
  if (head instanceof Response) {
    const missing = head.status === 409;
    await head.body?.cancel();
    if (missing) {
      await disableAutoMerge(env, repository, pull, row, "head_changed", null);
      return "disabled";
    }
    logger.warn("forge:auto-merge-head-unavailable", { pullRequestId: row.pull_request_id });
    return "waiting";
  }
  if (head !== row.expected_head_oid) {
    await disableAutoMerge(env, repository, pull, row, "head_changed", null);
    return "disabled";
  }
  const blocker = await authorizeMerge(env, repository, user, pull, {
    method: row.method,
    expectedHeadOid: head,
  });
  if (blocker) return "waiting";

  if (queueRequired(await baseRules(env, repository.id, String(pull.base_ref)))) {
    const queued = await enqueueForMerge(env, repository, pull, user, {
      method: row.method,
      expectedHeadOid: head,
    });
    if (queued.status === "full") return "waiting";
    await dropAutoMerge(env, row.pull_request_id);
    return "queued";
  }
  if (budget.merges <= 0) return "deferred";
  budget.merges--;
  const base = await branchTipOid(
    env,
    INTERNAL_GIT_ORIGIN,
    repository,
    String(pull.base_ref),
    null,
    user
  );
  if (base instanceof Response) {
    await base.body?.cancel();
    return "waiting";
  }
  const outcome = await executeMerge(
    {
      env,
      repository,
      user,
      pull,
      requestUrl: INTERNAL_GIT_ORIGIN,
      trigger: "auto_merge",
    },
    { method: row.method, expectedBaseOid: base, expectedHeadOid: head }
  );
  if (outcome.ok) return "merged";
  if (outcome.blocker.cause && TERMINAL_MERGE_CAUSES.has(outcome.blocker.cause)) {
    await disableAutoMerge(env, repository, pull, row, "merge_failed", null);
    return "disabled";
  }
  logger.info("forge:auto-merge-waiting", {
    pullRequestId: row.pull_request_id,
    code: outcome.blocker.code,
    cause: outcome.blocker.cause ?? null,
  });
  return "waiting";
}

function retriable(blocker: MergeBlocker): boolean {
  return (
    blocker.cause === "refs_changed" ||
    blocker.status >= 500 ||
    (blocker.code === "conflict" && !blocker.cause)
  );
}

type EntryResult = "merged" | "ejected" | "retry" | "dropped";

async function runQueueEntry(
  env: ForgeEnv,
  entry: QueueEntry,
  baseRef: string,
  repositoryId: string
): Promise<{ result: EntryResult; reason?: string; message?: string }> {
  const repository = await repositoryById(env, repositoryId);
  const pull = repository ? await loadPull(env, entry.pullRequestId) : null;
  if (!repository || !pull || pull.state !== "open") return { result: "dropped" };
  const eject = (reason: string, message: string) => ({
    result: "ejected" as const,
    reason,
    message,
  });
  const user = await actingUser(env, entry.userId);
  if (!user || !writableRole(await repositoryRole(env.DB, repository.id, user.id)))
    return eject("permission_lost", "The user who queued this pull request can no longer merge.");
  if (pull.draft === 1) return eject("draft", "The pull request was converted to a draft.");
  const head = await pullRequestHeadOid(env, INTERNAL_GIT_ORIGIN, repository, pull, user);
  if (head instanceof Response) {
    const missing = head.status === 409;
    await head.body?.cancel();
    return missing
      ? eject("head_changed", "The pull request head is no longer available.")
      : { result: "retry" };
  }
  if (head !== entry.expectedHeadOid)
    return eject("head_changed", "The pull request head changed after it was queued.");
  const base = await branchTipOid(env, INTERNAL_GIT_ORIGIN, repository, baseRef, null, user);
  if (base instanceof Response) {
    await base.body?.cancel();
    return { result: "retry" };
  }
  const outcome = await executeMerge(
    { env, repository, user, pull, requestUrl: INTERNAL_GIT_ORIGIN, trigger: "queue" },
    { method: entry.method, expectedBaseOid: base, expectedHeadOid: head }
  );
  if (outcome.ok) return { result: "merged" };
  if (retriable(outcome.blocker)) return { result: "retry" };
  return eject(outcome.blocker.cause ?? outcome.blocker.code, outcome.blocker.message);
}

/** Processes the head of one branch queue, sequentially, within the merge budget. */
export async function processMergeQueue(
  env: ForgeEnv,
  repositoryId: string,
  baseRef: string,
  budget: AutomationBudget
): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repositoryId });
  const stub = mergeQueueStub(env, repositoryId, baseRef);
  await env.DB.prepare(
    "UPDATE forge_merge_queues SET checked_at = ? WHERE repository_id = ? AND base_ref = ?"
  )
    .bind(Date.now(), repositoryId, baseRef)
    .run();
  while (budget.merges > 0) {
    const claim = await stub.claim(Date.now());
    if (claim.status === "busy") return;
    if (claim.status === "empty") {
      await env.DB.prepare(
        "DELETE FROM forge_merge_queues WHERE repository_id = ? AND base_ref = ?"
      )
        .bind(repositoryId, baseRef)
        .run();
      // An enqueue may have landed between the claim and the delete.
      if ((await stub.list()).length > 0)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO forge_merge_queues (repository_id, base_ref, checked_at) VALUES (?, ?, 0)"
        )
          .bind(repositoryId, baseRef)
          .run();
      return;
    }
    budget.merges--;
    const { entry, token } = claim;
    let outcome: Awaited<ReturnType<typeof runQueueEntry>>;
    try {
      outcome = await runQueueEntry(env, entry, baseRef, repositoryId);
    } catch (cause) {
      logger.error("forge:merge-queue-entry-failed", {
        pullRequestId: entry.pullRequestId,
        error: cause instanceof Error ? cause.message : "unknown",
      });
      outcome = { result: "retry" };
    }
    if (outcome.result === "retry") {
      const retry = await stub.retry(entry.pullRequestId, token);
      if (retry.status === "requeued" || retry.status === "stale") return;
      outcome = {
        result: "ejected",
        reason: "retries_exhausted",
        message: "The merge could not complete after several attempts.",
      };
    }
    await stub.finish(entry.pullRequestId, token);
    if (outcome.result === "ejected") {
      const repository = await repositoryById(env, repositoryId);
      const pull = repository ? await loadPull(env, entry.pullRequestId) : null;
      if (repository && pull)
        await reportDequeued(
          env,
          repository,
          pull,
          entry.userId,
          outcome.reason ?? "ejected",
          outcome.message ?? "",
          null
        );
      logger.info("forge:merge-queue-ejected", {
        pullRequestNumber: entry.pullRequestNumber,
        reason: outcome.reason ?? null,
      });
    }
  }
}

async function guarded(env: ForgeEnv, scope: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "forge" }).error("forge:merge-automation-failed", {
      scope,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
}

async function runAutoMerges(
  env: ForgeEnv,
  rows: readonly AutoMergeRow[],
  budget: AutomationBudget
): Promise<void> {
  for (const row of rows)
    await guarded(env, "auto-merge", async () => {
      await env.DB.prepare("UPDATE forge_auto_merges SET checked_at = ? WHERE pull_request_id = ?")
        .bind(Date.now(), row.pull_request_id)
        .run();
      await evaluateAutoMerge(env, row, budget);
    });
}

const AUTO_MERGE_COLUMNS =
  "pull_request_id, repository_id, enabled_by, method, expected_head_oid, enabled_at";

/** Re-evaluates the auto-merge settings and merge queues of one repository after a change to it. */
export async function reconcileRepository(
  env: ForgeEnv,
  repositoryId: string,
  budget: AutomationBudget = { merges: REPOSITORY_PASS_MERGES }
): Promise<void> {
  const autoMerges = await env.DB.prepare(
    `SELECT ${AUTO_MERGE_COLUMNS} FROM forge_auto_merges WHERE repository_id = ? ORDER BY checked_at ASC LIMIT ?`
  )
    .bind(repositoryId, REPOSITORY_AUTO_MERGES)
    .all<AutoMergeRow>();
  await runAutoMerges(env, autoMerges.results, budget);
  const queues = await env.DB.prepare(
    "SELECT base_ref FROM forge_merge_queues WHERE repository_id = ? ORDER BY checked_at ASC LIMIT ?"
  )
    .bind(repositoryId, REPOSITORY_QUEUES)
    .all<{ base_ref: string }>();
  for (const queue of queues.results)
    await guarded(env, "merge-queue", () =>
      processMergeQueue(env, repositoryId, queue.base_ref, budget)
    );
}

/** Cron sweep over the least recently checked settings and queues across all repositories; failures are logged, never thrown. */
export async function sweepMergeAutomation(env: ForgeEnv): Promise<void> {
  const budget: AutomationBudget = { merges: SWEEP_MERGES };
  await guarded(env, "auto-merge-sweep", async () => {
    const autoMerges = await env.DB.prepare(
      `SELECT ${AUTO_MERGE_COLUMNS} FROM forge_auto_merges ORDER BY checked_at ASC LIMIT ?`
    )
      .bind(SWEEP_AUTO_MERGES)
      .all<AutoMergeRow>();
    await runAutoMerges(env, autoMerges.results, budget);
  });
  await guarded(env, "merge-queue-sweep", async () => {
    const queues = await env.DB.prepare(
      "SELECT repository_id, base_ref FROM forge_merge_queues ORDER BY checked_at ASC LIMIT ?"
    )
      .bind(SWEEP_QUEUES)
      .all<{ repository_id: string; base_ref: string }>();
    for (const queue of queues.results)
      await guarded(env, "merge-queue", () =>
        processMergeQueue(env, queue.repository_id, queue.base_ref, budget)
      );
  });
}

/** A push by the user who enabled auto-merge moves the approved head along; any other head change is caught on evaluation. */
export async function followEnablerPushes(
  env: ForgeEnv,
  repositoryId: string,
  pusherId: string,
  updates: PushEventInput["updates"]
): Promise<void> {
  const branchUpdates = updates.filter((update) => update.ref.startsWith("refs/heads/"));
  if (!branchUpdates.length) return;
  const enabled = await env.DB.prepare(
    "SELECT 1 AS present FROM forge_auto_merges WHERE repository_id = ? AND enabled_by = ? LIMIT 1"
  )
    .bind(repositoryId, pusherId)
    .first<{ present: number }>();
  if (!enabled) return;
  const statements = branchUpdates.map((update) =>
    env.DB.prepare(
      "UPDATE forge_auto_merges SET expected_head_oid = ? WHERE enabled_by = ? AND expected_head_oid = ? AND pull_request_id IN (SELECT id FROM forge_pull_requests WHERE repository_id = ? AND head_ref = ? AND head_session_id IS NULL AND state = 'open')"
    ).bind(
      update.after,
      pusherId,
      update.before,
      repositoryId,
      update.ref.slice("refs/heads/".length)
    )
  );
  await env.DB.batch(statements);
}
