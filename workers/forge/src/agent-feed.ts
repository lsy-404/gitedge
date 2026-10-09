import {
  AGENT_FEED_MAX_EVENTS,
  AGENT_FEED_RETENTION_MS,
  AgentFeedQuerySchema,
  AgentWebhookEventSchema,
  type AgentDeliveryMode,
  type AgentFeedEvent,
  type AgentFeedExpiry,
  type AgentFeedPage,
  type AgentFeedStatus,
  type AgentWebhookEvent,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { dataResponse, errorResponse, jsonResponse } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import type { ForgeEnv, RepositoryRow } from "./common";

/** Delays between polls while a long-poll request waits; the last value repeats. */
const LONG_POLL_BACKOFF_MS = [500, 1_000, 2_000, 3_000] as const;
const STREAM_POLL_MS = 3_000;
const STREAM_KEEPALIVE_MS = 15_000;
const STREAM_MAX_MS = 90_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

type EventRow = {
  cursor: number;
  event_id: string;
  event: string;
  payload: string;
  created_at: number;
};
type StateRow = { pruned_through: number };

export interface FeedOptions {
  /** Waits between polls; replaced in tests to avoid real delays. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly defer?: (task: Promise<unknown>) => void;
  readonly streamMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Rows beyond the age or count limits; shared by the pruning update and delete. */
const EXPIRED =
  "agent_id = ?1 AND repository_id = ?2 AND (created_at < ?3 OR id <= COALESCE((SELECT id FROM forge_agent_events WHERE agent_id = ?1 AND repository_id = ?2 ORDER BY id DESC LIMIT 1 OFFSET ?4), 0))";

function pruneStatements(
  env: ForgeEnv,
  agentId: string,
  repositoryId: string,
  now: number
): D1PreparedStatement[] {
  const binds = [agentId, repositoryId, now - AGENT_FEED_RETENTION_MS, AGENT_FEED_MAX_EVENTS];
  return [
    env.DB.prepare(
      `UPDATE forge_agent_feed_state SET pruned_through = MAX(pruned_through, COALESCE((SELECT MAX(id) FROM forge_agent_events WHERE ${EXPIRED}), 0)) WHERE agent_id = ?1 AND repository_id = ?2`
    ).bind(...binds),
    env.DB.prepare(`DELETE FROM forge_agent_events WHERE ${EXPIRED}`).bind(...binds),
  ];
}

const ENSURE_STATE =
  "INSERT OR IGNORE INTO forge_agent_feed_state (agent_id, repository_id) VALUES (?, ?)";

/** Delivery channel of an agent, or null when it is missing or disabled. */
export async function agentDeliveryMode(
  env: ForgeEnv,
  agentId: string
): Promise<AgentDeliveryMode | null> {
  const row = await env.DB.prepare(
    "SELECT delivery_mode AS mode FROM auth_agents WHERE id = ? AND disabled_at IS NULL"
  )
    .bind(agentId)
    .first<{ mode: AgentDeliveryMode }>();
  return row?.mode ?? null;
}

/** Stores an event in the agent's pull feed and prunes what exceeds retention. */
export async function appendFeedEvent(
  env: ForgeEnv,
  repository: Pick<RepositoryRow, "id">,
  agentId: string,
  event: AgentWebhookEvent,
  data: Record<string, unknown>
): Promise<boolean> {
  const payload = JSON.stringify(data);
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: repository.id });
  if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
    logger.warn("agent-feed:payload-too-large", { agentId, event });
    return false;
  }
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(ENSURE_STATE).bind(agentId, repository.id),
      env.DB.prepare(
        "INSERT INTO forge_agent_events (agent_id, repository_id, event_id, event, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(agentId, repository.id, crypto.randomUUID(), event, payload, now),
      ...pruneStatements(env, agentId, repository.id, now),
    ]);
    logger.debug("agent-feed:event-appended", { agentId, event });
    return true;
  } catch {
    logger.warn("agent-feed:append-failed", { agentId, event });
    return false;
  }
}

function presentEvent(row: EventRow): AgentFeedEvent | null {
  const event = AgentWebhookEventSchema.safeParse(row.event);
  if (!event.success) return null;
  let data: unknown;
  try {
    data = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return {
    cursor: row.cursor,
    id: row.event_id,
    event: event.data,
    createdAt: row.created_at,
    data: Object.fromEntries(Object.entries(data)),
  };
}

async function readEvents(
  env: ForgeEnv,
  scope: Scope,
  after: number,
  limit: number
): Promise<{ events: AgentFeedEvent[]; last: number | null; more: boolean }> {
  const rows = await env.DB.prepare(
    "SELECT id AS cursor, event_id, event, payload, created_at FROM forge_agent_events WHERE agent_id = ? AND repository_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
  )
    .bind(scope.agentId, scope.repositoryId, after, limit + 1)
    .all<EventRow>();
  const page = rows.results.slice(0, limit);
  const events = page.map(presentEvent).filter((event): event is AgentFeedEvent => event !== null);
  // The cursor moves past unreadable rows too, so one bad row cannot stall the feed.
  return { events, last: page[page.length - 1]?.cursor ?? null, more: rows.results.length > limit };
}

type Scope = {
  readonly agentId: string;
  readonly repositoryId: string;
};

/** Records the poll, prunes, and returns the oldest valid cursor. */
async function openFeed(env: ForgeEnv, scope: Scope, now: number): Promise<number> {
  const results = await env.DB.batch<StateRow>([
    env.DB.prepare(ENSURE_STATE).bind(scope.agentId, scope.repositoryId),
    ...pruneStatements(env, scope.agentId, scope.repositoryId, now),
    env.DB.prepare(
      "UPDATE forge_agent_feed_state SET last_polled_at = ? WHERE agent_id = ? AND repository_id = ?"
    ).bind(now, scope.agentId, scope.repositoryId),
    env.DB.prepare(
      "SELECT pruned_through FROM forge_agent_feed_state WHERE agent_id = ? AND repository_id = ?"
    ).bind(scope.agentId, scope.repositoryId),
  ]);
  return results[results.length - 1]?.results[0]?.pruned_through ?? 0;
}

function expired(oldestCursor: number): Response {
  const body: { error: { code: string; message: string } & AgentFeedExpiry } = {
    error: {
      code: "cursor_expired",
      message:
        "Events after this cursor were pruned. Re-read current state and resume from oldestCursor.",
      oldestCursor,
    },
  };
  return jsonResponse(body, 410);
}

/**
 * Pull-feed read for one agent session. Long polling waits with growing sleeps between cheap
 * indexed reads, so no database work is held open while waiting.
 */
export async function pollFeed(
  env: ForgeEnv,
  scope: Scope,
  query: { cursor?: number; limit: number; wait: number },
  options: FeedOptions = {}
): Promise<Response> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const oldest = await openFeed(env, scope, now());
  if (query.cursor !== undefined && query.cursor < oldest) {
    createLogger(env.LOG_LEVEL, { service: "forge", repoId: scope.repositoryId }).info(
      "agent-feed:cursor-expired",
      { agentId: scope.agentId, cursor: query.cursor, oldest }
    );
    return expired(oldest);
  }
  const start = query.cursor ?? oldest;
  const deadline = now() + query.wait * 1000;
  let attempt = 0;
  let page = await readEvents(env, scope, start, query.limit);
  while (page.last === null && now() < deadline) {
    const delay = LONG_POLL_BACKOFF_MS[Math.min(attempt, LONG_POLL_BACKOFF_MS.length - 1)] ?? 0;
    attempt += 1;
    await sleep(Math.min(delay, Math.max(0, deadline - now())));
    page = await readEvents(env, scope, start, query.limit);
  }
  const result: AgentFeedPage = {
    events: page.events,
    cursor: page.last ?? start,
    more: page.more,
  };
  await env.DB.prepare(
    "UPDATE forge_agent_feed_state SET last_cursor = MAX(last_cursor, ?) WHERE agent_id = ? AND repository_id = ?"
  )
    .bind(result.cursor, scope.agentId, scope.repositoryId)
    .run();
  return dataResponse(result);
}

function sseFrame(event: AgentFeedEvent): string {
  return `id: ${event.cursor}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Server-sent events variant; the stream ends after a bounded time and the client resumes with Last-Event-ID. */
export async function streamFeed(
  env: ForgeEnv,
  request: Request,
  scope: Scope,
  cursor: number | undefined,
  options: FeedOptions = {}
): Promise<Response> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const oldest = await openFeed(env, scope, now());
  if (cursor !== undefined && cursor < oldest) return expired(oldest);
  let position = cursor ?? oldest;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const logger = createLogger(env.LOG_LEVEL, { service: "forge", repoId: scope.repositoryId });
  const run = async (): Promise<void> => {
    const startedAt = now();
    let lastWrite = startedAt;
    try {
      await writer.write(encoder.encode(`retry: ${STREAM_POLL_MS}\n\n`));
      while (now() - startedAt < (options.streamMs ?? STREAM_MAX_MS)) {
        if (request.signal.aborted) return;
        const page = await readEvents(env, scope, position, 50);
        for (const event of page.events) await writer.write(encoder.encode(sseFrame(event)));
        if (page.last !== null) {
          position = page.last;
          lastWrite = now();
          if (page.more) continue;
        } else if (now() - lastWrite >= STREAM_KEEPALIVE_MS) {
          await writer.write(encoder.encode(": keepalive\n\n"));
          lastWrite = now();
        }
        await sleep(STREAM_POLL_MS);
      }
      await env.DB.prepare(
        "UPDATE forge_agent_feed_state SET last_polled_at = ?, last_cursor = MAX(last_cursor, ?) WHERE agent_id = ? AND repository_id = ?"
      )
        .bind(now(), position, scope.agentId, scope.repositoryId)
        .run();
    } catch {
      logger.debug("agent-feed:stream-closed", { agentId: scope.agentId });
    } finally {
      await writer.close().catch(() => undefined);
    }
  };
  const task = run();
  if (options.defer) options.defer(task);
  else void task;
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Routes `/repositories/:id/agent-events[/stream]` for the repository's agent session. */
export async function handleAgentFeed(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  rest: readonly string[],
  options: FeedOptions = {}
): Promise<Response | null> {
  if (rest[0] !== "agent-events") return null;
  if (request.method !== "GET")
    return errorResponse(405, "method_not_allowed", "Method is not allowed for this endpoint.");
  const streaming = rest[1] === "stream" && rest.length === 2;
  if (rest.length > 2 || (rest.length === 2 && !streaming))
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const session = user.agentSession;
  if (!session || session.repositoryId !== repository.id)
    return errorResponse(403, "forbidden", "An agent session of this repository is required.");
  if (repository.agents_enabled === 0)
    return errorResponse(404, "feature_disabled", "Repository agents are disabled.");
  const mode = await agentDeliveryMode(env, session.agentId);
  if (mode === null) return errorResponse(401, "unauthorized", "Agent is disabled.");
  if (mode === "webhook")
    return errorResponse(
      409,
      "pull_delivery_disabled",
      "Pull delivery is not enabled for this agent. Choose pull or both in the agent settings."
    );
  const url = new URL(request.url);
  // EventSource reconnects with the original URL plus Last-Event-ID, so the header wins there.
  const queryCursor = url.searchParams.get("cursor");
  const resumeCursor = request.headers.get("Last-Event-ID");
  const parsed = AgentFeedQuerySchema.safeParse({
    cursor:
      (streaming ? (resumeCursor ?? queryCursor) : (queryCursor ?? resumeCursor)) ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    wait: url.searchParams.get("wait") ?? undefined,
  });
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid feed query.");
  const scope = { agentId: session.agentId, repositoryId: repository.id };
  return streaming
    ? streamFeed(env, request, scope, parsed.data.cursor, options)
    : pollFeed(env, scope, parsed.data, options);
}

/** Owner-facing summary of an agent's feed across repositories. */
export async function agentFeedStatus(
  env: ForgeEnv,
  user: TrustedUser,
  agentId: string
): Promise<Response> {
  const agent = await env.DB.prepare(
    "SELECT delivery_mode AS mode FROM auth_agents WHERE id = ? AND user_id = ?"
  )
    .bind(agentId, user.id)
    .first<{ mode: AgentDeliveryMode }>();
  if (!agent) return errorResponse(404, "not_found", "Agent was not found.");
  const totals = await env.DB.prepare(
    "SELECT (SELECT MAX(last_polled_at) FROM forge_agent_feed_state WHERE agent_id = ?1) AS lastPolledAt, (SELECT MAX(id) FROM forge_agent_events WHERE agent_id = ?1) AS latestCursor, (SELECT COUNT(*) FROM forge_agent_events WHERE agent_id = ?1) AS retained"
  )
    .bind(agentId)
    .first<{ lastPolledAt: number | null; latestCursor: number | null; retained: number }>();
  const status: AgentFeedStatus = {
    deliveryMode: agent.mode,
    lastPolledAt: totals?.lastPolledAt ?? null,
    latestCursor: totals?.latestCursor ?? null,
    retained: totals?.retained ?? 0,
    retentionDays: AGENT_FEED_RETENTION_MS / 86_400_000,
    maxEvents: AGENT_FEED_MAX_EVENTS,
  };
  return dataResponse(status);
}

const PURGE_BATCH = 1_000;

/**
 * Cron sweep: advances each feed's expiry watermark over all aged events, then deletes a bounded
 * batch of them. Rows left for the next run are already behind the watermark and never served.
 */
export async function purgeAgentFeeds(env: ForgeEnv, now = Date.now()): Promise<number> {
  const cutoff = now - AGENT_FEED_RETENTION_MS;
  const [, deleted] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE forge_agent_feed_state SET pruned_through = MAX(pruned_through, COALESCE((SELECT MAX(id) FROM forge_agent_events e WHERE e.agent_id = forge_agent_feed_state.agent_id AND e.repository_id = forge_agent_feed_state.repository_id AND e.created_at < ?1), 0))"
    ).bind(cutoff),
    env.DB.prepare(
      "DELETE FROM forge_agent_events WHERE id IN (SELECT id FROM forge_agent_events WHERE created_at < ? ORDER BY id LIMIT ?)"
    ).bind(cutoff, PURGE_BATCH),
  ]);
  const count = deleted?.meta.changes ?? 0;
  if (count >= PURGE_BATCH)
    createLogger(env.LOG_LEVEL, { service: "forge" }).info("agent-feed:purge-truncated", {
      count,
    });
  return count;
}
