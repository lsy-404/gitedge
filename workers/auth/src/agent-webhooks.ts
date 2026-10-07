import {
  AgentWebhookSettingsSchema,
  type AgentWebhookEvent,
  type AgentWebhookSettings,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
import { repositoryRole, writableRole } from "../../../src/worker/common/repositories";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  randomHex,
} from "../../../src/worker/common/encoding";
import {
  dataResponse as response,
  errorResponse as failure,
} from "../../../src/worker/common/http";
import { readJsonLimited, SMALL_JSON_BYTES } from "../../../src/worker/common/readText";
import { z } from "zod";

export interface AgentWebhookEnv {
  DB: D1Database;
  WEBHOOK_ENCRYPTION_KEY?: string;
  LOG_LEVEL?: string;
}
type SettingsRow = {
  agentId: string;
  url: string;
  eventsJson: string;
  enabled: number;
  secretCiphertext: string;
  secretIv: string;
  updatedAt: number;
};
type DeliveryRow = {
  id: string;
  event: AgentWebhookEvent;
  status: "success" | "failed";
  responseStatus: number | null;
  errorCode: string | null;
  attemptCount: number;
  createdAt: number;
  deliveredAt: number | null;
};
interface StoredDeliveryRow extends Omit<DeliveryRow, "status"> {
  status: "pending" | "success" | "failed";
}
interface AgentEventRow {
  id: string;
  agentId: string;
  repositoryId: string;
  actorUserId: string;
  event: AgentWebhookEvent;
  payload: string;
  createdAt: number;
  nextAttemptAt: number;
  attempts: number;
  deliveryId: string;
  status: "pending" | "processing" | "delivered" | "dropped" | "dead";
  leaseUntil: number | null;
  errorCode: string | null;
}
interface DeliveryAttemptRow {
  attemptCount: number;
  createdAt: number;
}
type DeliveryClaimMode = "initial" | "manual-retry" | "outbox";

class DeliveryClaimConflict extends Error {}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_OUTBOX_EVENTS_PER_RUN = 10;
const MAX_PENDING_EVENTS_PER_AGENT = 1_000;
const OUTBOX_LEASE_MS = 60_000;
const ALLOWED_EVENTS = ["agent.assigned", "agent.mentioned", "pull_request.updated"] as const;
const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".test",
  ".home",
  ".home.arpa",
  ".lan",
  ".intranet",
  ".corp",
  ".private",
] as const;
const SETTINGS_SELECT =
  "SELECT agent_id AS agentId, url, events_json AS eventsJson, enabled, secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, updated_at AS updatedAt FROM auth_agent_webhooks";
const EVENT_SELECT =
  "SELECT id, agent_id AS agentId, repository_id AS repositoryId, actor_user_id AS actorUserId, event, payload, created_at AS createdAt, next_attempt_at AS nextAttemptAt, attempts, delivery_id AS deliveryId, status, lease_until AS leaseUntil, error_code AS errorCode FROM auth_agent_events";

function decodeKey(value: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!value) return null;
  try {
    const bytes = base64ToBytes(value);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
async function encryptionKey(env: AgentWebhookEnv): Promise<CryptoKey> {
  const bytes = decodeKey(env.WEBHOOK_ENCRYPTION_KEY);
  if (!bytes) throw new Error("webhook_encryption_unavailable");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptSecret(
  env: AgentWebhookEnv,
  secret: string
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(secret)
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}
async function decryptSecret(env: AgentWebhookEnv, row: SettingsRow): Promise<string> {
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(row.secretIv),
    },
    await encryptionKey(env),
    base64ToBytes(row.secretCiphertext)
  );
  return new TextDecoder().decode(bytes);
}
function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443")
    )
      return false;
    if (
      !host.includes(".") ||
      host === "localhost" ||
      PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    )
      return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return false;
    if (host === "0.0.0.0" || host === "metadata.google.internal") return false;
    return true;
  } catch {
    return false;
  }
}
function parseEvents(value: string): AgentWebhookEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid_webhook_events");
  }
  const events = z.array(z.enum(ALLOWED_EVENTS)).safeParse(parsed);
  if (!events.success) throw new Error("invalid_webhook_events");
  return events.data;
}
function parsePayload(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid_webhook_payload");
  }
  const payload = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!payload.success) throw new Error("invalid_webhook_payload");
  return payload.data;
}
function publicSettings(
  row: SettingsRow | null
): (AgentWebhookSettings & { configured: true; updatedAt: number }) | null {
  if (!row) return null;
  return {
    url: row.url,
    events: parseEvents(row.eventsJson),
    enabled: row.enabled === 1,
    configured: true,
    updatedAt: row.updatedAt,
  };
}
async function loadSettings(env: AgentWebhookEnv, agentId: string): Promise<SettingsRow | null> {
  return env.DB.prepare(`${SETTINGS_SELECT} WHERE agent_id = ?`).bind(agentId).first<SettingsRow>();
}
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return bytesToHex(new Uint8Array(bytes));
}
async function limitedText(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  let completed = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        completed = true;
        return;
      }
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("response_too_large");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // A failed stream may reject cancellation; release its lock regardless.
      }
    }
    reader.releaseLock();
  }
}
async function deliver(
  env: AgentWebhookEnv,
  agentId: string,
  event: AgentWebhookEvent,
  payload: Record<string, unknown>,
  requestedDeliveryId?: string,
  requestedCreatedAt?: number,
  claimMode: DeliveryClaimMode = "initial"
): Promise<DeliveryRow> {
  const row = await loadSettings(env, agentId);
  if (!row || row.enabled !== 1 || !parseEvents(row.eventsJson).includes(event))
    throw new Error("webhook_not_enabled");
  const secret = await decryptSecret(env, row);
  const id = requestedDeliveryId ?? crypto.randomUUID();
  const previous = await env.DB.prepare(
    "SELECT attempt_count AS attemptCount, created_at AS createdAt FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ?"
  )
    .bind(id, agentId)
    .first<DeliveryAttemptRow>();
  const now = Date.now();
  const createdAt = previous?.createdAt ?? requestedCreatedAt ?? now;
  const body = JSON.stringify({ id, event, createdAt, data: payload });
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    throw new Error("payload_too_large");
  const serialized = JSON.stringify(payload);
  const claim = await env.DB.prepare(
    "INSERT INTO auth_agent_webhook_deliveries (id, agent_id, event, payload, status, response_status, error_code, attempt_count, created_at, delivered_at) VALUES (?, ?, ?, ?, 'pending', NULL, 'delivery_pending', 1, ?, NULL) ON CONFLICT(id) DO UPDATE SET status = 'pending', response_status = NULL, error_code = 'delivery_pending', attempt_count = auth_agent_webhook_deliveries.attempt_count + 1, delivered_at = NULL WHERE auth_agent_webhook_deliveries.agent_id = excluded.agent_id AND auth_agent_webhook_deliveries.attempt_count < ? AND (auth_agent_webhook_deliveries.status = 'failed' OR (? = 1 AND auth_agent_webhook_deliveries.status = 'pending'))"
  )
    .bind(
      id,
      agentId,
      event,
      serialized,
      createdAt,
      MAX_DELIVERY_ATTEMPTS,
      Number(claimMode === "outbox")
    )
    .run();
  if (claim.meta.changes !== 1) throw new DeliveryClaimConflict("delivery_claim_conflict");
  const attempt = await env.DB.prepare(
    "SELECT attempt_count AS attemptCount FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ? AND status = 'pending'"
  )
    .bind(id, agentId)
    .first<{ attemptCount: number }>();
  if (!attempt) throw new Error("delivery_already_final");
  let responseStatus: number | null = null;
  let errorCode: string | null = null;
  let deliveredAt: number | null = null;
  try {
    const result = await fetch(row.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "GitEdge-Delivery": id,
        "GitEdge-Event": event,
        "X-GitEdge-Signature-256": `sha256=${await sign(secret, body)}`,
      },
      body,
    });
    responseStatus = result.status;
    await limitedText(result);
    if (result.status >= 200 && result.status < 300) deliveredAt = Date.now();
    else
      errorCode = result.status >= 300 && result.status < 400 ? "redirect_rejected" : "http_error";
  } catch (error) {
    errorCode =
      error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
        ? "timeout"
        : error instanceof Error && error.message === "response_too_large"
          ? "response_too_large"
          : "network_error";
  }
  const status = deliveredAt ? "success" : "failed";
  await env.DB.prepare(
    "UPDATE auth_agent_webhook_deliveries SET status = ?, response_status = ?, error_code = ?, delivered_at = ? WHERE id = ? AND agent_id = ? AND status = 'pending'"
  )
    .bind(status, responseStatus, errorCode, deliveredAt, id, agentId)
    .run();
  await env.DB.prepare(
    "DELETE FROM auth_agent_webhook_deliveries WHERE agent_id = ? AND status != 'pending' AND id NOT IN (SELECT id FROM auth_agent_webhook_deliveries WHERE agent_id = ? AND status != 'pending' ORDER BY created_at DESC LIMIT 100)"
  )
    .bind(agentId, agentId)
    .run();
  return {
    id,
    event,
    status,
    responseStatus,
    errorCode,
    attemptCount: attempt.attemptCount,
    createdAt,
    deliveredAt,
  };
}

async function loadDelivery(
  env: AgentWebhookEnv,
  deliveryId: string,
  agentId: string
): Promise<StoredDeliveryRow | null> {
  return env.DB.prepare(
    "SELECT id, event, status, response_status AS responseStatus, error_code AS errorCode, attempt_count AS attemptCount, created_at AS createdAt, delivered_at AS deliveredAt FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ?"
  )
    .bind(deliveryId, agentId)
    .first<StoredDeliveryRow>();
}

async function loadOutboxEvent(
  env: AgentWebhookEnv,
  deliveryId: string
): Promise<AgentEventRow | null> {
  return env.DB.prepare(EVENT_SELECT + " WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<AgentEventRow>();
}

async function claimOutboxEvent(
  env: AgentWebhookEnv,
  event: AgentEventRow,
  now: number,
  allowEarly = false
): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE auth_agent_events SET status = 'processing', lease_until = ?, attempts = attempts + 1 WHERE id = ? AND attempts < ? AND ((status = 'pending' AND (? = 1 OR next_attempt_at <= ?)) OR (status = 'processing' AND lease_until <= ?))"
  )
    .bind(now + OUTBOX_LEASE_MS, event.id, MAX_DELIVERY_ATTEMPTS, Number(allowEarly), now, now)
    .run();
  return result.meta.changes === 1;
}

async function markOutbox(
  env: AgentWebhookEnv,
  event: AgentEventRow,
  status: AgentEventRow["status"],
  errorCode: string | null
): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_agent_events SET status = ?, lease_until = NULL, error_code = ? WHERE id = ? AND status = 'processing'"
  )
    .bind(status, errorCode, event.id)
    .run();
}

async function markDeliveryInvalid(
  env: AgentWebhookEnv,
  event: AgentEventRow,
  errorCode: string
): Promise<void> {
  await env.DB.prepare(
    "UPDATE auth_agent_webhook_deliveries SET status = 'failed', error_code = ?, response_status = NULL, delivered_at = NULL WHERE id = ? AND status IN ('pending', 'failed')"
  )
    .bind(errorCode, event.deliveryId)
    .run();
}

function retryDelay(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

async function rescheduleOutbox(
  env: AgentWebhookEnv,
  event: AgentEventRow,
  attempts: number,
  now: number,
  errorCode: string
): Promise<void> {
  const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
  await env.DB.prepare(
    "UPDATE auth_agent_events SET status = ?, lease_until = NULL, error_code = ?, next_attempt_at = ? WHERE id = ? AND status = 'processing'"
  )
    .bind(exhausted ? "dead" : "pending", errorCode, now + retryDelay(attempts), event.id)
    .run();
}

async function eventIsAuthorized(env: AgentWebhookEnv, event: AgentEventRow): Promise<boolean> {
  const agent = await env.DB.prepare(
    "SELECT a.user_id AS ownerId, a.disabled_at AS disabledAt, r.agents_enabled AS agentsEnabled FROM auth_agents a JOIN repositories r ON r.id = ? WHERE a.id = ?"
  )
    .bind(event.repositoryId, event.agentId)
    .first<{ ownerId: string; disabledAt: number | null; agentsEnabled: number }>();
  if (!agent || agent.disabledAt !== null || agent.agentsEnabled !== 1) return false;
  const actorRole = await repositoryRole(env.DB, event.repositoryId, event.actorUserId);
  if (!writableRole(actorRole)) return false;
  const ownerRole = await repositoryRole(env.DB, event.repositoryId, agent.ownerId);
  if (!writableRole(ownerRole)) return false;
  const settings = await loadSettings(env, event.agentId);
  return Boolean(
    settings && settings.enabled === 1 && parseEvents(settings.eventsJson).includes(event.event)
  );
}

async function deliverClaimedEvent(
  env: AgentWebhookEnv,
  event: AgentEventRow,
  now = Date.now()
): Promise<DeliveryRow | null> {
  const existing = await loadDelivery(env, event.deliveryId, event.agentId);
  if (existing?.status === "success") {
    await markOutbox(env, event, "delivered", null);
    return { ...existing, status: "success" };
  }
  if (!(await eventIsAuthorized(env, event))) {
    await markDeliveryInvalid(env, event, "event_scope_lost");
    await markOutbox(env, event, "dropped", "event_scope_lost");
    return null;
  }
  const payload = parsePayload(event.payload);
  try {
    const delivery = await deliver(
      env,
      event.agentId,
      event.event,
      payload,
      event.deliveryId,
      event.createdAt,
      "outbox"
    );
    if (delivery.status === "success") await markOutbox(env, event, "delivered", null);
    else
      await rescheduleOutbox(env, event, event.attempts, now, delivery.errorCode ?? "http_error");
    return delivery;
  } catch (error) {
    if (error instanceof Error && error.message === "webhook_not_enabled") {
      await markDeliveryInvalid(env, event, "event_scope_lost");
      await markOutbox(env, event, "dropped", "event_scope_lost");
      return null;
    }
    throw error;
  }
}

export async function drainAgentEventOutbox(
  env: AgentWebhookEnv,
  now = Date.now()
): Promise<number> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-webhook" });
  await env.DB.prepare(
    "DELETE FROM auth_agent_events WHERE id IN (SELECT id FROM auth_agent_events WHERE status IN ('delivered', 'dropped', 'dead') AND created_at < ? LIMIT 100)"
  )
    .bind(now - 30 * 86_400_000)
    .run();
  const events = await env.DB.prepare(
    EVENT_SELECT +
      " WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?) ORDER BY next_attempt_at, created_at LIMIT ?"
  )
    .bind(now, now, MAX_OUTBOX_EVENTS_PER_RUN)
    .all<AgentEventRow>();
  let processed = 0;
  for (const event of events.results) {
    if (event.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await markOutbox(env, event, "dead", "attempt_limit");
      await markDeliveryInvalid(env, event, "attempt_limit");
      processed += 1;
      continue;
    }
    if (!(await claimOutboxEvent(env, event, now))) continue;
    processed += 1;
    const claimed = { ...event, attempts: event.attempts + 1 };
    try {
      await deliverClaimedEvent(env, claimed, now);
    } catch (error) {
      logger.error("agent-webhook:outbox-delivery-failed", {
        agentId: event.agentId,
        event: event.event,
        deliveryId: event.deliveryId,
        errorCode:
          error instanceof Error && error.message === "webhook_encryption_unavailable"
            ? "webhook_encryption_unavailable"
            : "delivery_error",
      });
      await rescheduleOutbox(env, claimed, claimed.attempts, now, "delivery_error");
    }
  }
  return processed;
}

export async function handleAgentWebhookManagement(
  request: Request,
  env: AgentWebhookEnv,
  user: TrustedUser,
  agentId: string
): Promise<Response | null> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts[2] !== "webhook") return null;
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-webhook" });
  try {
    const row = await loadSettings(env, agentId);
    if (parts.length === 3 && request.method === "GET") return response(publicSettings(row));
    if (parts.length === 3 && request.method === "PUT") {
      const raw = await readJsonLimited(request, SMALL_JSON_BYTES);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return failure(400, "bad_request", "Invalid webhook settings.");
      const input = z.record(z.string(), z.unknown()).safeParse(raw);
      if (!input.success) return failure(400, "bad_request", "Invalid webhook settings.");
      const value = input.data;
      const parsed = AgentWebhookSettingsSchema.safeParse({
        url: value.url,
        events: value.events,
        enabled: value.enabled,
      });
      if (!parsed.success || !validWebhookUrl(parsed.data.url))
        return failure(400, "bad_request", "Webhook URL or settings are invalid.");
      if (!decodeKey(env.WEBHOOK_ENCRYPTION_KEY))
        return failure(503, "service_unavailable", "Webhook encryption is not configured.");
      if (row && value.rotateSecret !== true) {
        await env.DB.prepare(
          "UPDATE auth_agent_webhooks SET url = ?, events_json = ?, enabled = ?, updated_at = ? WHERE agent_id = ?"
        )
          .bind(
            parsed.data.url,
            JSON.stringify([...new Set(parsed.data.events)]),
            Number(parsed.data.enabled),
            Date.now(),
            agentId
          )
          .run();
        return response({ ...parsed.data, configured: true, secret: null });
      }
      const secret = `ge_webhook_${randomHex(32)}`;
      const encrypted = await encryptSecret(env, secret);
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO auth_agent_webhooks (agent_id, url, events_json, enabled, secret_ciphertext, secret_iv, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET url = excluded.url, events_json = excluded.events_json, enabled = excluded.enabled, secret_ciphertext = excluded.secret_ciphertext, secret_iv = excluded.secret_iv, updated_at = excluded.updated_at"
      )
        .bind(
          agentId,
          parsed.data.url,
          JSON.stringify([...new Set(parsed.data.events)]),
          Number(parsed.data.enabled),
          encrypted.ciphertext,
          encrypted.iv,
          now
        )
        .run();
      return response({ ...parsed.data, configured: true, secret }, row ? 200 : 201);
    }
    if (parts.length === 4 && parts[3] === "test" && request.method === "POST") {
      if (!row || row.enabled !== 1)
        return failure(409, "conflict", "An enabled webhook is required.");
      const events = parseEvents(row.eventsJson);
      const event = events[0];
      if (!event) return failure(409, "conflict", "At least one webhook event is required.");
      const delivery = await deliver(env, agentId, event, { test: true, agentId });
      return response(delivery, delivery.status === "success" ? 200 : 502);
    }
    if (parts.length === 4 && parts[3] === "deliveries" && request.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id, event, status, response_status AS responseStatus, error_code AS errorCode, attempt_count AS attemptCount, created_at AS createdAt, delivered_at AS deliveredAt FROM auth_agent_webhook_deliveries WHERE agent_id = ? AND status != 'pending' ORDER BY created_at DESC LIMIT 100"
      )
        .bind(agentId)
        .all<DeliveryRow>();
      return response(rows.results);
    }
    if (
      parts.length === 6 &&
      parts[3] === "deliveries" &&
      parts[5] === "retry" &&
      request.method === "POST"
    ) {
      const failed = await env.DB.prepare(
        "SELECT id, event, payload, status, attempt_count AS attemptCount FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ?"
      )
        .bind(parts[4], agentId)
        .first<{
          id: string;
          event: AgentWebhookEvent;
          payload: string;
          status: StoredDeliveryRow["status"];
          attemptCount: number;
        }>();
      if (!failed) return failure(404, "not_found", "Delivery was not found.");
      if (failed.status !== "failed")
        return failure(409, "conflict", "Delivery is already claimed or has already succeeded.");
      if (failed.attemptCount >= MAX_DELIVERY_ATTEMPTS)
        return failure(409, "conflict", "Delivery retry limit reached.");
      const queuedEvent = await loadOutboxEvent(env, failed.id);
      if (queuedEvent) {
        if (queuedEvent.attempts >= MAX_DELIVERY_ATTEMPTS)
          return failure(409, "conflict", "Delivery retry limit reached.");
        const now = Date.now();
        if (!(await claimOutboxEvent(env, queuedEvent, now, true)))
          return failure(409, "conflict", "Delivery is already being retried.");
        const claimed = { ...queuedEvent, attempts: queuedEvent.attempts + 1 };
        try {
          const delivery = await deliverClaimedEvent(env, claimed, now);
          return delivery
            ? response(delivery, delivery.status === "success" ? 200 : 502)
            : failure(409, "conflict", "Delivery was discarded because repository access changed.");
        } catch (error) {
          if (error instanceof DeliveryClaimConflict) {
            await markOutbox(env, claimed, "dead", "attempt_limit");
            return failure(
              409,
              "conflict",
              "Delivery is already claimed or has reached its retry limit."
            );
          }
          await rescheduleOutbox(env, claimed, claimed.attempts, now, "delivery_error");
          return failure(502, "service_unavailable", "Webhook delivery failed.");
        }
      }
      const payload = parsePayload(failed.payload);
      const delivery = await deliver(
        env,
        agentId,
        failed.event,
        payload,
        failed.id,
        undefined,
        "manual-retry"
      );
      return response(delivery, delivery.status === "success" ? 200 : 502);
    }
    return failure(405, "method_not_allowed", "Method is not allowed.");
  } catch (error) {
    if (error instanceof DeliveryClaimConflict)
      return failure(
        409,
        "conflict",
        "Delivery is already claimed or has reached its retry limit."
      );
    logger.error("agent-webhook:operation-failed", {
      userId: user.id,
      agentId,
      route: parts.slice(2).join("/"),
    });
    return error instanceof Error && error.message === "webhook_encryption_unavailable"
      ? failure(503, "service_unavailable", "Webhook encryption is not configured.")
      : failure(503, "service_unavailable", "Webhook operation failed.");
  }
}

const AgentEventInputSchema = z.object({
  agentId: z.string().min(1),
  repositoryId: z.string().min(1),
  actorUserId: z.string().min(1),
  event: z.enum(ALLOWED_EVENTS),
  data: z.record(z.string(), z.unknown()),
});
export type AgentEventQueueResult = "queued" | "ignored" | "invalid" | "full";
export async function handleAgentEvent(
  request: Request,
  env: AgentWebhookEnv
): Promise<AgentEventQueueResult> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-webhook" });
  let agentId = "unknown";
  let repositoryId = "unknown";
  let eventName = "unknown";
  try {
    if (request.method !== "POST" || new URL(request.url).hostname !== "auth.internal")
      return "invalid";
    const raw = await readJsonLimited(request, SMALL_JSON_BYTES);
    const parsed = AgentEventInputSchema.safeParse(raw);
    if (!parsed.success) return "invalid";
    const input = parsed.data;
    agentId = input.agentId;
    repositoryId = input.repositoryId;
    eventName = input.event;
    const event = input.event;
    const row = await loadSettings(env, input.agentId);
    if (!row || row.enabled !== 1 || !parseEvents(row.eventsJson).includes(event)) return "ignored";
    const payload = { ...input.data, repositoryId: input.repositoryId, agentId: input.agentId };
    const serialized = JSON.stringify(payload);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) return "invalid";
    const now = Date.now();
    const id = crypto.randomUUID();
    const queued = await env.DB.prepare(
      "INSERT INTO auth_agent_events (id, agent_id, repository_id, actor_user_id, event, payload, created_at, next_attempt_at, attempts, delivery_id, status) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending' WHERE (SELECT COUNT(*) FROM auth_agent_events WHERE agent_id = ? AND status IN ('pending', 'processing')) < ?"
    )
      .bind(
        id,
        input.agentId,
        input.repositoryId,
        input.actorUserId,
        event,
        serialized,
        now,
        now,
        id,
        input.agentId,
        MAX_PENDING_EVENTS_PER_AGENT
      )
      .run();
    if (queued.meta.changes !== 1) {
      logger.warn("agent-webhook:outbox-limit-reached", {
        agentId,
        repositoryId,
        event: eventName,
      });
      return "full";
    }
    logger.info("agent-webhook:event-queued", {
      agentId,
      repositoryId,
      event: eventName,
      deliveryId: id,
    });
    return "queued";
  } catch {
    logger.error("agent-webhook:event-failed", { agentId, repositoryId, event: eventName });
    throw new Error("agent_event_queue_failed");
  }
}
