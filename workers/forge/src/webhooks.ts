import {
  CreateRepositoryWebhookInputSchema,
  PushEventInputSchema,
  REPOSITORY_WEBHOOK_LIMIT,
  RepositoryWebhookEventSchema,
  UpdateRepositoryWebhookInputSchema,
  WEBHOOK_PUSH_REFS_LIMIT,
  type RepositoryWebhook,
  type RepositoryWebhookDelivery,
  type RepositoryWebhookDeliveryDetail,
  type RepositoryWebhookEvent,
  type SavedRepositoryWebhook,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { auditActor, recordAudit } from "../../../src/worker/common/audit";
import { randomHex } from "../../../src/worker/common/encoding";
import { dataResponse, errorResponse, requireRecentAuth } from "../../../src/worker/common/http";
import { createLogger } from "../../../src/worker/common/logger";
import { resolvePublicHost, type HostResolver } from "../../../src/worker/common/public-host";
import { repositoryRole } from "../../../src/worker/common/repositories";
import { importSealingKey, openText, sealText } from "../../../src/worker/common/secret-box";
import {
  WEBHOOK_MAX_ATTEMPTS,
  isPublicWebhookUrl,
  sendWebhook,
  signWebhookBody,
  webhookRetryDelay,
} from "../../../src/worker/common/webhooks";
import { z } from "zod";
import { enqueueAiSummariesForPush } from "./ai-summary";
import { parseJson, type ForgeEnv, type RepositoryRow } from "./common";
import {
  pushWebhook,
  queueWebhookEvent,
  repositoryPayload,
  type WebhookEvent,
} from "./webhook-events";

const LEASE_MS = 60_000;
const DRAIN_LIMIT = 10;
const HISTORY_LIMIT = 100;
const LIST_LIMIT = 50;
const RETENTION_MS = 30 * 86_400_000;

interface WebhookRow {
  id: string;
  repositoryId: string;
  url: string;
  contentType: "json";
  eventsJson: string;
  active: number;
  secretCiphertext: string;
  secretIv: string;
  createdAt: number;
  updatedAt: number;
}
interface DeliveryRow {
  id: string;
  webhookId: string;
  repositoryId: string;
  event: RepositoryWebhookDelivery["event"];
  action: string | null;
  payload: string;
  status: "pending" | "processing" | "success" | "failed";
  responseStatus: number | null;
  errorCode: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  redeliveryOf: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

const WEBHOOK_SELECT =
  "SELECT id, repository_id AS repositoryId, url, content_type AS contentType, events_json AS eventsJson, active, secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, created_at AS createdAt, updated_at AS updatedAt FROM forge_webhooks";
const DELIVERY_SELECT =
  "SELECT id, webhook_id AS webhookId, repository_id AS repositoryId, event, action, payload, status, response_status AS responseStatus, error_code AS errorCode, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt, redelivery_of AS redeliveryOf, created_at AS createdAt, delivered_at AS deliveredAt FROM forge_webhook_deliveries";

const EventsSchema = z.array(RepositoryWebhookEventSchema);

function parseEvents(value: string): RepositoryWebhookEvent[] {
  const parsed = EventsSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : [];
}

function presentWebhook(row: WebhookRow): RepositoryWebhook {
  return {
    id: row.id,
    url: row.url,
    contentType: row.contentType,
    events: parseEvents(row.eventsJson),
    active: row.active === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentDelivery(row: DeliveryRow): RepositoryWebhookDelivery {
  return {
    id: row.id,
    event: row.event,
    action: row.action,
    status: row.status === "processing" ? "pending" : row.status,
    responseStatus: row.responseStatus,
    errorCode: row.errorCode,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.status === "success" || row.status === "failed" ? null : row.nextAttemptAt,
    redeliveryOf: row.redeliveryOf,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

async function sealingKey(env: ForgeEnv): Promise<CryptoKey | null> {
  return importSealingKey(env.WEBHOOK_ENCRYPTION_KEY);
}

type UrlCheck = { ok: true } | { ok: false; response: Response };

async function checkUrl(url: string, resolver: HostResolver): Promise<UrlCheck> {
  if (!isPublicWebhookUrl(url))
    return {
      ok: false,
      response: errorResponse(
        400,
        "invalid_webhook_url",
        "Webhook URL must be a public HTTPS URL."
      ),
    };
  const resolved = await resolver(new URL(url).hostname);
  if (resolved.ok) return { ok: true };
  return resolved.reason === "resolver_error"
    ? {
        ok: false,
        response: errorResponse(503, "service_unavailable", "Webhook host could not be verified."),
      }
    : {
        ok: false,
        response: errorResponse(
          400,
          "invalid_webhook_url",
          "Webhook URL must resolve to public addresses."
        ),
      };
}

async function loadWebhook(
  env: ForgeEnv,
  repositoryId: string,
  id: string
): Promise<WebhookRow | null> {
  return env.DB.prepare(`${WEBHOOK_SELECT} WHERE id = ? AND repository_id = ?`)
    .bind(id, repositoryId)
    .first<WebhookRow>();
}

async function trimHistory(env: ForgeEnv, webhookId: string): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM forge_webhook_deliveries WHERE webhook_id = ? AND status IN ('success', 'failed') AND id NOT IN (SELECT id FROM forge_webhook_deliveries WHERE webhook_id = ? AND status IN ('success', 'failed') ORDER BY created_at DESC, id DESC LIMIT ?)"
  )
    .bind(webhookId, webhookId, HISTORY_LIMIT)
    .run();
}

async function finish(
  env: ForgeEnv,
  row: DeliveryRow,
  outcome: {
    status: "pending" | "success" | "failed";
    responseStatus: number | null;
    errorCode: string | null;
    nextAttemptAt: number | null;
    deliveredAt: number | null;
  }
): Promise<void> {
  await env.DB.prepare(
    "UPDATE forge_webhook_deliveries SET status = ?, response_status = ?, error_code = ?, next_attempt_at = ?, delivered_at = ?, lease_until = NULL WHERE id = ? AND status = 'processing'"
  )
    .bind(
      outcome.status,
      outcome.responseStatus,
      outcome.errorCode,
      outcome.nextAttemptAt,
      outcome.deliveredAt,
      row.id
    )
    .run();
  if (outcome.status !== "pending") await trimHistory(env, row.webhookId);
}

/** Sends one claimed delivery and records success, a scheduled retry or final failure. */
async function attempt(env: ForgeEnv, row: DeliveryRow, now: number): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, {
    service: "forge-webhooks",
    repoId: row.repositoryId,
  });
  const hook = await env.DB.prepare(
    `${WEBHOOK_SELECT} WHERE id = ? AND EXISTS (SELECT 1 FROM repositories r WHERE r.id = forge_webhooks.repository_id AND r.deleted_at IS NULL)`
  )
    .bind(row.webhookId)
    .first<WebhookRow>();
  if (!hook || hook.active !== 1 || !isPublicWebhookUrl(hook.url)) {
    await finish(env, row, {
      status: "failed",
      responseStatus: null,
      errorCode: hook && hook.active === 1 ? "url_rejected" : "webhook_inactive",
      nextAttemptAt: null,
      deliveredAt: null,
    });
    return;
  }
  const key = await sealingKey(env);
  if (!key) {
    logger.error("webhook:encryption-unavailable", { deliveryId: row.id });
    await finish(env, row, {
      status: row.attemptCount >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending",
      responseStatus: null,
      errorCode: "encryption_unavailable",
      nextAttemptAt: now + webhookRetryDelay(row.attemptCount),
      deliveredAt: null,
    });
    return;
  }
  const secret = await openText(key, { ciphertext: hook.secretCiphertext, iv: hook.secretIv });
  const sent = await sendWebhook({
    url: hook.url,
    body: row.payload,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "GitEdge-Hookshot",
      "X-GitEdge-Event": row.event,
      "X-GitEdge-Delivery": row.id,
      "X-Hub-Signature-256": await signWebhookBody(secret, row.payload),
    },
  });
  if (sent.delivered) {
    await finish(env, row, {
      status: "success",
      responseStatus: sent.responseStatus,
      errorCode: null,
      nextAttemptAt: null,
      deliveredAt: Date.now(),
    });
    return;
  }
  const exhausted = row.attemptCount >= WEBHOOK_MAX_ATTEMPTS;
  logger.warn(exhausted ? "webhook:delivery-failed" : "webhook:delivery-retry-scheduled", {
    deliveryId: row.id,
    webhookId: row.webhookId,
    attempt: row.attemptCount,
    errorCode: sent.errorCode,
    responseStatus: sent.responseStatus,
  });
  await finish(env, row, {
    status: exhausted ? "failed" : "pending",
    responseStatus: sent.responseStatus,
    errorCode: sent.errorCode,
    nextAttemptAt: exhausted ? null : now + webhookRetryDelay(row.attemptCount),
    deliveredAt: null,
  });
}

/** Runs one attempt; unexpected failures (such as an undecryptable secret) schedule a retry instead of escaping. */
async function attemptSafely(env: ForgeEnv, row: DeliveryRow, now: number): Promise<void> {
  try {
    await attempt(env, row, now);
  } catch {
    createLogger(env.LOG_LEVEL, { service: "forge-webhooks", repoId: row.repositoryId }).error(
      "webhook:delivery-error",
      { deliveryId: row.id }
    );
    await finish(env, row, {
      status: row.attemptCount >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending",
      responseStatus: null,
      errorCode: "delivery_error",
      nextAttemptAt: now + webhookRetryDelay(row.attemptCount),
      deliveredAt: null,
    });
  }
}

async function claim(env: ForgeEnv, id: string, now: number, due: boolean): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE forge_webhook_deliveries SET status = 'processing', lease_until = ?, attempt_count = attempt_count + 1 WHERE id = ? AND attempt_count < ? AND ((status = 'pending'${due ? " AND next_attempt_at <= ?" : ""}) OR (status = 'processing' AND lease_until <= ?))`
  )
    .bind(now + LEASE_MS, id, WEBHOOK_MAX_ATTEMPTS, ...(due ? [now] : []), now)
    .run();
  return result.meta.changes === 1;
}

async function claimedRow(env: ForgeEnv, id: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(`${DELIVERY_SELECT} WHERE id = ?`).bind(id).first<DeliveryRow>();
}

/** Delivers due pending deliveries, retries expired leases and closes attempt-exhausted ones. */
export async function drainWebhookDeliveries(
  env: ForgeEnv,
  now = Date.now(),
  limit = DRAIN_LIMIT
): Promise<number> {
  const logger = createLogger(env.LOG_LEVEL, { service: "forge-webhooks" });
  await env.DB.prepare(
    "UPDATE forge_webhook_deliveries SET status = 'failed', error_code = 'attempt_limit', next_attempt_at = NULL, lease_until = NULL WHERE status = 'processing' AND lease_until <= ? AND attempt_count >= ?"
  )
    .bind(now, WEBHOOK_MAX_ATTEMPTS)
    .run();
  const due = await env.DB.prepare(
    "SELECT id FROM forge_webhook_deliveries WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?) ORDER BY next_attempt_at, created_at LIMIT ?"
  )
    .bind(now, now, limit)
    .all<{ id: string }>();
  let processed = 0;
  for (const { id } of due.results) {
    if (!(await claim(env, id, now, true))) continue;
    const row = await claimedRow(env, id);
    if (!row) continue;
    processed += 1;
    await attemptSafely(env, row, now);
  }
  if (due.results.length === limit) logger.info("webhook:drain-limited", { limit, processed });
  return processed;
}

/** Deletes finished deliveries past retention in bounded batches. */
export async function purgeWebhookDeliveries(env: ForgeEnv, now = Date.now()): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM forge_webhook_deliveries WHERE id IN (SELECT id FROM forge_webhook_deliveries WHERE status IN ('success', 'failed') AND created_at < ? LIMIT 500)"
  )
    .bind(now - RETENTION_MS)
    .run();
  return result.meta.changes;
}

async function queueDelivery(
  env: ForgeEnv,
  hook: WebhookRow,
  event: RepositoryWebhookDelivery["event"],
  action: string | null,
  payload: string,
  redeliveryOf: string | null
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO forge_webhook_deliveries (id, webhook_id, repository_id, event, action, payload, status, attempt_count, next_attempt_at, redelivery_of, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)"
  )
    .bind(id, hook.id, hook.repositoryId, event, action, payload, now, redeliveryOf, now)
    .run();
  return id;
}

async function deliverNow(env: ForgeEnv, id: string): Promise<DeliveryRow | null> {
  const now = Date.now();
  if (await claim(env, id, now, false)) {
    const row = await claimedRow(env, id);
    if (row) await attemptSafely(env, row, now);
  }
  return claimedRow(env, id);
}

export async function handleRepositoryWebhooks(
  env: ForgeEnv,
  request: Request,
  repository: RepositoryRow,
  user: TrustedUser,
  parts: readonly string[],
  resolver: HostResolver = resolvePublicHost
): Promise<Response | null> {
  if (parts[2] !== "webhooks") return null;
  if (user.agentSession || (await repositoryRole(env.DB, repository.id, user.id)) !== "admin")
    return errorResponse(403, "forbidden", "Repository administrator access is required.");
  const logger = createLogger(env.LOG_LEVEL, { service: "forge-webhooks", repoId: repository.id });
  const hookId = parts[3];
  const method = request.method;
  const sensitive = !hookId
    ? method === "POST"
    : parts.length === 4 && (method === "PATCH" || method === "DELETE");
  if (sensitive) {
    const reauth = requireRecentAuth(user);
    if (reauth) return reauth;
  }
  if (!hookId) {
    if (method === "GET") {
      const rows = await env.DB.prepare(
        `${WEBHOOK_SELECT} WHERE repository_id = ? ORDER BY created_at, id`
      )
        .bind(repository.id)
        .all<WebhookRow>();
      return dataResponse(rows.results.map(presentWebhook));
    }
    if (method !== "POST")
      return errorResponse(405, "method_not_allowed", "Method is not allowed.");
    const parsed = CreateRepositoryWebhookInputSchema.safeParse(await parseJson(request));
    if (!parsed.success) return errorResponse(400, "bad_request", "Invalid webhook settings.");
    const input = parsed.data;
    const key = await sealingKey(env);
    if (!key)
      return errorResponse(503, "service_unavailable", "Webhook encryption is not configured.");
    const checked = await checkUrl(input.url, resolver);
    if (!checked.ok) return checked.response;
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM forge_webhooks WHERE repository_id = ?"
    )
      .bind(repository.id)
      .first<{ total: number }>();
    if ((count?.total ?? 0) >= REPOSITORY_WEBHOOK_LIMIT)
      return errorResponse(
        409,
        "webhook_limit",
        `At most ${REPOSITORY_WEBHOOK_LIMIT} webhooks are allowed.`
      );
    const generated = input.secret === undefined;
    const secret = input.secret ?? `ge_webhook_${randomHex(32)}`;
    const sealed = await sealText(key, secret);
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO forge_webhooks (id, repository_id, url, content_type, events_json, active, secret_ciphertext, secret_iv, created_by, created_at, updated_at) VALUES (?, ?, ?, 'json', ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        repository.id,
        input.url,
        JSON.stringify(input.events),
        Number(input.active),
        sealed.ciphertext,
        sealed.iv,
        user.id,
        now,
        now
      )
      .run();
    logger.info("webhook:created", { webhookId: id, userId: user.id, events: input.events.length });
    await recordAudit(env, {
      action: "repository_webhook.created",
      actor: auditActor(user),
      target: { type: "webhook", id, label: new URL(input.url).host },
      repositoryId: repository.id,
      namespaceId: repository.namespace_id,
      metadata: { host: new URL(input.url).host, events: input.events, active: input.active },
    });
    const saved: SavedRepositoryWebhook = {
      id,
      url: input.url,
      contentType: "json",
      events: input.events,
      active: input.active,
      createdAt: now,
      updatedAt: now,
      secret: generated ? secret : null,
    };
    return dataResponse(saved, 201);
  }

  const hook = await loadWebhook(env, repository.id, hookId);
  if (!hook) return errorResponse(404, "not_found", "Webhook was not found.");
  if (parts.length === 4) {
    if (method === "GET") return dataResponse(presentWebhook(hook));
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM forge_webhooks WHERE id = ?").bind(hook.id).run();
      logger.info("webhook:deleted", { webhookId: hook.id, userId: user.id });
      await recordAudit(env, {
        action: "repository_webhook.deleted",
        actor: auditActor(user),
        target: { type: "webhook", id: hook.id, label: new URL(hook.url).host },
        repositoryId: repository.id,
        namespaceId: repository.namespace_id,
        metadata: { host: new URL(hook.url).host },
      });
      return dataResponse({ deleted: true });
    }
    if (method === "PATCH") {
      const parsed = UpdateRepositoryWebhookInputSchema.safeParse(await parseJson(request));
      if (!parsed.success) return errorResponse(400, "bad_request", "Invalid webhook settings.");
      const input = parsed.data;
      if (input.url !== undefined && input.url !== hook.url) {
        const checked = await checkUrl(input.url, resolver);
        if (!checked.ok) return checked.response;
      }
      const replaceSecret = input.secret !== undefined || input.rotateSecret === true;
      const generated = replaceSecret && input.secret === undefined;
      const secret = replaceSecret ? (input.secret ?? `ge_webhook_${randomHex(32)}`) : null;
      let sealed: { ciphertext: string; iv: string } | null = null;
      if (secret !== null) {
        const key = await sealingKey(env);
        if (!key)
          return errorResponse(503, "service_unavailable", "Webhook encryption is not configured.");
        sealed = await sealText(key, secret);
      }
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE forge_webhooks SET url = COALESCE(?, url), events_json = COALESCE(?, events_json), active = COALESCE(?, active), secret_ciphertext = COALESCE(?, secret_ciphertext), secret_iv = COALESCE(?, secret_iv), updated_at = ? WHERE id = ?"
      )
        .bind(
          input.url ?? null,
          input.events ? JSON.stringify(input.events) : null,
          input.active === undefined ? null : Number(input.active),
          sealed?.ciphertext ?? null,
          sealed?.iv ?? null,
          now,
          hook.id
        )
        .run();
      logger.info("webhook:updated", {
        webhookId: hook.id,
        userId: user.id,
        rotated: replaceSecret,
      });
      const updated = await loadWebhook(env, repository.id, hook.id);
      if (!updated) return errorResponse(404, "not_found", "Webhook was not found.");
      const saved: SavedRepositoryWebhook = {
        ...presentWebhook(updated),
        secret: generated ? secret : null,
      };
      return dataResponse(saved);
    }
    return errorResponse(405, "method_not_allowed", "Method is not allowed.");
  }

  if (parts[4] === "ping" && parts.length === 5 && method === "POST") {
    const payload = JSON.stringify({
      zen: "Keep it simple.",
      hook_id: hook.id,
      hook: { events: parseEvents(hook.eventsJson), active: hook.active === 1 },
      repository: repositoryPayload(repository),
      sender: { id: user.id, login: user.identifier },
    });
    const id = await queueDelivery(env, hook, "ping", null, payload, null);
    const delivery = await deliverNow(env, id);
    if (!delivery) return errorResponse(503, "service_unavailable", "Delivery was not recorded.");
    return dataResponse(presentDelivery(delivery), delivery.status === "success" ? 200 : 502);
  }
  if (parts[4] !== "deliveries") return errorResponse(404, "not_found", "Endpoint was not found.");
  if (parts.length === 5 && method === "GET") {
    const rows = await env.DB.prepare(
      `${DELIVERY_SELECT} WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    )
      .bind(hook.id, LIST_LIMIT)
      .all<DeliveryRow>();
    return dataResponse(rows.results.map(presentDelivery));
  }
  const deliveryId = parts[5];
  if (!deliveryId) return errorResponse(404, "not_found", "Endpoint was not found.");
  const delivery = await env.DB.prepare(`${DELIVERY_SELECT} WHERE id = ? AND webhook_id = ?`)
    .bind(deliveryId, hook.id)
    .first<DeliveryRow>();
  if (!delivery) return errorResponse(404, "not_found", "Delivery was not found.");
  if (parts.length === 6 && method === "GET") {
    const detail: RepositoryWebhookDeliveryDetail = {
      ...presentDelivery(delivery),
      payload: JSON.parse(delivery.payload),
    };
    return dataResponse(detail);
  }
  if (parts.length === 7 && parts[6] === "redeliveries" && method === "POST") {
    if (delivery.status === "pending" || delivery.status === "processing")
      return errorResponse(409, "conflict", "Delivery is still in progress.");
    const id = await queueDelivery(
      env,
      hook,
      delivery.event,
      delivery.action,
      delivery.payload,
      delivery.id
    );
    const redelivered = await deliverNow(env, id);
    if (!redelivered)
      return errorResponse(503, "service_unavailable", "Delivery was not recorded.");
    return dataResponse(presentDelivery(redelivered), 201);
  }
  return errorResponse(405, "method_not_allowed", "Method is not allowed.");
}

/** Internal endpoint: Git reports completed ref updates and Forge queues push deliveries. */
export async function handlePushEvent(
  env: ForgeEnv,
  request: Request,
  loadRepository: (repositoryId: string) => Promise<RepositoryRow | null>
): Promise<Response> {
  if (new URL(request.url).hostname !== "forge.internal" || request.method !== "POST")
    return errorResponse(404, "not_found", "Endpoint was not found.");
  const parsed = PushEventInputSchema.safeParse(await parseJson(request));
  if (!parsed.success) return errorResponse(400, "bad_request", "Invalid push event.");
  const logger = createLogger(env.LOG_LEVEL, {
    service: "forge-webhooks",
    repoId: parsed.data.repositoryId,
  });
  const repository = await loadRepository(parsed.data.repositoryId);
  if (!repository) return dataResponse({ queued: 0 });
  const pusher = await env.DB.prepare("SELECT id, identifier FROM users WHERE id = ?")
    .bind(parsed.data.pusherId)
    .first<{ id: string; identifier: string }>();
  if (!pusher) return errorResponse(404, "not_found", "Pusher was not found.");
  const updates = parsed.data.updates.slice(0, WEBHOOK_PUSH_REFS_LIMIT);
  if (parsed.data.updates.length > updates.length)
    logger.warn("webhook:push-refs-truncated", { count: parsed.data.updates.length });
  const events: WebhookEvent[] = updates.map((update) => pushWebhook(repository, pusher, update));
  await env.DB.batch(events.map((event) => queueWebhookEvent(env.DB, repository.id, event)));
  await enqueueAiSummariesForPush(
    env,
    repository,
    pusher.id,
    updates.map((update) => update.ref)
  );
  return dataResponse({
    queued: events.length,
    truncated: parsed.data.updates.length > updates.length,
  });
}
