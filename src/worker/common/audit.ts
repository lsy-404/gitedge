import {
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_PAGE_SIZE,
  type AuditAction,
  type AuditActorKind,
  type AuditEvent,
  type AuditMetadata,
  type AuditMetadataValue,
  type AuditPage,
} from "../../../packages/contracts/src/audit";
import type { TrustedUser } from "../../../packages/contracts/src/index";
import { createLogger } from "./logger";

export interface AuditActor {
  kind: AuditActorKind;
  id: string | null;
  name: string;
  ref: string | null;
}

export interface AuditInput {
  action: AuditAction;
  actor: AuditActor;
  target: { type: string; id?: string | null; label?: string | null };
  repositoryId?: string | null;
  namespaceId?: string | null;
  /** The account whose security log shows this event. */
  subjectUserId?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

const MAX_STRING = 200;
const MAX_ARRAY = 20;
const MAX_METADATA_BYTES = 2000;
const SECRET_KEY =
  /secret|password|passphrase|hash|credential|cookie|authorization|plaintext|private/i;
const SECRET_KEY_EXACT = new Set(["token", "accesstoken", "code", "recoverycodes", "otp"]);
const SECRET_VALUE = /(?:gep_|gei_|ge_token_|ge_session_|ge_webhook_)[0-9a-f]{16,}/;

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  return SECRET_VALUE.test(value) ? "[redacted]" : value.slice(0, MAX_STRING);
}

/** Keeps only bounded scalar metadata and drops anything that looks like a credential. */
export function sanitizeAuditMetadata(metadata: Readonly<Record<string, unknown>>): AuditMetadata {
  const clean: Record<string, AuditMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SECRET_KEY.test(key) || SECRET_KEY_EXACT.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      clean[key] = value
        .slice(0, MAX_ARRAY)
        .map(scalar)
        .filter((item): item is string | number | boolean => item !== undefined && item !== null);
      continue;
    }
    const single = scalar(value);
    if (single !== undefined) clean[key] = single;
  }
  return JSON.stringify(clean).length > MAX_METADATA_BYTES ? { truncated: true } : clean;
}

export function auditActor(user: TrustedUser): AuditActor {
  if (user.agentSession)
    return {
      kind: "agent",
      id: user.agentSession.agentId,
      name: user.agentSession.agentName,
      ref: user.agentSession.id,
    };
  if (user.token) return { kind: "token", id: user.id, name: user.identifier, ref: user.token.id };
  return { kind: "user", id: user.id, name: user.identifier, ref: null };
}

export function auditStatement(
  db: D1Database,
  input: AuditInput,
  now = Date.now()
): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO audit_events (id, actor_kind, actor_id, actor_name, actor_ref, action, target_type, target_id, target_label, repository_id, namespace_id, subject_user_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      crypto.randomUUID(),
      input.actor.kind,
      input.actor.id,
      input.actor.name,
      input.actor.ref,
      input.action,
      input.target.type,
      input.target.id ?? null,
      input.target.label ?? null,
      input.repositoryId ?? null,
      input.namespaceId ?? null,
      input.subjectUserId ?? null,
      JSON.stringify(sanitizeAuditMetadata(input.metadata ?? {})),
      now
    );
}

/** Appends one event after a committed change; a failed append is logged and never fails the request. */
export async function recordAudit(
  env: { DB: D1Database; LOG_LEVEL?: string },
  input: AuditInput
): Promise<void> {
  try {
    await auditStatement(env.DB, input).run();
  } catch (cause) {
    createLogger(env.LOG_LEVEL, { service: "audit" }).error("audit:append-failed", {
      action: input.action,
      error: cause instanceof Error ? cause.message : "unknown",
    });
  }
}

export type AuditScope = "repository_id" | "namespace_id" | "subject_user_id";

interface AuditRow {
  id: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  actorName: string;
  actorRef: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  repositoryId: string | null;
  metadataJson: string;
  createdAt: number;
}

const CURSOR_PATTERN = /^(\d{1,16})\.([0-9a-f-]{36})$/;

function parseMetadata(json: string): AuditMetadata {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return sanitizeAuditMetadata(Object.fromEntries(Object.entries(parsed)));
  } catch {
    return {};
  }
}

export function auditPageSize(value: string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, AUDIT_MAX_PAGE_SIZE)
    : AUDIT_PAGE_SIZE;
}

/** Newest-first keyset page; returns null for a malformed cursor. */
export async function readAuditPage(
  db: D1Database,
  scope: AuditScope,
  value: string,
  cursor: string | null,
  limit: number
): Promise<AuditPage | null> {
  const match = cursor === null ? null : CURSOR_PATTERN.exec(cursor);
  if (cursor !== null && !match) return null;
  const rows = await db
    .prepare(
      `SELECT id, actor_kind AS actorKind, actor_id AS actorId, actor_name AS actorName, actor_ref AS actorRef, action, target_type AS targetType, target_id AS targetId, target_label AS targetLabel, repository_id AS repositoryId, metadata_json AS metadataJson, created_at AS createdAt FROM audit_events WHERE ${scope} = ?1 AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3)) ORDER BY created_at DESC, id DESC LIMIT ?4`
    )
    .bind(value, match ? Number(match[1]) : null, match?.[2] ?? "", limit + 1)
    .all<AuditRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const events: AuditEvent[] = page.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    actor: { kind: row.actorKind, id: row.actorId, name: row.actorName, ref: row.actorRef },
    target: { type: row.targetType, id: row.targetId, label: row.targetLabel },
    repositoryId: row.repositoryId,
    metadata: parseMetadata(row.metadataJson),
  }));
  return {
    events,
    nextCursor: rows.results.length > limit && last ? `${last.createdAt}.${last.id}` : null,
  };
}
