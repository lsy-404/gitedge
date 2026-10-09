import {
  EnableAutoMergeInputSchema,
  GitBranchSchema,
  type AutoMergeStatus,
  type MergeQueueState,
  type PullMergeQueueStatus,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { branchRules, matchingBranchRules } from "../../../src/worker/common/branch-protection";
import { dataResponse, errorResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { canWriteSession, isMember, parseJson, type ForgeEnv, type RepositoryRow } from "./common";
import {
  actingUser,
  disableAutoMerge,
  enqueueForMerge,
  loadPull,
  mergeQueueStub,
  queueRequired,
  reportAutoMergeEnabled,
  reportDequeued,
  type AutoMergeRow,
} from "./merge-automation";
import { hasActiveMergeLease, mergeMethodAllowed, PULL_WITH_AUTHOR_SQL } from "./merge-execution";
import { authorizeMerge, blockerResponse } from "./merge-policy";
import { pullRequestHeadOid } from "./pull-git";

type PullRow = Record<string, unknown>;

const AUTO_MERGE_STATUS_SQL =
  "SELECT a.pull_request_id, a.repository_id, a.enabled_by, a.method, a.expected_head_oid, a.enabled_at, u.identifier AS enabled_by_name FROM forge_auto_merges a JOIN users u ON u.id = a.enabled_by WHERE a.pull_request_id = ?";

async function autoMergeStatus(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow
): Promise<AutoMergeStatus> {
  const row = await env.DB.prepare(AUTO_MERGE_STATUS_SQL)
    .bind(pull.id)
    .first<AutoMergeRow & { enabled_by_name: string }>();
  if (!row)
    return {
      enabled: false,
      method: null,
      enabledBy: null,
      enabledAt: null,
      expectedHeadOid: null,
      waitingOn: null,
    };
  const enabler = await actingUser(env, row.enabled_by);
  const blocker =
    pull.draft === 1
      ? { code: "draft", message: "Draft pull requests cannot merge." }
      : enabler
        ? await authorizeMerge(env, repository, enabler, pull, {
            method: row.method,
            expectedHeadOid: row.expected_head_oid,
          })
        : { code: "forbidden", message: "The user who enabled auto-merge is unavailable." };
  return {
    enabled: true,
    method: row.method,
    enabledBy: row.enabled_by_name,
    enabledAt: row.enabled_at,
    expectedHeadOid: row.expected_head_oid,
    waitingOn: blocker ? { code: blocker.code, message: blocker.message } : null,
  };
}

async function queueStatus(
  env: ForgeEnv,
  repository: RepositoryRow,
  pull: PullRow
): Promise<PullMergeQueueStatus> {
  const required = queueRequired(
    matchingBranchRules(await branchRules(env.DB, repository.id), String(pull.base_ref))
  );
  const entries = await mergeQueueStub(env, repository.id, String(pull.base_ref)).list();
  const index = entries.findIndex((entry) => entry.pullRequestId === pull.id);
  return {
    required,
    position: index < 0 ? null : index + 1,
    length: entries.length,
    processing: index >= 0 && entries[index].processing,
  };
}

async function branchQueue(
  env: ForgeEnv,
  repository: RepositoryRow,
  branch: string
): Promise<MergeQueueState> {
  const entries = await mergeQueueStub(env, repository.id, branch).list();
  const users = entries.length
    ? await env.DB.prepare(
        "SELECT id, identifier FROM users WHERE id IN (SELECT value FROM json_each(?))"
      )
        .bind(JSON.stringify([...new Set(entries.map((entry) => entry.userId))]))
        .all<{ id: string; identifier: string }>()
    : { results: [] };
  const names = new Map(users.results.map((row) => [row.id, row.identifier]));
  return {
    baseRef: branch,
    entries: entries.map((entry) => ({
      pullRequestNumber: entry.pullRequestNumber,
      method: entry.method,
      enqueuedBy: names.get(entry.userId) ?? "",
      enqueuedAt: entry.enqueuedAt,
      processing: entry.processing,
    })),
  };
}

/** Auto-merge and merge-queue endpoints of one repository; null when the path is not theirs. */
export async function mergeAutomationRoutes(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: string[]
): Promise<Response | null> {
  const [, , resource, item, action] = parts;
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });
  if (resource === "merge-queue" && parts.length === 3) {
    if (request.method !== "GET")
      return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
    const branch = GitBranchSchema.safeParse(
      new URL(request.url).searchParams.get("branch") ?? repository.default_branch ?? "main"
    );
    if (!branch.success) return errorResponse(400, "bad_request", "Invalid branch name.");
    return dataResponse(await branchQueue(env, repository, branch.data));
  }
  if (resource !== "pull-requests" || (action !== "auto-merge" && action !== "merge-queue"))
    return null;
  if (parts.length !== 5) return null;
  if (repository.pulls_enabled === 0)
    return errorResponse(404, "feature_disabled", "Repository pull requests are disabled.");
  const number = Number(item);
  if (!Number.isSafeInteger(number) || number < 1)
    return errorResponse(404, "not_found", "Resource was not found.");
  const pull = await env.DB.prepare(
    `${PULL_WITH_AUTHOR_SQL} WHERE pull.repository_id = ? AND pull.number = ?`
  )
    .bind(repository.id, number)
    .first<PullRow>();
  if (!pull) return errorResponse(404, "not_found", "Resource was not found.");

  if (request.method === "GET")
    return dataResponse(
      action === "auto-merge"
        ? await autoMergeStatus(env, repository, pull)
        : await queueStatus(env, repository, pull)
    );
  if (request.method !== "PUT" && request.method !== "POST" && request.method !== "DELETE")
    return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  if (repository.archived === 1)
    return errorResponse(409, "repository_archived", "Archived repositories are read-only.");
  if (
    user.agentSession ||
    !canWriteSession(user, repository.id) ||
    !(await isMember(env, repository.id, user.id))
  )
    return errorResponse(403, "forbidden", "Only a human repository member may change merging.");

  const stored = await loadPull(env, String(pull.id));
  if (!stored) return errorResponse(404, "not_found", "Resource was not found.");
  const sender = { id: user.id, identifier: user.identifier };

  if (request.method === "DELETE") {
    if (action === "auto-merge") {
      const row = await env.DB.prepare(AUTO_MERGE_STATUS_SQL).bind(pull.id).first<AutoMergeRow>();
      if (row) {
        await disableAutoMerge(env, repository, stored, row, "manual", sender);
        logger.info("forge:auto-merge-removed", { pullRequestNumber: number });
      }
      return dataResponse(await autoMergeStatus(env, repository, stored));
    }
    const queue = mergeQueueStub(env, repository.id, String(pull.base_ref));
    const entry = (await queue.list()).find((candidate) => candidate.pullRequestId === pull.id);
    const removal = await queue.remove(String(pull.id));
    if (removal.status === "busy")
      return errorResponse(409, "conflict", "The pull request is being merged right now.");
    if (removal.status === "removed" && entry)
      await reportDequeued(env, repository, stored, entry.userId, "removed", "", sender);
    return dataResponse(await queueStatus(env, repository, stored));
  }

  const parsed = EnableAutoMergeInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid merge settings.");
  if (stored.state !== "open" || stored.draft === 1 || hasActiveMergeLease(stored))
    return errorResponse(409, "conflict", "Pull request must be open and ready to merge.");
  const rules = matchingBranchRules(
    await branchRules(env.DB, repository.id),
    String(stored.base_ref)
  );
  if (rules.some((rule) => rule.locked))
    return errorResponse(403, "protected_branch", "The base branch is locked.");
  if (!mergeMethodAllowed(repository, parsed.data.method))
    return errorResponse(403, "merge_method_disabled", "This merge method is disabled.");
  const head = await pullRequestHeadOid(env, request.url, repository, stored, user);
  if (head instanceof Response) return head;
  if (head !== parsed.data.expectedHeadOid)
    return errorResponse(409, "stale_commit", "The commit is no longer the pull request head.");

  if (action === "merge-queue") {
    if (!queueRequired(rules))
      return errorResponse(
        409,
        "merge_queue_not_required",
        "The base branch does not use a merge queue."
      );
    const blocker = await authorizeMerge(env, repository, user, stored, parsed.data);
    if (blocker) return blockerResponse(blocker);
    const queued = await enqueueForMerge(env, repository, stored, user, parsed.data);
    if (queued.status === "full")
      return errorResponse(409, "queue_full", "The merge queue is full.");
    return dataResponse(await queueStatus(env, repository, stored), queued.created ? 201 : 200);
  }

  const now = Date.now();
  const existing = await env.DB.prepare(
    "SELECT 1 AS present FROM forge_auto_merges WHERE pull_request_id = ?"
  )
    .bind(stored.id)
    .first<{ present: number }>();
  await env.DB.prepare(
    "INSERT INTO forge_auto_merges (pull_request_id, repository_id, enabled_by, method, expected_head_oid, enabled_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, 0) ON CONFLICT(pull_request_id) DO UPDATE SET enabled_by = excluded.enabled_by, method = excluded.method, expected_head_oid = excluded.expected_head_oid, enabled_at = excluded.enabled_at, checked_at = 0"
  )
    .bind(stored.id, repository.id, user.id, parsed.data.method, head, now)
    .run();
  await reportAutoMergeEnabled(env, repository, stored, user, parsed.data);
  await recordAudit(env, {
    action: "pull_request.auto_merge_enabled",
    actor: auditActor(user),
    target: { type: "pull_request", id: String(stored.id), label: `#${number}` },
    repositoryId: repository.id,
    namespaceId: repository.namespace_id,
    metadata: { number, method: parsed.data.method },
  });
  logger.info("forge:auto-merge-enabled", {
    pullRequestNumber: number,
    method: parsed.data.method,
  });
  return dataResponse(await autoMergeStatus(env, repository, stored), existing ? 200 : 201);
}
