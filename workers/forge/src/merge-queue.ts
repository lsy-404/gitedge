import { DurableObject } from "cloudflare:workers";
import {
  MERGE_QUEUE_LEASE_MS,
  MERGE_QUEUE_LIMIT,
  MERGE_QUEUE_MAX_ATTEMPTS,
  type MergeMethod,
} from "../../../packages/contracts/src/index";

export interface QueueEntryInput {
  readonly pullRequestId: string;
  readonly pullRequestNumber: number;
  readonly userId: string;
  readonly method: MergeMethod;
  readonly expectedHeadOid: string;
}

export interface QueueEntry extends QueueEntryInput {
  readonly enqueuedAt: number;
  readonly processing: boolean;
  readonly attempts: number;
}

export type EnqueueResult =
  | { readonly status: "queued"; readonly position: number; readonly created: boolean }
  | { readonly status: "full" };
export type RemoveResult = { readonly status: "removed" | "absent" | "busy" };
export type ClaimResult =
  | { readonly status: "empty" }
  | { readonly status: "busy" }
  | { readonly status: "claimed"; readonly entry: QueueEntry; readonly token: string };
export type FinishResult = { readonly status: "done" | "stale" };
export type RetryResult = { readonly status: "requeued" | "exhausted" | "stale" };

interface EntryRow extends Record<string, SqlStorageValue> {
  seq: number;
  pull_request_id: string;
  pull_request_number: number;
  user_id: string;
  method: MergeMethod;
  expected_head_oid: string;
  enqueued_at: number;
  lease_token: string | null;
  lease_until: number;
  attempts: number;
}

function leaseLive(row: Pick<EntryRow, "lease_token" | "lease_until">, now: number): boolean {
  return row.lease_token !== null && row.lease_until > now;
}

function toEntry(row: EntryRow, now: number): QueueEntry {
  return {
    pullRequestId: row.pull_request_id,
    pullRequestNumber: row.pull_request_number,
    userId: row.user_id,
    method: row.method,
    expectedHeadOid: row.expected_head_oid,
    enqueuedAt: row.enqueued_at,
    processing: leaseLive(row, now),
    attempts: row.attempts,
  };
}

/**
 * FIFO merge queue of one (repository, target branch). It holds ordering and a processing lease in
 * its own SQLite storage and never calls other services; the Worker claims the head entry, performs
 * the merge through Forge and Git, and reports the result back.
 */
export class MergeQueueDurableObject extends DurableObject<Record<string, never>> {
  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, pull_request_id TEXT NOT NULL UNIQUE, pull_request_number INTEGER NOT NULL, user_id TEXT NOT NULL, method TEXT NOT NULL, expected_head_oid TEXT NOT NULL, enqueued_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0)"
    );
  }

  private rows(): EntryRow[] {
    return this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY seq ASC LIMIT ?", MERGE_QUEUE_LIMIT)
      .toArray();
  }

  enqueue(input: QueueEntryInput, now = Date.now()): EnqueueResult {
    const rows = this.rows();
    const existing = rows.findIndex((row) => row.pull_request_id === input.pullRequestId);
    if (existing >= 0) return { status: "queued", position: existing + 1, created: false };
    if (rows.length >= MERGE_QUEUE_LIMIT) return { status: "full" };
    this.ctx.storage.sql.exec(
      "INSERT INTO entries (pull_request_id, pull_request_number, user_id, method, expected_head_oid, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)",
      input.pullRequestId,
      input.pullRequestNumber,
      input.userId,
      input.method,
      input.expectedHeadOid,
      now
    );
    return { status: "queued", position: rows.length + 1, created: true };
  }

  list(now = Date.now()): QueueEntry[] {
    return this.rows().map((row) => toEntry(row, now));
  }

  remove(pullRequestId: string, now = Date.now()): RemoveResult {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries WHERE pull_request_id = ?", pullRequestId)
      .toArray()[0];
    if (!row) return { status: "absent" };
    if (leaseLive(row, now)) return { status: "busy" };
    this.ctx.storage.sql.exec("DELETE FROM entries WHERE pull_request_id = ?", pullRequestId);
    return { status: "removed" };
  }

  /** Leases the head entry; later entries never overtake it. */
  claim(now = Date.now()): ClaimResult {
    const row = this.ctx.storage.sql
      .exec<EntryRow>("SELECT * FROM entries ORDER BY seq ASC LIMIT 1")
      .toArray()[0];
    if (!row) return { status: "empty" };
    if (leaseLive(row, now)) return { status: "busy" };
    const token = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "UPDATE entries SET lease_token = ?, lease_until = ? WHERE seq = ?",
      token,
      now + MERGE_QUEUE_LEASE_MS,
      row.seq
    );
    return {
      status: "claimed",
      entry: toEntry({ ...row, lease_token: token, lease_until: now + MERGE_QUEUE_LEASE_MS }, now),
      token,
    };
  }

  finish(pullRequestId: string, token: string): FinishResult {
    const deleted = this.ctx.storage.sql.exec(
      "DELETE FROM entries WHERE pull_request_id = ? AND lease_token = ?",
      pullRequestId,
      token
    );
    deleted.toArray();
    return { status: deleted.rowsWritten > 0 ? "done" : "stale" };
  }

  /** Returns a leased entry to the queue head position for another attempt, or drops it once attempts run out. */
  retry(pullRequestId: string, token: string): RetryResult {
    const row = this.ctx.storage.sql
      .exec<EntryRow>(
        "SELECT * FROM entries WHERE pull_request_id = ? AND lease_token = ?",
        pullRequestId,
        token
      )
      .toArray()[0];
    if (!row) return { status: "stale" };
    if (row.attempts + 1 >= MERGE_QUEUE_MAX_ATTEMPTS) {
      this.ctx.storage.sql.exec("DELETE FROM entries WHERE seq = ?", row.seq);
      return { status: "exhausted" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE entries SET lease_token = NULL, lease_until = 0, attempts = attempts + 1 WHERE seq = ?",
      row.seq
    );
    return { status: "requeued" };
  }
}
