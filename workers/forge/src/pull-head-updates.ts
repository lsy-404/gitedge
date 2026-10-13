import { triggerPullActions } from "./pull-actions";
import {
  type PushEventInput,
  type PushEventRefHeads,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger, type Logger } from "../../../src/worker/common/logger";
import { errorResponse } from "../../../src/worker/common/http";
import type { StatementCondition } from "./notifications";
import { pullHeadUpdatedNotificationStatement } from "./notifications";
import { pullRequestEvent } from "./agent-events";
import { repositoryById, type ForgeEnv, type RepositoryRow } from "./common";
import { pullRequestWebhook, pushWebhook, queueWebhookEvent } from "./webhook-events";

const ZERO_OID = "0".repeat(40);
const PULL_HEAD_UPDATES_LIMIT = 4;
const PUSH_EVENT_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1_000;
const PUSH_EVENT_LEDGER_LIMIT = 100_000;
export const PUSH_EVENT_MAX_AGE_MS = PUSH_EVENT_LEDGER_RETENTION_MS;
export const PUSH_EVENT_FUTURE_SKEW_MS = 60_000;

type PushActor = Pick<TrustedUser, "id" | "identifier" | "agentSession">;
type PullHeadRow = {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  body: string;
  author: string;
  baseRef: string;
  headRef: string;
  draft: number;
};

export type PushHeadUpdateResult = {
  queued: number;
  truncated: boolean;
  acceptedUpdates: PushEventInput["updates"];
};

export type PushRefVersion = {
  ref: string;
  eventId: string | null;
  oid: string | null;
  occurredAt: number | null;
};

export async function snapshotPushRefVersions(
  env: ForgeEnv,
  repositoryId: string,
  sessionId: string | undefined,
  refs: readonly string[]
): Promise<PushRefVersion[]> {
  const uniqueRefs = [...new Set(refs)];
  if (uniqueRefs.length > 20) throw new Error("too_many_refs");
  if (uniqueRefs.length === 0) return [];
  const result = await env.DB.prepare(
    "SELECT requested.value AS ref, NULLIF(p.last_event_id, '') AS eventId, p.oid, p.updated_at AS occurredAt FROM json_each(?) AS requested LEFT JOIN forge_ref_pushers p ON p.repository_id = ? AND p.session_id = ? AND p.ref = requested.value"
  )
    .bind(JSON.stringify(uniqueRefs), repositoryId, sessionId ?? "")
    .all<PushRefVersion>();
  return result.results;
}

export function pushEventTimeIsValid(occurredAt: number, now = Date.now()): boolean {
  return occurredAt <= now + PUSH_EVENT_FUTURE_SKEW_MS && now - occurredAt <= PUSH_EVENT_MAX_AGE_MS;
}

function reportCondition(eventId: string, ref: string): StatementCondition {
  return {
    sql: "EXISTS (SELECT 1 FROM forge_push_event_refs WHERE event_id = ? AND ref = ? AND accepted = 1)",
    binds: [eventId, ref],
  };
}

function publishedPullCondition(
  eventId: string,
  ref: string,
  pull: PullHeadRow,
  source: "branch" | "fork" | "session",
  repositoryId: string,
  sessionId: string | undefined
): StatementCondition {
  return {
    sql: "EXISTS (SELECT 1 FROM forge_push_event_refs WHERE event_id = ? AND ref = ? AND accepted = 1) AND EXISTS (SELECT 1 FROM forge_pull_requests p WHERE p.id = ? AND p.repository_id = ? AND p.state = 'open' AND p.head_ref = ? AND p.head_session_id IS ? AND p.head_repository_id IS ?)",
    binds: [
      eventId,
      ref,
      pull.id,
      pull.repositoryId,
      pull.headRef,
      source === "session" ? sessionId : null,
      source === "fork" ? repositoryId : null,
    ],
  };
}

function pusherUpdateStatement(
  env: ForgeEnv,
  repositoryId: string,
  sessionId: string,
  ref: string,
  after: string,
  pusher: PushActor,
  actorJson: string,
  eventId: string,
  occurredAt: number,
  verified: boolean
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO forge_ref_pushers (repository_id, session_id, ref, oid, pusher_id, actor_json, updated_at, last_event_id, pusher_verified) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM forge_push_event_refs WHERE event_id = ? AND ref = ? AND accepted = 1) ON CONFLICT (repository_id, session_id, ref) DO UPDATE SET oid = excluded.oid, pusher_id = excluded.pusher_id, actor_json = excluded.actor_json, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id, pusher_verified = excluded.pusher_verified"
  ).bind(
    repositoryId,
    sessionId,
    ref,
    after,
    pusher.id,
    actorJson,
    occurredAt,
    eventId,
    verified ? 1 : 0,
    eventId,
    ref
  );
}

async function matchedPullRequests(
  env: ForgeEnv,
  repository: RepositoryRow,
  sessionId: string | undefined,
  source: "branch" | "fork" | "session",
  ref: string,
  remaining: number
): Promise<PullHeadRow[]> {
  const branch = ref.slice("refs/heads/".length);
  const query =
    source === "session"
      ? "p.repository_id = ? AND p.head_session_id = ? AND p.head_repository_id IS NULL"
      : "((p.repository_id = ? AND p.head_repository_id IS NULL AND p.head_session_id IS NULL) OR (p.head_repository_id = ? AND p.head_session_id IS NULL))";
  return (
    await env.DB.prepare(
      `SELECT p.id, p.repository_id AS repositoryId, p.number, p.title, p.body, u.identifier AS author, p.base_ref AS baseRef, p.head_ref AS headRef, p.draft FROM forge_pull_requests p JOIN users u ON u.id = p.author_id WHERE p.state = 'open' AND p.head_ref = ? AND ${query} ORDER BY p.created_at, p.id LIMIT ?`
    )
      .bind(
        branch,
        ...(source === "session" ? [repository.id, sessionId] : [repository.id, repository.id]),
        remaining + 1
      )
      .all<PullHeadRow>()
  ).results;
}

async function reserveLedgerCapacity(
  env: ForgeEnv,
  eventId: string,
  refs: readonly string[],
  logger: Logger
): Promise<boolean> {
  const now = Date.now();
  const prune = await env.DB.prepare("DELETE FROM forge_push_event_refs WHERE created_at < ?")
    .bind(now - PUSH_EVENT_LEDGER_RETENTION_MS)
    .run();
  if (prune.meta.changes > 0)
    logger.info("push-event:ledger-expired", { count: prune.meta.changes });
  const uniqueRefs = [...new Set(refs)];
  const existing = await env.DB.prepare(
    "SELECT ref FROM forge_push_event_refs WHERE event_id = ? AND ref IN (SELECT value FROM json_each(?))"
  )
    .bind(eventId, JSON.stringify(uniqueRefs))
    .all<{ ref: string }>();
  const newRefs = uniqueRefs.length - existing.results.length;
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM forge_push_event_refs").first<{
    count: number;
  }>();
  if ((count?.count ?? 0) + newRefs <= PUSH_EVENT_LEDGER_LIMIT) return true;
  logger.error("push-event:ledger-capacity-reached", {
    count: count?.count ?? 0,
    limit: PUSH_EVENT_LEDGER_LIMIT,
    requested: newRefs,
  });
  return false;
}

export async function dispatchPushHeadUpdates(
  env: ForgeEnv,
  repository: RepositoryRow,
  input: PushEventInput,
  pusher: PushActor,
  actorJson: string,
  heads: PushEventRefHeads["heads"],
  updates: PushEventInput["updates"],
  versions: readonly PushRefVersion[],
  alreadyTruncated: boolean,
  logger = createLogger(env.LOG_LEVEL, { service: "forge-webhooks", repoId: repository.id })
): Promise<PushHeadUpdateResult | Response> {
  if (
    !(await reserveLedgerCapacity(
      env,
      input.eventId,
      updates.map((update) => update.ref),
      logger
    ))
  )
    return errorResponse(503, "service_unavailable", "Push event ledger is full.");

  const sessionId = input.agentSessionId;
  const source = sessionId ? "session" : "branch";
  const snapshotSessionId = sessionId ?? "";
  const actualHeads = new Map(heads.map((head) => [head.ref, head.oid]));
  const versionByRef = new Map(versions.map((version) => [version.ref, version]));
  let queued = 0;
  let headUpdates = 0;
  let truncated = alreadyTruncated;
  const acceptedUpdates: PushEventInput["updates"] = [];

  for (const update of updates) {
    if (update.before === update.after) continue;
    const version = versionByRef.get(update.ref);
    if (version?.eventId === input.eventId) continue;
    if (version && version.occurredAt !== null && version.occurredAt > input.occurredAt) {
      logger.info("push-event:older-report-ignored", {
        ref: update.ref,
        reportedAt: input.occurredAt,
        recordedAt: version.occurredAt,
      });
      continue;
    }
    const actual = actualHeads.get(update.ref);
    const expected = update.after === ZERO_OID ? null : update.after;
    if (actual !== expected) {
      logger.info("push-event:stale-ref-ignored", {
        ref: update.ref,
        reported: update.after,
        actual: actual ?? "deleted-or-unreadable",
      });
      continue;
    }
    const matches = update.ref.startsWith("refs/heads/")
      ? await matchedPullRequests(
          env,
          repository,
          sessionId,
          source,
          update.ref,
          PULL_HEAD_UPDATES_LIMIT - headUpdates
        )
      : [];
    const remaining = Math.max(PULL_HEAD_UPDATES_LIMIT - headUpdates, 0);
    if (matches.length > remaining) {
      truncated = true;
      logger.warn("webhook:pull-head-updates-truncated", {
        limit: PULL_HEAD_UPDATES_LIMIT,
        ref: update.ref,
      });
    }
    const selectedPulls = matches.slice(0, remaining);
    const pullRepositories = new Map<string, RepositoryRow>();
    for (const pull of selectedPulls) {
      const pullRepository = await repositoryById(env, pull.repositoryId);
      if (!pullRepository) {
        logger.error("webhook:pull-head-repository-missing", { pullRequestId: pull.id });
        return errorResponse(503, "service_unavailable", "Pull request repository is unavailable.");
      }
      pullRepositories.set(pull.id, pullRepository);
    }
    const condition = reportCondition(input.eventId, update.ref);
    const snapshotEventId = version?.eventId;
    if (snapshotEventId === undefined) {
      logger.error("push-event:ref-version-missing", { ref: update.ref });
      return errorResponse(
        503,
        "service_unavailable",
        "Current ref version could not be verified."
      );
    }
    const snapshotCondition =
      snapshotEventId === null
        ? "NOT EXISTS (SELECT 1 FROM forge_ref_pushers WHERE repository_id = ? AND session_id = ? AND ref = ? AND (last_event_id <> '' OR updated_at > ?))"
        : "EXISTS (SELECT 1 FROM forge_ref_pushers WHERE repository_id = ? AND session_id = ? AND ref = ? AND last_event_id = ? AND updated_at <= ?)";
    const snapshotBinds =
      snapshotEventId === null
        ? [repository.id, snapshotSessionId, update.ref, input.occurredAt]
        : [repository.id, snapshotSessionId, update.ref, snapshotEventId, input.occurredAt];
    const pusherVerified =
      !input.externalPusher &&
      (!version || version.occurredAt !== input.occurredAt || version.oid !== update.after);
    if (!pusherVerified) logger.warn("push-event:ambiguous-pusher", { ref: update.ref });
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO forge_push_event_refs (event_id, repository_id, session_id, ref, before_oid, after_oid, pusher_id, actor_json, accepted, created_at, occurred_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ? WHERE (SELECT COUNT(*) FROM forge_push_event_refs) < ? AND ${snapshotCondition}`
      ).bind(
        input.eventId,
        repository.id,
        snapshotSessionId,
        update.ref,
        update.before,
        update.after,
        pusher.id,
        actorJson,
        input.occurredAt,
        input.occurredAt,
        PUSH_EVENT_LEDGER_LIMIT,
        ...snapshotBinds
      ),
      env.DB.prepare(
        "UPDATE forge_push_event_refs SET accepted = 1 WHERE event_id = ? AND ref = ? AND accepted = 0 AND changes() = 1"
      ).bind(input.eventId, update.ref),
      pusherUpdateStatement(
        env,
        repository.id,
        snapshotSessionId,
        update.ref,
        update.after,
        pusher,
        actorJson,
        input.eventId,
        input.occurredAt,
        pusherVerified
      ),
    ];
    const headHistoryIndexes = new Map<string, number>();
    if (!sessionId)
      statements.push(
        queueWebhookEvent(env.DB, repository.id, pushWebhook(repository, pusher, update), condition)
      );
    for (const pull of selectedPulls) {
      const pullSource: "session" | "branch" | "fork" = sessionId
        ? "session"
        : pull.repositoryId === repository.id
          ? "branch"
          : "fork";
      const historyId = `${input.eventId}:${encodeURIComponent(pull.id)}`;
      const pullCondition = publishedPullCondition(
        input.eventId,
        update.ref,
        pull,
        pullSource,
        repository.id,
        sessionId
      );
      headHistoryIndexes.set(pull.id, statements.length);
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO forge_pull_head_updates (id, pull_request_id, repository_id, source, previous_oid, new_oid, pusher_id, actor_json, agent_session_id, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${pullCondition.sql} RETURNING id`
        ).bind(
          historyId,
          pull.id,
          pull.repositoryId,
          pullSource,
          update.before,
          update.after,
          pusher.id,
          actorJson,
          sessionId ?? null,
          input.occurredAt,
          ...pullCondition.binds
        )
      );
      const pullRepository = pullRepositories.get(pull.id);
      if (!pullRepository) continue;
      statements.push(
        queueWebhookEvent(
          env.DB,
          pull.repositoryId,
          pullRequestWebhook(
            pullRepository,
            pusher,
            "synchronize",
            {
              number: pull.number,
              title: pull.title,
              body: pull.body,
              state: "open",
              author: pull.author,
              baseRef: pull.baseRef,
              headRef: pull.headRef,
              headOid: update.after,
              draft: pull.draft === 1,
              merged: false,
              mergedOid: null,
            },
            { before: update.before, after: update.after }
          ),
          pullCondition
        ),
        pullHeadUpdatedNotificationStatement(
          env.DB,
          pullRepository,
          pusher.id,
          { kind: "pull_request", id: pull.id, number: pull.number },
          pullCondition
        )
      );
      statements.push(
        env.DB.prepare(
          `UPDATE forge_pull_requests SET updated_at = ? WHERE id = ? AND ${pullCondition.sql}`
        ).bind(input.occurredAt, pull.id, ...pullCondition.binds)
      );
    }
    statements.push(
      env.DB.prepare(
        "UPDATE forge_push_event_refs SET accepted = 0 WHERE event_id = ? AND ref = ? AND accepted = 1"
      ).bind(input.eventId, update.ref)
    );
    const results = await env.DB.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      const existing = await env.DB.prepare(
        "SELECT 1 AS present FROM forge_push_event_refs WHERE event_id = ? AND ref = ?"
      )
        .bind(input.eventId, update.ref)
        .first<{ present: number }>();
      if (existing) continue;
      const rowCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM forge_push_event_refs"
      ).first<{ count: number }>();
      if ((rowCount?.count ?? 0) >= PUSH_EVENT_LEDGER_LIMIT) {
        logger.error("push-event:ledger-capacity-race", { limit: PUSH_EVENT_LEDGER_LIMIT });
        return errorResponse(503, "service_unavailable", "Push event ledger is full.");
      }
      logger.warn("push-event:ref-version-conflict", {
        ref: update.ref,
        snapshotEventId,
      });
      return errorResponse(
        503,
        "service_unavailable",
        "Ref changed while verifying the push; retry."
      );
    }
    acceptedUpdates.push(update);
    if (!sessionId) queued += 1;
    for (const pull of selectedPulls) {
      const historyIndex = headHistoryIndexes.get(pull.id);
      if (historyIndex === undefined || results[historyIndex]?.results.length !== 1) continue;
      const pullRepository = pullRepositories.get(pull.id);
      if (!pullRepository) continue;
      await triggerPullActions(env, pull.id);
      try {
        await pullRequestEvent(
          env,
          pullRepository,
          pusher,
          pull.id,
          {
            action: "synchronize",
            number: pull.number,
            before: update.before,
            after: update.after,
            head: { ref: pull.headRef, sha: update.after },
          },
          "pull_request.head_updated"
        );
      } catch {
        logger.error("agent:pull-head-updated-feed-failed", {
          pullRequestId: pull.id,
          agentSessionId: sessionId ?? null,
        });
      }
      queued += 1;
      headUpdates += 1;
    }
  }
  return { queued, truncated, acceptedUpdates };
}
