import {
  AgentWebhookSettingsSchema,
  type AgentWebhookEvent,
  type AgentWebhookSettings,
  type TrustedUser,
} from "../../../packages/contracts/src/index";
import { createLogger } from "../../../src/worker/common/logger";
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

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const ALLOWED_EVENTS = ["agent.assigned", "agent.mentioned", "pull_request.updated"] as const;
const SETTINGS_SELECT =
  "SELECT agent_id AS agentId, url, events_json AS eventsJson, enabled, secret_ciphertext AS secretCiphertext, secret_iv AS secretIv, updated_at AS updatedAt FROM auth_agent_webhooks";

function response(data: unknown, status = 200): Response {
  return Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
function decodeKey(value: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!value) return null;
  try {
    const binary = atob(value);
    if (binary.length !== 32) return null;
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
  return { ciphertext: base64(new Uint8Array(encrypted)), iv: base64(iv) };
}
async function decryptSecret(env: AgentWebhookEnv, row: SettingsRow): Promise<string> {
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(atob(row.secretIv), (character) => character.charCodeAt(0)),
    },
    await encryptionKey(env),
    Uint8Array.from(atob(row.secretCiphertext), (character) => character.charCodeAt(0))
  );
  return new TextDecoder().decode(bytes);
}
function validWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      host.endsWith(".test") ||
      host.endsWith(".home") ||
      host.endsWith(".lan") ||
      host.endsWith(".intranet") ||
      host.endsWith(".corp")
    )
      return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return false;
    if (host === "0.0.0.0" || host === "metadata.google.internal") return false;
    return true;
  } catch {
    return false;
  }
}
async function readLimitedJson(request: Request): Promise<unknown | null> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed;
  } catch {
    return null;
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
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function limitedText(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) return;
    bytes += part.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
  }
}
async function deliver(
  env: AgentWebhookEnv,
  agentId: string,
  event: AgentWebhookEvent,
  payload: Record<string, unknown>,
  existingDeliveryId?: string
): Promise<DeliveryRow> {
  const row = await loadSettings(env, agentId);
  if (!row || row.enabled !== 1 || !parseEvents(row.eventsJson).includes(event))
    throw new Error("webhook_not_enabled");
  const secret = await decryptSecret(env, row);
  const id = existingDeliveryId ?? crypto.randomUUID();
  const body = JSON.stringify({ id, event, createdAt: Date.now(), data: payload });
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES)
    throw new Error("payload_too_large");
  let responseStatus: number | null = null;
  let errorCode: string | null = null;
  let deliveredAt: number | null = null;
  let attemptCount = 1;
  if (existingDeliveryId) {
    const existing = await env.DB.prepare(
      "SELECT attempt_count AS attemptCount FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ?"
    )
      .bind(existingDeliveryId, agentId)
      .first<{ attemptCount: number }>();
    attemptCount = (existing?.attemptCount ?? 1) + 1;
  }
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let result: Response;
    try {
      result = await fetch(row.url, {
        method: "POST",
        redirect: "manual",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "GitEdge-Delivery": id,
          "GitEdge-Event": event,
          "X-GitEdge-Signature-256": `sha256=${await sign(secret, body)}`,
        },
        body,
      });
    } finally {
      clearTimeout(timer);
    }
    responseStatus = result.status;
    await limitedText(result);
    if (result.status >= 200 && result.status < 300) deliveredAt = Date.now();
    else
      errorCode = result.status >= 300 && result.status < 400 ? "redirect_rejected" : "http_error";
  } catch (error) {
    errorCode =
      error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error && error.message === "response_too_large"
          ? "response_too_large"
          : "network_error";
  }
  const now = Date.now();
  const status = deliveredAt ? "success" : "failed";
  const serialized = JSON.stringify(payload);
  if (existingDeliveryId) {
    await env.DB.prepare(
      "UPDATE auth_agent_webhook_deliveries SET status = ?, response_status = ?, error_code = ?, attempt_count = ?, delivered_at = ? WHERE id = ? AND agent_id = ?"
    )
      .bind(
        status,
        responseStatus,
        errorCode,
        attemptCount,
        deliveredAt,
        existingDeliveryId,
        agentId
      )
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO auth_agent_webhook_deliveries (id, agent_id, event, payload, status, response_status, error_code, attempt_count, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        agentId,
        event,
        serialized,
        status,
        responseStatus,
        errorCode,
        attemptCount,
        now,
        deliveredAt
      )
      .run();
    await env.DB.prepare(
      "DELETE FROM auth_agent_webhook_deliveries WHERE agent_id = ? AND id NOT IN (SELECT id FROM auth_agent_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100)"
    )
      .bind(agentId, agentId)
      .run();
  }
  return {
    id,
    event,
    status,
    responseStatus,
    errorCode,
    attemptCount,
    createdAt: now,
    deliveredAt,
  };
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
      const raw = await readLimitedJson(request);
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
      const secret = `ge_webhook_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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
        "SELECT id, event, status, response_status AS responseStatus, error_code AS errorCode, attempt_count AS attemptCount, created_at AS createdAt, delivered_at AS deliveredAt FROM auth_agent_webhook_deliveries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100"
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
        "SELECT id, event, payload, attempt_count AS attemptCount FROM auth_agent_webhook_deliveries WHERE id = ? AND agent_id = ? AND status = 'failed'"
      )
        .bind(parts[4], agentId)
        .first<{ id: string; event: AgentWebhookEvent; payload: string; attemptCount: number }>();
      if (!failed) return failure(404, "not_found", "Failed delivery was not found.");
      if (failed.attemptCount >= MAX_DELIVERY_ATTEMPTS)
        return failure(409, "conflict", "Delivery retry limit reached.");
      const payload = parsePayload(failed.payload);
      const delivery = await deliver(env, agentId, failed.event, payload, failed.id);
      return response(delivery, delivery.status === "success" ? 200 : 502);
    }
    return failure(405, "method_not_allowed", "Method is not allowed.");
  } catch (error) {
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
export async function handleAgentEvent(request: Request, env: AgentWebhookEnv): Promise<void> {
  const logger = createLogger(env.LOG_LEVEL, { service: "agent-webhook" });
  let agentId = "unknown";
  let repositoryId = "unknown";
  let eventName = "unknown";
  try {
    if (request.method !== "POST") return;
    const raw = await readLimitedJson(request);
    const parsed = AgentEventInputSchema.safeParse(raw);
    if (!parsed.success) return;
    const input = parsed.data;
    agentId = input.agentId;
    repositoryId = input.repositoryId;
    eventName = input.event;
    const event = input.event;
    if (!ALLOWED_EVENTS.includes(event)) return;
    const source = await env.DB.prepare(
      "SELECT a.user_id AS userId, a.disabled_at AS disabledAt FROM auth_agents a WHERE a.id = ?"
    )
      .bind(input.agentId)
      .first<{ userId: string; disabledAt: number | null }>();
    if (!source || source.disabledAt !== null) return;
    const membership = await env.DB.prepare(
      "SELECT 1 AS valid FROM repositories r JOIN namespace_memberships actor ON actor.namespace_id = r.namespace_id AND actor.user_id = ? JOIN namespace_memberships owner ON owner.namespace_id = r.namespace_id AND owner.user_id = ? WHERE r.id = ?"
    )
      .bind(input.actorUserId, source.userId, input.repositoryId)
      .first<{ valid: number }>();
    if (!membership) return;
    const row = await loadSettings(env, input.agentId);
    if (!row || row.enabled !== 1 || !parseEvents(row.eventsJson).includes(event)) return;
    const payload = { ...input.data, repositoryId: input.repositoryId, agentId: input.agentId };
    const delivery = await deliver(env, input.agentId, event, payload);
    if (delivery.status === "failed")
      logger.warn("agent-webhook:event-delivery-failed", {
        agentId: input.agentId,
        event,
        deliveryId: delivery.id,
        errorCode: delivery.errorCode,
      });
  } catch {
    logger.error("agent-webhook:event-failed", { agentId, repositoryId, event: eventName });
  }
}
